const { spawn } = require("child_process");
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

function resolveCookieArgs() {
  const explicitCookieFile = String(process.env.YTDLP_COOKIE_FILE || process.env.YTDLP_COOKIES_PATH || "").trim();
  if (explicitCookieFile && fsSync.existsSync(explicitCookieFile)) {
    return ["--cookies", explicitCookieFile];
  }

  const projectCookieFile = path.resolve(process.cwd(), "cookies.txt");
  if (fsSync.existsSync(projectCookieFile)) {
    return ["--cookies", projectCookieFile];
  }

  const cookieB64 = String(process.env.YTDLP_COOKIES_B64 || "").trim();
  if (!cookieB64) return [];

  try {
    if (!cachedCookieFile) {
      if (!fsSync.existsSync(TEMP_DIR)) {
        fsSync.mkdirSync(TEMP_DIR, { recursive: true });
      }
      const cookiePath = path.join(TEMP_DIR, "yt-dlp-cookies.txt");
      const decoded = Buffer.from(cookieB64, "base64").toString("utf8");
      fsSync.writeFileSync(cookiePath, decoded, "utf8");
      cachedCookieFile = cookiePath;
    }
    return ["--cookies", cachedCookieFile];
  } catch {
    return [];
  }
}

function resolveProxyArgs() {
  const proxyUrl = String(process.env.YTDLP_PROXY_URL || "").trim();
  if (!proxyUrl) return [];
  return ["--proxy", proxyUrl];
}

function runYtDlp(args, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const ytdlpBin = resolveYtDlpBinary();
    const child = spawn(ytdlpBin, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start yt-dlp: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("yt-dlp timed out."));
        return;
      }
      if (code !== 0) {
        reject(new Error(String(stderr || stdout || `yt-dlp exited with code ${code}`).trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseDownloadResult(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const filePathLine = lines[lines.length - 1] || "";
  const titleLine = lines.length > 1 ? lines[lines.length - 2] : "song";

  if (!filePathLine) {
    throw new Error("Could not resolve downloaded file path.");
  }

  const absolutePath = path.resolve(filePathLine);
  if (!fsSync.existsSync(absolutePath)) {
    throw new Error("Downloaded MP3 file was not found.");
  }

  return { filePath: absolutePath, videoTitle: titleLine };
}

function buildDownloadArgs(target) {
  return [
    "--no-playlist",
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "--print",
    "title",
    "--print",
    "after_move:filepath",
    "-o",
    path.join(TEMP_DIR, "%(id)s.%(ext)s"),
    ...resolveCookieArgs(),
    ...resolveProxyArgs(),
    target,
  ];
}

async function searchYouTubeFirstVideoUrl(songName) {
  const query = String(songName || "").trim();
  if (!query) throw new Error("Missing song name.");

  const args = [
    "--no-warnings",
    "--no-playlist",
    "--print",
    "webpage_url",
    ...resolveCookieArgs(),
    ...resolveProxyArgs(),
    `ytsearch1:${query}`,
  ];
  const { stdout } = await runYtDlp(args, 90000);
  const url = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//i.test(line));
  if (!url) throw new Error("No YouTube result found for this query.");
  return url;
}

async function searchYouTubeCandidateUrls(songName, limit = 10) {
  const query = String(songName || "").trim();
  if (!query) throw new Error("Missing song name.");

  const count = Math.max(1, Math.min(10, Number(limit) || 10));
  const args = [
    "--no-warnings",
    "--no-playlist",
    "--flat-playlist",
    "--print",
    "webpage_url",
    ...resolveCookieArgs(),
    ...resolveProxyArgs(),
    `ytsearch${count}:${query}`,
  ];
  const { stdout } = await runYtDlp(args, 90000);
  const urls = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
  return [...new Set(urls)];
}

function normalizeYtDlpError(error) {
  const raw = String(error?.message || "");
  if (raw.toLowerCase().includes("requested format is not available")) {
    return new Error("No compatible audio format found for this song. Try another song name.");
  }
  if (raw.includes("Sign in to confirm you’re not a bot") || raw.includes("Sign in to confirm you're not a bot")) {
    return new Error("YouTube blocked this request. Configure cookies/proxy then try again.");
  }
  if (raw.toLowerCase().includes("failed to start yt-dlp")) {
    return new Error("yt-dlp binary not found in runtime.");
  }
  return error;
}

async function downloadSongAsMp3(input) {
  await ensureTempDir();
  const rawInput = String(input || "").trim();
  if (!rawInput) throw new Error("Missing song query.");

  const targets = isHttpUrl(rawInput)
    ? [rawInput]
    : await searchYouTubeCandidateUrls(rawInput, 10);

  if (!targets.length) {
    throw new Error("No YouTube result found for this query.");
  }

  let lastError = null;
  for (const target of targets) {
    try {
      const { stdout } = await runYtDlp(buildDownloadArgs(target), 240000);
      const parsed = parseDownloadResult(stdout);
      return {
        filePath: parsed.filePath,
        videoTitle: parsed.videoTitle,
        sourceUrl: target,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw normalizeYtDlpError(lastError || new Error("Download failed."));
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
