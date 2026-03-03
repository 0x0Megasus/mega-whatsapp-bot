const { spawn } = require("child_process");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const TEMP_DIR = path.resolve(process.cwd(), "temp");

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
    const child = spawn("yt-dlp", args, {
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
      reject(new Error(`Failed to start yt-dlp: ${error.message}`));
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

async function downloadSongAsMp3(songName) {
  await ensureTempDir();

  const query = String(songName || "").trim();
  if (!query) {
    throw new Error("Missing song name.");
  }

  const outputTemplate = path.join("temp", "%(id)s.%(ext)s");
  const baseArgs = [
    "-x",
    "--audio-format",
    "mp3",
    "--no-playlist",
    "--print",
    "title",
    "--print",
    "after_move:filepath",
    "-o",
    outputTemplate,
    `ytsearch1:${query}`,
  ];

  let stdout = "";
  try {
    // Preferred command for newer yt-dlp builds.
    const result = await runYtDlp(["--js-runtimes", "node", ...baseArgs]);
    stdout = result.stdout;
  } catch (error) {
    const message = String(error?.message || "");
    if (!message.includes("no such option: --js-runtimes")) {
      throw error;
    }
    // Fallback for older distro yt-dlp versions (common on containers).
    const fallback = await runYtDlp(baseArgs);
    stdout = fallback.stdout;
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
  downloadSongAsMp3,
  cleanupDownloadedFile,
};
