const { exec } = require("child_process");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const TEMP_DIR = path.resolve(process.cwd(), "temp");
let cachedCookieFile = null;
const YTDLP_BIN_CANDIDATES = [
  String(process.env.YTDLP_BIN || "").trim(),
  "/usr/local/bin/yt-dlp",
  "/usr/bin/yt-dlp",
  "yt-dlp",
].filter(Boolean);

function resolveYtDlpBinary() {
  for (const candidate of YTDLP_BIN_CANDIDATES) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (fsSync.existsSync(candidate)) return candidate;
      continue;
    }
    return candidate;
  }
  return "yt-dlp";
}

function quoteArg(value = "") {
  return JSON.stringify(String(value));
}

function isHttpUrl(value = "") {
  return /^https?:\/\//i.test(String(value).trim());
}

function sanitizeSongTitle(value = "") {
  const cleaned = String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "song";
}

async function ensureTempDir() {
  await fs.mkdir(TEMP_DIR, { recursive: true });
}

function runExec(command, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || "").trim() || "Command failed."));
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function resolveCookieArgs() {
  const cookieFile = String(process.env.YTDLP_COOKIE_FILE || process.env.YTDLP_COOKIES_PATH || "").trim();
  if (cookieFile && fsSync.existsSync(cookieFile)) {
    return ` --cookies ${quoteArg(cookieFile)}`;
  }

  const cookieB64 = String(process.env.YTDLP_COOKIES_B64 || "").trim();
  if (!cookieB64) return "";

  try {
    if (!cachedCookieFile) {
      if (!fsSync.existsSync(TEMP_DIR)) {
        fsSync.mkdirSync(TEMP_DIR, { recursive: true });
      }
      const decoded = Buffer.from(cookieB64, "base64").toString("utf8");
      const cookiePath = path.join(TEMP_DIR, "yt-dlp-cookies.txt");
      fsSync.writeFileSync(cookiePath, decoded, "utf8");
      cachedCookieFile = cookiePath;
    }
    return ` --cookies ${quoteArg(cachedCookieFile)}`;
  } catch {
    return "";
  }
}

function resolveProxyArgs() {
  const proxyUrl = String(process.env.YTDLP_PROXY_URL || "").trim();
  if (!proxyUrl) return "";
  return ` --proxy ${quoteArg(proxyUrl)}`;
}

async function searchYouTubeFirstVideoUrl(songName) {
  const query = String(songName || "").trim();
  if (!query) throw new Error("Missing song name.");

  const ytdlp = resolveYtDlpBinary();
  const command =
    `${quoteArg(ytdlp)} --no-warnings --no-playlist --print webpage_url ` +
    `${quoteArg(`ytsearch1:${query}`)}${resolveCookieArgs()}${resolveProxyArgs()}`;

  const { stdout } = await runExec(command, 90000);
  const url = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//i.test(line));
  if (!url) throw new Error("No YouTube result found for this query.");
  return url;
}

async function searchYouTubeCandidateUrls(songName, limit = 5) {
  const query = String(songName || "").trim();
  if (!query) throw new Error("Missing song name.");

  const count = Math.max(1, Math.min(10, Number(limit) || 5));
  const ytdlp = resolveYtDlpBinary();
  const command =
    `${quoteArg(ytdlp)} --no-warnings --no-playlist --flat-playlist --print webpage_url ` +
    `${quoteArg(`ytsearch${count}:${query}`)}${resolveCookieArgs()}${resolveProxyArgs()}`;

  const { stdout } = await runExec(command, 90000);
  const urls = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));

  return [...new Set(urls)];
}

function normalizeYtDlpError(error) {
  const raw = String(error?.message || "");
  if (raw.includes("Sign in to confirm you’re not a bot") || raw.includes("Sign in to confirm you're not a bot")) {
    return new Error("YouTube blocked this request. Configure YTDLP_COOKIE_FILE (and optionally YTDLP_PROXY_URL) then try again.");
  }
  if (raw.toLowerCase().includes("requested format is not available")) {
    return new Error("No compatible audio format found for this song. Try another song name.");
  }
  return error;
}

function buildSimpleDownloadCommand({ ytdlp, outputTemplate, targetUrl, formatSelector = "" }) {
  const formatPart = formatSelector ? ` --format ${quoteArg(formatSelector)}` : "";
  return (
    `${quoteArg(ytdlp)} -x --audio-format mp3 --audio-quality 0 --no-playlist ` +
    `${formatPart} --print title --print after_move:filepath ` +
    `-o ${quoteArg(outputTemplate)} ${quoteArg(targetUrl)}` +
    `${resolveCookieArgs()}${resolveProxyArgs()}`
  );
}

async function runDownloadWithFallback({ ytdlp, outputTemplate, targetUrl }) {
  const commands = [
    buildSimpleDownloadCommand({
      ytdlp,
      outputTemplate,
      targetUrl,
      formatSelector: "",
    }),
    buildSimpleDownloadCommand({
      ytdlp,
      outputTemplate,
      targetUrl,
      formatSelector: "bestaudio*/best",
    }),
    buildSimpleDownloadCommand({
      ytdlp,
      outputTemplate,
      targetUrl,
      formatSelector: "ba/b",
    }),
  ];

  let lastError = null;
  for (const command of commands) {
    try {
      return await runExec(command, 240000);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Download failed.");
}

async function downloadSongAsMp3(input) {
  await ensureTempDir();

  const rawInput = String(input || "").trim();
  if (!rawInput) {
    throw new Error("Missing song query.");
  }

  const ytdlp = resolveYtDlpBinary();
  const outputTemplate = path.join(TEMP_DIR, "%(id)s.%(ext)s");
  const candidateUrls = isHttpUrl(rawInput)
    ? [rawInput]
    : await searchYouTubeCandidateUrls(rawInput, 10);
  if (!candidateUrls.length) {
    throw new Error("No YouTube result found for this query.");
  }

  let stdout = "";
  let selectedUrl = "";
  let lastError = null;
  for (const targetUrl of candidateUrls) {
    try {
      const result = await runDownloadWithFallback({
        ytdlp,
        outputTemplate,
        targetUrl,
      });
      stdout = result.stdout;
      selectedUrl = targetUrl;
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!stdout) {
    throw normalizeYtDlpError(lastError || new Error("Failed to download song."));
  }

  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const filePathLine = lines[lines.length - 1];
  const titleLine = lines.length > 1 ? lines[lines.length - 2] : "song";
  if (!filePathLine) {
    throw new Error("Could not resolve downloaded file path.");
  }

  const absolutePath = path.resolve(filePathLine);
  if (!fsSync.existsSync(absolutePath)) {
    throw new Error("Downloaded MP3 file was not found.");
  }

  return {
    filePath: absolutePath,
    videoTitle: titleLine,
    sourceUrl: selectedUrl || candidateUrls[0],
  };
}

async function cleanupDownloadedFile(filePath) {
  if (!filePath) return;
  await fs.unlink(filePath).catch(() => {});
}

module.exports = {
  TEMP_DIR,
  sanitizeSongTitle,
  ensureTempDir,
  searchYouTubeCandidateUrls,
  searchYouTubeFirstVideoUrl,
  downloadSongAsMp3,
  cleanupDownloadedFile,
};
