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

function runYtDlp(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const binary = resolveYtDlpBinary();
    const child = spawn(binary, args, {
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
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start yt-dlp (${binary}): ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("Download timed out."));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function resolveCookieArgs() {
  const directCookieFile = String(process.env.YTDLP_COOKIE_FILE || process.env.YTDLP_COOKIES_PATH || "").trim();
  if (directCookieFile && fsSync.existsSync(directCookieFile)) {
    return ["--cookies", directCookieFile];
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

async function searchYouTubeCandidateUrls(songName, limit = 5) {
  const query = String(songName || "").trim();
  if (!query) throw new Error("Missing song name.");

  const args = [
    "--flat-playlist",
    "--no-warnings",
    "--no-playlist",
    "--print",
    "webpage_url",
    `ytsearch${Math.max(1, Number(limit) || 5)}:${query}`,
    ...resolveCookieArgs(),
    ...resolveProxyArgs(),
  ];

  const { stdout } = await runYtDlp(args, 90000);
  const urls = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));

  return [...new Set(urls)];
}

async function searchYouTubeFirstVideoUrl(songName) {
  const query = String(songName || "").trim();
  if (!query) throw new Error("Missing song name.");

  const endpoint = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(`YouTube search failed (HTTP ${response.status}).`);
  }

  const html = await response.text();
  const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (!match?.[1]) {
    throw new Error("No YouTube result found for this query.");
  }

  return `https://www.youtube.com/watch?v=${match[1]}`;
}

function normalizeYtDlpError(error) {
  const raw = String(error?.message || "");
  if (raw.includes("Requested format is not available") || raw.includes("no video formats found")) {
    return new Error("YouTube returned results but no downloadable audio format was available.");
  }
  if (
    raw.includes("Sign in to confirm you’re not a bot") ||
    raw.includes("Sign in to confirm you're not a bot") ||
    raw.includes("This helps protect our community")
  ) {
    return new Error(
      "YouTube blocked this request. Configure YTDLP_COOKIE_FILE or YTDLP_COOKIES_B64 (optionally YTDLP_PROXY_URL), then try again.",
    );
  }
  if (raw.includes("Failed to start yt-dlp")) {
    return new Error("yt-dlp is not installed in runtime. Install yt-dlp in your Docker image.");
  }
  return error;
}

async function downloadSongAsMp3(songName) {
  await ensureTempDir();

  const query = String(songName || "").trim();
  if (!query) {
    throw new Error("Missing song name.");
  }

  let candidateUrls = [];
  try {
    candidateUrls = await searchYouTubeCandidateUrls(query, 5);
  } catch {
    candidateUrls = [];
  }
  if (!candidateUrls.length) {
    candidateUrls = [await searchYouTubeFirstVideoUrl(query)];
  }

  const outputTemplate = path.join("temp", "%(id)s.%(ext)s");
  const sharedArgs = [
    "-x",
    "--audio-format",
    "mp3",
    "--no-playlist",
    "--socket-timeout",
    "30",
    "--retries",
    "3",
    "--force-ipv4",
    "--print",
    "title",
    "--print",
    "after_move:filepath",
    "-o",
    outputTemplate,
    ...resolveCookieArgs(),
    ...resolveProxyArgs(),
  ];

  const strategyArgs = [
    ["--extractor-args", "youtube:player_client=android,web"],
    ["--extractor-args", "youtube:player_client=ios,android"],
    ["--extractor-args", "youtube:player_client=web_creator,android"],
  ];

  const attempts = [];
  for (const targetUrl of candidateUrls) {
    for (const strategy of strategyArgs) {
      attempts.push(["--js-runtimes", "node", ...sharedArgs, ...strategy, targetUrl]);
      attempts.push([...sharedArgs, ...strategy, targetUrl]);
    }
  }

  let stdout = "";
  let lastError = null;
  for (const args of attempts) {
    try {
      const result = await runYtDlp(args);
      stdout = result.stdout;
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      // Keep trying if this runtime flag is unsupported.
      if (message.includes("no such option: --js-runtimes")) {
        continue;
      }
      if (message.includes("Requested format is not available")) {
        continue;
      }
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
  const titleLine = lines.length > 1 ? lines[lines.length - 2] : query;
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
  runYtDlp,
  searchYouTubeFirstVideoUrl,
  downloadSongAsMp3,
  cleanupDownloadedFile,
};
