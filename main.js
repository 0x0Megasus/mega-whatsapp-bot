const { Client, LocalAuth } = require("whatsapp-web.js");
const puppeteer = require("puppeteer");
const qrcode = require("qrcode-terminal");
const http = require("http");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

let WWebJSUtil = null;
try {
  WWebJSUtil = require("whatsapp-web.js/src/util/Util");
} catch {
  WWebJSUtil = null;
}

const ENV_TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;
const MAX_TARGET_GROUPS = 2;
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || ".";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STORE_FILE = path.join(DATA_DIR, "bot-store.json");
const ADMIN_JIDS = new Set(["212704588420@c.us"]);
const ADMIN_PHONE_NUMBERS = new Set(["212704588420"]);
let ffmpegConfigured = false;
let ffmpegBinaryPath = null;
const albumMediaCache = new Map();
let botReady = false;
let latestQrText = null;

function getQrImageUrl(qrText) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(qrText)}`;
}

const store = {
  targetGroupIds: [],
  welcomedUsers: {},
  welcomeState: {},
  games: {
    mafia: {},
    mind: {},
  },
};

function resetStoreToDefault() {
  store.targetGroupIds = [];
  store.welcomedUsers = {};
  store.welcomeState = {};
  store.games = { mafia: {}, mind: {} };
}

const welcomeEmojis = ["", "🔥", "😎", "🤝", "🌙", "✨"];
const localRiddleBank = [
  {
    question: "I get wetter the more I dry. What am I?",
    answers: ["towel", "a towel"],
    hint: "You use it after shower.",
  },
  {
    question: "What has keys but can't open locks?",
    answers: ["piano", "a piano", "keyboard", "a keyboard"],
    hint: "It can make music.",
  },
  {
    question: "What has hands but can not clap?",
    answers: ["clock", "a clock"],
    hint: "It tells time.",
  },
  {
    question: "What has a face and two hands but no arms or legs?",
    answers: ["clock", "a clock"],
    hint: "You check it all day.",
  },
];

const localTriviaBank = [
  {
    question: "What is the largest ocean on Earth?",
    answers: ["pacific ocean", "pacific"],
    hint: "It is west of the Americas.",
  },
  {
    question: "How many continents are there?",
    answers: ["7", "seven"],
    hint: "More than 6, less than 8.",
  },
  {
    question: "Which planet is known as the Red Planet?",
    answers: ["mars"],
    hint: "Named after a Roman god.",
  },
  {
    question: "What gas do humans need to breathe to live?",
    answers: ["oxygen"],
    hint: "O2",
  },
];

function normalizeJid(jid = "") {
  return jid.replace(/:\d+@/, "@");
}

async function formatUser(client, jid) {
  if (!jid) return "Unknown";
  const fallback = jid.split("@")[0];
  try {
    const contact = await client.getContactById(jid);
    return contact.pushname || contact.name || contact.shortName || contact.number || fallback;
  } catch {
    return fallback;
  }
}

function shuffleArray(items = []) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function decodeHtmlEntities(value = "") {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeAnswer(value = "") {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickRandom(items = []) {
  if (!items.length) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function getMindStore(groupId) {
  if (!store.games.mind[groupId]) {
    store.games.mind[groupId] = {
      current: null,
      scores: {},
      streak: {
        userId: null,
        count: 0,
      },
    };
  }
  return store.games.mind[groupId];
}

function addMindPoints(groupId, playerId, points) {
  const groupMind = getMindStore(groupId);
  groupMind.scores[playerId] = (groupMind.scores[playerId] || 0) + points;
}

async function fetchApiJson(url) {
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function getTriviaQuestion() {
  try {
    const data = await fetchApiJson("https://opentdb.com/api.php?amount=1&type=multiple");
    const item = data?.results?.[0];
    if (!item?.question || !item?.correct_answer) throw new Error("invalid trivia payload");
    return {
      type: "trivia",
      source: "Open Trivia DB",
      question: decodeHtmlEntities(item.question),
      answers: [decodeHtmlEntities(item.correct_answer)],
      hint: `Category: ${decodeHtmlEntities(item.category || "General")}`,
    };
  } catch {
    const local = pickRandom(localTriviaBank);
    return {
      type: "trivia",
      source: "Local fallback",
      question: local.question,
      answers: local.answers,
      hint: local.hint,
    };
  }
}

async function getRiddleQuestion() {
  try {
    const data = await fetchApiJson("https://riddles-api.vercel.app/random");
    if (!data?.riddle || !data?.answer) throw new Error("invalid riddle payload");
    return {
      type: "riddle",
      source: "Riddles API",
      question: String(data.riddle).trim(),
      answers: [String(data.answer).trim()],
      hint: "Think simple, not deep.",
    };
  } catch {
    const local = pickRandom(localRiddleBank);
    return {
      type: "riddle",
      source: "Local fallback",
      question: local.question,
      answers: local.answers,
      hint: local.hint,
    };
  }
}

function isCorrectMindAnswer(session, input) {
  const guess = normalizeAnswer(input);
  if (!guess) return false;
  return session.answers.some((ans) => {
    const normalized = normalizeAnswer(ans);
    return guess === normalized || guess.includes(normalized) || normalized.includes(guess);
  });
}

function ensureGroupOnly(message) {
  return getTargetGroupIds().includes(message.from);
}

function isPrivateMessage(message) {
  return !message.from.endsWith("@g.us");
}

function getSenderId(message) {
  return normalizeJid(message.author || message.from);
}

function toDigits(value = "") {
  return value.replace(/\D/g, "");
}

async function isAdminMessage(message) {
  const senderId = getSenderId(message);
  if (ADMIN_JIDS.has(senderId)) return true;

  const senderDigits = toDigits(senderId.split("@")[0] || "");
  if (senderDigits && ADMIN_PHONE_NUMBERS.has(senderDigits)) return true;

  try {
    const contact = await message.getContact();
    const contactDigits = toDigits(contact?.number || "");
    if (contactDigits && ADMIN_PHONE_NUMBERS.has(contactDigits)) return true;
  } catch {
    // Ignore contact lookup failures and fallback to false.
  }

  return false;
}

function configureFfmpegPath() {
  try {
    const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
    const candidatePath = ffmpegInstaller?.path;
    if (!candidatePath || !fsSync.existsSync(candidatePath)) throw new Error("ffmpeg binary not found");

    ffmpegBinaryPath = candidatePath;
    process.env.FFMPEG_PATH = candidatePath;
    process.env.PATH = `${path.dirname(candidatePath)}${path.delimiter}${process.env.PATH || ""}`;

    let configured = false;
    if (WWebJSUtil?.setFfmpegPath) {
      WWebJSUtil.setFfmpegPath(candidatePath);
      configured = true;
    }
    try {
      const fluentFfmpeg = require("fluent-ffmpeg");
      if (fluentFfmpeg?.setFfmpegPath) {
        fluentFfmpeg.setFfmpegPath(candidatePath);
        configured = true;
      }
    } catch {
      // Ignore direct fluent-ffmpeg wiring failures.
    }

    ffmpegConfigured = configured;
    console.log(`FFmpeg configured for sticker conversion: ${candidatePath}`);
    return;
  } catch {
    // Keep fallback behavior for image stickers.
  }
  ffmpegBinaryPath = null;
  ffmpegConfigured = false;
  console.warn("FFmpeg not configured. Video stickers will fail until FFmpeg is installed.");
}

function getMediaGroupId(message) {
  return message?._data?.mediaGroupId || message?.mediaGroupId || null;
}

function cleanupAlbumMediaCache() {
  const now = Date.now();
  for (const [key, entry] of albumMediaCache.entries()) {
    if (!entry?.updatedAt || now - entry.updatedAt > 2 * 60 * 1000) {
      albumMediaCache.delete(key);
    }
  }
}

function cacheAlbumMediaMessage(message) {
  const mediaGroupId = getMediaGroupId(message);
  if (!mediaGroupId || !message?.hasMedia) return;

  cleanupAlbumMediaCache();
  const key = String(mediaGroupId);
  const serializedId = message?.id?._serialized;
  const current = albumMediaCache.get(key) || { items: [], updatedAt: 0 };
  const exists = current.items.some((msg) => msg?.id?._serialized && msg.id._serialized === serializedId);
  if (!exists) current.items.push(message);
  current.items.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  current.updatedAt = Date.now();
  albumMediaCache.set(key, current);
}

async function collectStickerSourceMessages(message, maxCount = 5) {
  const mediaGroupId = getMediaGroupId(message);
  const groupKey = mediaGroupId ? String(mediaGroupId) : null;
  const currentId = message?.id?._serialized;
  const sender = getSenderId(message);
  const currentTs = Number(message?.timestamp || 0);

  // Give pending album parts a chance to arrive in message_create.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const cached = groupKey ? albumMediaCache.get(groupKey)?.items || [] : [];
  if (cached.length) {
    const merged = [...cached];
    const ids = new Set(merged.map((msg) => msg?.id?._serialized).filter(Boolean));
    if (message.hasMedia && currentId && !ids.has(currentId)) {
      merged.push(message);
    }
    return merged
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .slice(0, maxCount);
  }

  try {
    const chat = await message.getChat();
    let grouped = [];
    let recent = [];

    // Retry briefly; album parts may arrive slightly later.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 900));
      }

      recent = await chat.fetchMessages({ limit: 80 });
      grouped = groupKey
        ? recent
            .filter((msg) => msg?.hasMedia)
            .filter((msg) => String(getMediaGroupId(msg) || "") === groupKey)
        : [];

      const seen = new Set();
      grouped = grouped
        .filter((msg) => {
          const id = msg?.id?._serialized;
          if (!id) return true;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      if (grouped.length >= 2 || grouped.length >= maxCount) break;
    }

    // Fallback: some sessions do not expose mediaGroupId reliably.
    // In that case, gather nearby media from same sender in a short window.
    if (grouped.length <= 1) {
      const windowSecs = 25;
      grouped = recent
        .filter((msg) => msg?.hasMedia)
        .filter((msg) => getSenderId(msg) === sender)
        .filter((msg) => {
          const ts = Number(msg?.timestamp || 0);
          if (!ts || !currentTs) return false;
          return Math.abs(currentTs - ts) <= windowSecs;
        })
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }

    const ids = new Set(grouped.map((msg) => msg?.id?._serialized).filter(Boolean));
    if (message.hasMedia && currentId && !ids.has(currentId)) {
      grouped.push(message);
    }

    return grouped.slice(0, maxCount);
  } catch {
    return [message];
  }
}

function getGroupStore(groupId) {
  if (!store.welcomedUsers[groupId]) store.welcomedUsers[groupId] = [];
  return store.welcomedUsers[groupId];
}

function getTargetGroupIds() {
  if (ENV_TARGET_GROUP_ID) {
    return ENV_TARGET_GROUP_ID.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, MAX_TARGET_GROUPS);
  }
  return store.targetGroupIds.slice(0, MAX_TARGET_GROUPS);
}

async function bindTargetGroupIfNeeded(groupId) {
  if (ENV_TARGET_GROUP_ID) return false;
  if (store.targetGroupIds.includes(groupId)) return false;
  if (store.targetGroupIds.length >= MAX_TARGET_GROUPS) return false;
  store.targetGroupIds.push(groupId);
  await saveStore();
  return true;
}

function resolveMafiaGroupIdForSender(sender) {
  const candidateGroups = getTargetGroupIds().filter((groupId) => {
    const game = getMafiaGame(groupId);
    return game && game.phase !== "ended" && game.players.includes(sender);
  });
  if (candidateGroups.length === 1) return candidateGroups[0];
  return null;
}

function getMafiaGame(groupId) {
  return store.games.mafia[groupId];
}

function getAlivePlayers(game) {
  return game.players.filter((jid) => game.alive.includes(jid));
}

function isAlive(game, jid) {
  return game.alive.includes(jid);
}

function countByRole(game, roleName) {
  return getAlivePlayers(game).filter((jid) => game.roles[jid] === roleName).length;
}

function checkMafiaWin(game) {
  const mafiaAlive = countByRole(game, "mafia");
  const totalAlive = getAlivePlayers(game).length;
  const townAlive = totalAlive - mafiaAlive;
  if (mafiaAlive === 0) return "town";
  if (mafiaAlive >= townAlive) return "mafia";
  return null;
}

function createMafiaRoles(playerCount) {
  const mafiaCount = playerCount >= 7 ? 2 : 1;
  const roles = [];
  for (let i = 0; i < mafiaCount; i += 1) roles.push("mafia");
  if (playerCount >= 5) roles.push("doctor");
  if (playerCount >= 6) roles.push("detective");
  while (roles.length < playerCount) roles.push("villager");
  return shuffleArray(roles);
}

function resolvePlayerFromArgs(message, args, candidates) {
  const candidateSet = new Set(candidates);
  const mentions = (message.mentionedIds || []).map(normalizeJid);
  for (const mentioned of mentions) {
    if (candidateSet.has(mentioned)) return mentioned;
  }

  const token = (args[0] || "").trim();
  if (!token) return null;
  const digits = token.replace(/\D/g, "");
  if (!digits) return null;
  return candidates.find((jid) => jid.startsWith(`${digits}@`)) || null;
}

function pickWelcomeEmoji(groupId) {
  const lastIndex = store.welcomeState[groupId]?.lastIndex;
  if (welcomeEmojis.length === 1) {
    store.welcomeState[groupId] = { lastIndex: 0 };
    return welcomeEmojis[0];
  }

  let nextIndex = Math.floor(Math.random() * welcomeEmojis.length);
  while (nextIndex === lastIndex) {
    nextIndex = Math.floor(Math.random() * welcomeEmojis.length);
  }
  store.welcomeState[groupId] = { lastIndex: nextIndex };
  return welcomeEmojis[nextIndex];
}

function mafiaHelpText() {
  return [
    "Mafia Commands",
    "",
    `${COMMAND_PREFIX}mafia help`,
    "Shows all mafia commands.",
    "",
    `${COMMAND_PREFIX}mafia info`,
    "Shows how to play Mafia step by step.",
    "",
    `${COMMAND_PREFIX}mafia create (group)`,
    "Creates a new mafia lobby. Creator becomes host.",
    "",
    `${COMMAND_PREFIX}mafia join (group)`,
    "Join the lobby before game starts.",
    "",
    `${COMMAND_PREFIX}mafia leave (group)`,
    "Leave lobby before game starts. If host leaves, next player becomes host.",
    "",
    `${COMMAND_PREFIX}mafia start (group, host only)`,
    "Starts game (min 4 players), assigns roles by DM, starts first action stage.",
    "",
    `${COMMAND_PREFIX}mafia status (group)`,
    "Shows current stage and alive players.",
    "",
    `${COMMAND_PREFIX}mafia kill @user (DM only, mafia role)`,
    "Sets mafia target for current action stage.",
    "",
    `${COMMAND_PREFIX}mafia save @user (DM only, doctor role)`,
    "Sets doctor save target for current action stage.",
    "",
    `${COMMAND_PREFIX}mafia check @user (DM only, detective role)`,
    "Checks one player; result is sent privately.",
    "",
    `${COMMAND_PREFIX}mafia vote @user (group, alive players)`,
    "Cast/replace your vote during vote stage.",
    "",
    `${COMMAND_PREFIX}mafia next (group, host only)`,
    "Resolves current stage and moves game forward.",
    "",
    `${COMMAND_PREFIX}mafia end (group, host only)`,
    "Force ends the mafia game.",
  ].join("\n");
}

function mafiaInfoText() {
  return [
    "How To Play Mafia",
    "",
    "1) Create and join the lobby (in group):",
    `- ${COMMAND_PREFIX}mafia create`,
    `- ${COMMAND_PREFIX}mafia join`,
    "",
    "2) Host starts the game (in group):",
    `- ${COMMAND_PREFIX}mafia start`,
    "Each player gets role DM from the bot.",
    "",
    "3) Action stage (secret, DM with bot):",
    `- Mafia: ${COMMAND_PREFIX}mafia kill @user`,
    `- Doctor: ${COMMAND_PREFIX}mafia save @user`,
    `- Detective: ${COMMAND_PREFIX}mafia check @user`,
    "",
    "4) Host resolves action stage (in group):",
    `- ${COMMAND_PREFIX}mafia next`,
    "",
    "5) Vote stage (in group):",
    `- Alive players vote: ${COMMAND_PREFIX}mafia vote @user`,
    "",
    "6) Host resolves votes and starts next round (in group):",
    `- ${COMMAND_PREFIX}mafia next`,
    "",
    "Win conditions:",
    "- Town wins when all mafia are eliminated.",
    "- Mafia wins when mafia count >= town count.",
    "",
    "Useful commands:",
    `- ${COMMAND_PREFIX}mafia status`,
    `- ${COMMAND_PREFIX}mafia end (host only)`,
  ].join("\n");
}

async function loadStore() {
  try {
    await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.targetGroupIds)) {
        store.targetGroupIds = parsed.targetGroupIds.filter(Boolean).slice(0, MAX_TARGET_GROUPS);
      } else if (parsed.targetGroupId) {
        store.targetGroupIds = [parsed.targetGroupId];
      } else {
        store.targetGroupIds = [];
      }
      store.welcomedUsers = parsed.welcomedUsers || {};
      store.welcomeState = parsed.welcomeState || {};
      const loadedGames = parsed.games || {};
      store.games = {
        mafia: loadedGames.mafia || {},
        mind: loadedGames.mind || {},
      };
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to load store:", error.message);
    }
  }
}

async function saveStore() {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

async function markCurrentMembersAsWelcomed(client) {
  try {
    const targetGroupIds = getTargetGroupIds();
    if (!targetGroupIds.length) return;

    for (const targetGroupId of targetGroupIds) {
      const chat = await client.getChatById(targetGroupId);
      if (!chat?.isGroup) continue;

      const known = new Set(getGroupStore(targetGroupId));
      for (const participant of chat.participants || []) {
        known.add(normalizeJid(participant.id?._serialized || participant.id?.user || ""));
      }
      store.welcomedUsers[targetGroupId] = [...known].filter(Boolean);
    }
    await saveStore();
  } catch (error) {
    console.error("Failed to initialize welcomed members:", error.message);
  }
}

function mindHelpText() {
  return [
    "*Mind Games* 🧠",
    `${COMMAND_PREFIX}mind help`,
    `${COMMAND_PREFIX}mind start (random API game)`,
    `${COMMAND_PREFIX}mind trivia`,
    `${COMMAND_PREFIX}mind riddle`,
    `${COMMAND_PREFIX}mind answer <your answer>`,
    `${COMMAND_PREFIX}mind hint`,
    `${COMMAND_PREFIX}mind skip`,
    `${COMMAND_PREFIX}mind score`,
    `${COMMAND_PREFIX}mind reset`,
  ].join("\n");
}

async function mindScoreboardText(client, groupId) {
  const groupMind = getMindStore(groupId);
  const ranking = Object.entries(groupMind.scores).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!ranking.length) return "No scores yet. Start with .mind start ✨";

  const lines = ["*Mind Scoreboard* 🏆"];
  for (let i = 0; i < ranking.length; i += 1) {
    const [jid, points] = ranking[i];
    lines.push(`${i + 1}. ${await formatUser(client, jid)}: ${points} pts`);
  }
  return lines.join("\n");
}

async function startMindSession(message, groupId, mode) {
  const groupMind = getMindStore(groupId);
  if (groupMind.current) {
    await message.reply("A game is already running. Use .mind answer, .mind hint or .mind skip 🎮");
    return;
  }

  const session = mode === "riddle" ? await getRiddleQuestion() : await getTriviaQuestion();
  groupMind.current = {
    ...session,
    startedAt: Date.now(),
  };
  await saveStore();

  const mood = session.type === "riddle" ? "🧩 Riddle Time" : "🎯 Trivia Time";
  await message.reply(
    [
      `${mood}`,
      "",
      `❓ ${session.question}`,
      "",
      `Reply with: ${COMMAND_PREFIX}mind answer <text>`,
      `Source: ${session.source}`,
    ].join("\n"),
  );
}

async function handleMindCommand(client, message, args) {
  const groupId = message.from;
  const sender = getSenderId(message);
  const sub = (args.shift() || "help").toLowerCase();
  const groupMind = getMindStore(groupId);

  if (sub === "help") {
    await message.reply(mindHelpText());
    return;
  }

  if (sub === "start") {
    const mode = Math.random() < 0.5 ? "trivia" : "riddle";
    await startMindSession(message, groupId, mode);
    return;
  }

  if (sub === "trivia") {
    await startMindSession(message, groupId, "trivia");
    return;
  }

  if (sub === "riddle") {
    await startMindSession(message, groupId, "riddle");
    return;
  }

  if (sub === "score" || sub === "scores" || sub === "leaderboard") {
    await message.reply(await mindScoreboardText(client, groupId));
    return;
  }

  if (sub === "reset") {
    groupMind.scores = {};
    groupMind.streak = { userId: null, count: 0 };
    await saveStore();
    await message.reply("Scoreboard reset for this group ✅");
    return;
  }

  if (!groupMind.current) {
    await message.reply(`No active game. Start one with ${COMMAND_PREFIX}mind start ✨`);
    return;
  }

  if (sub === "hint") {
    await message.reply(`💡 Hint: ${groupMind.current.hint || "No hint for this one. Trust your brain."}`);
    return;
  }

  if (sub === "skip") {
    const reveal = groupMind.current.answers[0];
    groupMind.current = null;
    groupMind.streak = { userId: null, count: 0 };
    await saveStore();
    await message.reply(`⏭️ Skipped. Correct answer was: *${reveal}*`);
    return;
  }

  if (sub === "answer") {
    const guess = args.join(" ").trim();
    if (!guess) {
      await message.reply(`Use: ${COMMAND_PREFIX}mind answer <your answer>`);
      return;
    }

    if (!isCorrectMindAnswer(groupMind.current, guess)) {
      await message.reply("❌ Not quite. Try again 🔁");
      return;
    }

    const wonType = groupMind.current.type;
    const basePoints = wonType === "riddle" ? 3 : 2;
    if (groupMind.streak.userId === sender) {
      groupMind.streak.count += 1;
    } else {
      groupMind.streak.userId = sender;
      groupMind.streak.count = 1;
    }
    const streakBonus = groupMind.streak.count >= 3 ? 1 : 0;
    const gained = basePoints + streakBonus;
    addMindPoints(groupId, sender, gained);

    const total = groupMind.scores[sender];
    const winnerName = await formatUser(client, sender);
    const answer = groupMind.current.answers[0];
    groupMind.current = null;
    await saveStore();

    await message.reply(
      [
        `✅ Correct, ${winnerName}!`,
        `Answer: *${answer}*`,
        `+${gained} pts (${basePoints} base${streakBonus ? " +1 streak" : ""})`,
        `Your total: ${total} pts 🏆`,
      ].join("\n"),
    );
    return;
  }

  await message.reply(`Unknown mind command. Use ${COMMAND_PREFIX}mind help`);
}

function getHelpText() {
  return [
    `*Bot Commands*`,
    `${COMMAND_PREFIX}help`,
    `${COMMAND_PREFIX}mafia help`,
    `${COMMAND_PREFIX}mind help`,
    `${COMMAND_PREFIX}resetstore (admin only)`,
    `${COMMAND_PREFIX}sticker (admin DM only, send with image/video)`,
  ].join("\n");
}

function startHealthServer() {
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      const payload = JSON.stringify({ ok: true, botReady });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
      return;
    }

    if (req.url === "/qr") {
      if (!latestQrText) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "QR not available right now." }));
        return;
      }
      const payload = JSON.stringify({
        ok: true,
        qrText: latestQrText,
        qrImageUrl: getQrImageUrl(latestQrText),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(payload);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Health server listening on port ${port}`);
  });
}

async function handleMafiaCommand(client, message, args, options = {}) {
  const { fromPrivate = false } = options;
  const sender = getSenderId(message);
  const sub = (args.shift() || "help").toLowerCase();
  if (sub === "help") {
    await message.reply(mafiaHelpText());
    return;
  }
  if (sub === "info") {
    await message.reply(mafiaInfoText());
    return;
  }

  const groupId = fromPrivate ? resolveMafiaGroupIdForSender(sender) : message.from;
  if (!groupId) {
    await message.reply(
      fromPrivate
        ? `No unique Mafia game found for you. Join/start in one linked group first.`
        : `No target groups linked yet. Send ${COMMAND_PREFIX}help in your group first.`,
    );
    return;
  }
  const game = getMafiaGame(groupId);
  const groupOnlyCommands = new Set(["create", "join", "leave", "start", "status", "vote", "next", "end"]);
  const privateOnlyCommands = new Set(["kill", "save", "check"]);

  if (fromPrivate && groupOnlyCommands.has(sub)) {
    await message.reply(`Use this in the game group: ${COMMAND_PREFIX}mafia ${sub}`);
    return;
  }
  if (!fromPrivate && privateOnlyCommands.has(sub)) {
    await message.reply(`Use this in DM with the bot: ${COMMAND_PREFIX}mafia ${sub} @user`);
    return;
  }

  if (sub === "create") {
    if (game && game.phase !== "ended") {
      await message.reply(`Mafia game already exists. Use ${COMMAND_PREFIX}mafia status`);
      return;
    }

    store.games.mafia[groupId] = {
      phase: "lobby",
      host: sender,
      players: [sender],
      alive: [],
      roles: {},
      votes: {},
      mafiaTarget: null,
      doctorTarget: null,
      detectiveTarget: null,
      dayCount: 0,
      nightCount: 0,
    };
    await saveStore();
    await message.reply(`Mafia lobby created by ${await formatUser(client, sender)}. Use ${COMMAND_PREFIX}mafia join`);
    return;
  }

  if (!game) {
    await message.reply(`No Mafia game. Use ${COMMAND_PREFIX}mafia create`);
    return;
  }

  if (sub === "join") {
    if (game.phase !== "lobby") {
      await message.reply("Cannot join now. Game already started.");
      return;
    }
    if (game.players.includes(sender)) {
      await message.reply("You are already in the lobby.");
      return;
    }
    game.players.push(sender);
    await saveStore();
    await message.reply(`${await formatUser(client, sender)} joined the Mafia lobby.`);
    return;
  }

  if (sub === "leave") {
    if (game.phase !== "lobby") {
      await message.reply("You cannot leave after the game starts.");
      return;
    }
    game.players = game.players.filter((jid) => jid !== sender);
    if (!game.players.length) {
      delete store.games.mafia[groupId];
      await saveStore();
      await message.reply("Lobby closed. No players left.");
      return;
    }
    if (game.host === sender) {
      game.host = game.players[0];
      await message.reply(`Host left. New host is ${await formatUser(client, game.host)}.`);
    } else {
      await message.reply(`${await formatUser(client, sender)} left the Mafia lobby.`);
    }
    await saveStore();
    return;
  }

  if (sub === "status") {
    if (game.phase === "lobby") {
      const hostName = await formatUser(client, game.host);
      const playerNames = await Promise.all(game.players.map((jid) => formatUser(client, jid)));
      await message.reply(
        [
          "*Mafia Lobby*",
          `Host: ${hostName}`,
          `Players (${game.players.length}): ${playerNames.join(", ")}`,
        ].join("\n"),
      );
      return;
    }

    const aliveNames = await Promise.all(getAlivePlayers(game).map((jid) => formatUser(client, jid)));
    const aliveList = aliveNames.join(", ");
    await message.reply(
      [
        "*Mafia Status*",
        `Stage: ${game.phase === "night" ? "Action" : game.phase === "day" ? "Vote" : game.phase}`,
        `Round: ${Math.max(game.nightCount, game.dayCount)}`,
        `Alive (${getAlivePlayers(game).length}): ${aliveList || "none"}`,
      ].join("\n"),
    );
    return;
  }

  if (sub === "start") {
    if (game.phase !== "lobby") {
      await message.reply("Game already started.");
      return;
    }
    if (game.host !== sender) {
      await message.reply("Only the host can start the game.");
      return;
    }
    if (game.players.length < 4) {
      await message.reply("Need at least 4 players to start Mafia.");
      return;
    }

    const roles = createMafiaRoles(game.players.length);
    game.roles = {};
    game.players.forEach((jid, index) => {
      game.roles[jid] = roles[index];
    });
    game.alive = [...game.players];
    game.phase = "night";
    game.dayCount = 0;
    game.nightCount = 1;
    game.votes = {};
    game.mafiaTarget = null;
    game.doctorTarget = null;
    game.detectiveTarget = null;
    await saveStore();

    const playerNames = await Promise.all(game.players.map((jid) => formatUser(client, jid)));
    await message.reply(
      [
        "*Mafia game started*",
        `Players: ${playerNames.join(", ")}`,
        `Round ${game.nightCount} action stage started`,
        `Mafia uses ${COMMAND_PREFIX}mafia kill @user in DM`,
        `Doctor uses ${COMMAND_PREFIX}mafia save @user in DM`,
        `Detective uses ${COMMAND_PREFIX}mafia check @user in DM`,
        `Host uses ${COMMAND_PREFIX}mafia next to resolve`,
      ].join("\n"),
    );

    for (const player of game.players) {
      const role = game.roles[player];
      const details =
        role === "mafia"
          ? "You are MAFIA. Pick a target in action stage using .mafia kill @user (DM)."
          : role === "doctor"
            ? "You are DOCTOR. Save one player in action stage with .mafia save @user (DM)."
            : role === "detective"
              ? "You are DETECTIVE. Check one player in action stage with .mafia check @user (DM)."
              : "You are VILLAGER. Vote in vote stage with .mafia vote @user.";
      try {
        await client.sendMessage(player, `Mafia role: ${role.toUpperCase()}\n${details}`);
      } catch (error) {
        console.error(`Could not DM role to ${player}:`, error.message);
      }
    }
    return;
  }

  if (sub === "end") {
    if (game.host !== sender) {
      await message.reply("Only the host can end the game.");
      return;
    }
    delete store.games.mafia[groupId];
    await saveStore();
    await message.reply("Mafia game ended.");
    return;
  }

  if (game.phase === "lobby") {
    await message.reply(`Game is in lobby. Use ${COMMAND_PREFIX}mafia start when ready.`);
    return;
  }

  if (!isAlive(game, sender)) {
    await message.reply("You are eliminated and cannot act.");
    return;
  }

  if (sub === "kill") {
    if (game.phase !== "night") {
      await message.reply("Kill is only available in action stage.");
      return;
    }
    if (game.roles[sender] !== "mafia") {
      await message.reply("Only mafia can use kill.");
      return;
    }
    const target = resolvePlayerFromArgs(message, args, getAlivePlayers(game).filter((jid) => jid !== sender));
    if (!target) {
      await message.reply("Target not found. Mention a living player.");
      return;
    }
    game.mafiaTarget = target;
    await saveStore();
    await message.reply(`Mafia target locked: ${await formatUser(client, target)}.`);
    return;
  }

  if (sub === "save") {
    if (game.phase !== "night") {
      await message.reply("Save is only available in action stage.");
      return;
    }
    if (game.roles[sender] !== "doctor") {
      await message.reply("Only doctor can use save.");
      return;
    }
    const target = resolvePlayerFromArgs(message, args, getAlivePlayers(game));
    if (!target) {
      await message.reply("Target not found. Mention a living player.");
      return;
    }
    game.doctorTarget = target;
    await saveStore();
    await message.reply(`Doctor target locked: ${await formatUser(client, target)}.`);
    return;
  }

  if (sub === "check") {
    if (game.phase !== "night") {
      await message.reply("Check is only available in action stage.");
      return;
    }
    if (game.roles[sender] !== "detective") {
      await message.reply("Only detective can use check.");
      return;
    }
    if (game.detectiveTarget) {
      await message.reply("Detective already checked in this action stage.");
      return;
    }
    const target = resolvePlayerFromArgs(message, args, getAlivePlayers(game).filter((jid) => jid !== sender));
    if (!target) {
      await message.reply("Target not found. Mention a living player.");
      return;
    }
    game.detectiveTarget = target;
    await saveStore();
    try {
      await client.sendMessage(sender, `${await formatUser(client, target)} is ${game.roles[target] === "mafia" ? "MAFIA" : "NOT mafia"}.`);
    } catch (error) {
      console.error(`Could not DM detective result to ${sender}:`, error.message);
    }
    await message.reply("Detective check complete. Result sent privately.");
    return;
  }

  if (sub === "vote") {
    if (game.phase !== "day") {
      await message.reply("Vote is only available in vote stage.");
      return;
    }
    const target = resolvePlayerFromArgs(message, args, getAlivePlayers(game).filter((jid) => jid !== sender));
    if (!target) {
      await message.reply("Target not found. Mention a living player.");
      return;
    }
    game.votes[sender] = target;
    await saveStore();
    await message.reply(`${await formatUser(client, sender)} voted ${await formatUser(client, target)}.`);
    return;
  }

  if (sub === "next") {
    if (game.host !== sender) {
      await message.reply("Only host can move to next phase.");
      return;
    }

    if (game.phase === "night") {
      if (!game.mafiaTarget) {
        await message.reply("Action stage cannot resolve yet. Mafia must choose a target.");
        return;
      }

      let eliminated = null;
      if (game.mafiaTarget !== game.doctorTarget) {
        eliminated = game.mafiaTarget;
        game.alive = game.alive.filter((jid) => jid !== eliminated);
      }

      game.mafiaTarget = null;
      game.doctorTarget = null;
      game.detectiveTarget = null;
      game.phase = "day";
      game.dayCount += 1;
      game.votes = {};

      const winner = checkMafiaWin(game);
      if (winner) {
        game.phase = "ended";
        await saveStore();
        const eliminatedName = await formatUser(client, eliminated);
        await message.reply(
          eliminated
            ? `${eliminatedName} was eliminated in action stage. ${winner.toUpperCase()} wins.`
            : `No elimination in action stage. ${winner.toUpperCase()} wins.`,
        );
        return;
      }

      await saveStore();
      await message.reply(
        eliminated
          ? `${await formatUser(client, eliminated)} was eliminated. Vote stage started. Use ${COMMAND_PREFIX}mafia vote @user`
          : `No elimination in action stage. Vote stage started. Use ${COMMAND_PREFIX}mafia vote @user`,
      );
      return;
    }

    if (game.phase === "day") {
      const tally = {};
      for (const [voter, target] of Object.entries(game.votes)) {
        if (!isAlive(game, voter) || !isAlive(game, target)) continue;
        tally[target] = (tally[target] || 0) + 1;
      }

      let topTarget = null;
      let topVotes = 0;
      let tie = false;
      for (const [target, votes] of Object.entries(tally)) {
        if (votes > topVotes) {
          topTarget = target;
          topVotes = votes;
          tie = false;
        } else if (votes === topVotes && votes > 0) {
          tie = true;
        }
      }

      let eliminated = null;
      if (!tie && topTarget) {
        eliminated = topTarget;
        game.alive = game.alive.filter((jid) => jid !== eliminated);
      }

      const winner = checkMafiaWin(game);
      if (winner) {
        game.phase = "ended";
        await saveStore();
        const eliminatedName = await formatUser(client, eliminated);
        await message.reply(
          eliminated
            ? `${eliminatedName} was voted out. ${winner.toUpperCase()} wins.`
            : `${winner.toUpperCase()} wins.`,
        );
        return;
      }

      game.phase = "night";
      game.nightCount += 1;
      game.mafiaTarget = null;
      game.doctorTarget = null;
      game.detectiveTarget = null;
      game.votes = {};
      await saveStore();

      await message.reply(
        eliminated
          ? `${await formatUser(client, eliminated)} was voted out. Action stage for round ${game.nightCount} started.`
          : `No elimination in vote stage (tie or no votes). Action stage for round ${game.nightCount} started.`,
      );
      return;
    }

    await message.reply(`Game already ended. Use ${COMMAND_PREFIX}mafia create for a new one.`);
    return;
  }

  await message.reply(`Unknown mafia command. Use ${COMMAND_PREFIX}mafia help`);
}

async function handleCommand(client, message) {
  const body = (message.body || "").trim();
  if (!body.startsWith(COMMAND_PREFIX)) return;

  const parts = body.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
  const command = (parts.shift() || "").toLowerCase();
  if (!command) return;

  if (command === "resetstore") {
    if (!(await isAdminMessage(message))) {
      await message.reply("Only admin can use this command.");
      return;
    }
    resetStoreToDefault();
    await saveStore();
    await message.reply("Store reset to default.");
    return;
  }

  if (command === "sticker") {
    if (!isPrivateMessage(message)) {
      await message.reply("This command is DM only.");
      return;
    }
    if (!(await isAdminMessage(message))) {
      await message.reply("Only admin can use this command.");
      return;
    }
    if (!message.hasMedia) {
      await message.reply(`Send an image or video with caption ${COMMAND_PREFIX}sticker`);
      return;
    }

    const sourceMessages = await collectStickerSourceMessages(message, 5);
    const totalSources = sourceMessages.length;
    let successCount = 0;
    let unsupportedCount = 0;

    for (const src of sourceMessages) {
      const media = await src.downloadMedia();
      const mime = media?.mimetype || "";
      const isImage = mime.startsWith("image/");
      const isVideo = mime.startsWith("video/");
      if (!media || (!isImage && !isVideo)) {
        unsupportedCount += 1;
        continue;
      }

      try {
        await client.sendMessage(message.from, media, {
          sendMediaAsSticker: true,
          stickerName: "@Megasus",
          stickerAuthor: "DM: +212704588420",
        });
        successCount += 1;
      } catch (error) {
        const msg = String(error?.message || "");
        if (msg.includes("spawn ffmpeg ENOENT")) {
          await message.reply(
            `FFmpeg not found at runtime. Restart bot and try again. Configured path: ${ffmpegBinaryPath || "none"}`,
          );
          return;
        }
        throw error;
      }
    }

    if (!successCount && unsupportedCount) {
      await message.reply("Only images and videos can be converted to stickers.");
      return;
    }
    if (totalSources > 1) {
      await message.reply(`Done. Converted ${successCount}/${totalSources} to stickers.`);
      return;
    }
    return;
  }

  if (isPrivateMessage(message)) {
    if (command === "mafia") {
      await handleMafiaCommand(client, message, parts, { fromPrivate: true });
      return;
    }
    if (command === "mind") {
      await message.reply(`Use mind games in group chat only: ${COMMAND_PREFIX}mind start`);
    }
    return;
  }

  const didBind = await bindTargetGroupIfNeeded(message.from);
  if (didBind) {
    await message.reply(`This group is now linked to the bot (${getTargetGroupIds().length}/${MAX_TARGET_GROUPS}).`);
    await markCurrentMembersAsWelcomed(client);
  }

  if (!ensureGroupOnly(message)) return;

  if (command === "help") {
    await message.reply(getHelpText());
    return;
  }
  if (command === "mafia") {
    await handleMafiaCommand(client, message, parts);
    return;
  }
  if (command === "mind") {
    await handleMindCommand(client, message, parts);
    return;
  }

  await message.reply(`Unknown command. Use ${COMMAND_PREFIX}help`);
}

async function handleGroupJoin(client, notification) {
  const targetGroupIds = getTargetGroupIds();
  if (!targetGroupIds.length) return;

  const groupId = notification.chatId || notification.id?.remote || notification.id?.remote?._serialized;
  if (!targetGroupIds.includes(groupId)) return;

  const joined = notification.recipientIds || [];
  if (!joined.length) return;

  const knownSet = new Set(getGroupStore(groupId));
  const newMembers = [];
  for (const jid of joined.map(normalizeJid)) {
    if (!jid || knownSet.has(jid)) continue;
    knownSet.add(jid);
    newMembers.push(jid);
  }
  if (!newMembers.length) return;

  store.welcomedUsers[groupId] = [...knownSet];
  await saveStore();

  for (const jid of newMembers) {
    const emoji = pickWelcomeEmoji(groupId);
    const name = await formatUser(client, jid);
    const base = `Welcome ${name} to this fuckin group, & Ramadan Mubarak.`;
    await notification.reply(emoji ? `${base} ${emoji}` : base);
  }
  await saveStore();
}

async function start() {
  await loadStore();
  configureFfmpegPath();
  startHealthServer();

  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: process.env.LOCAL_AUTH_PATH || ".wwebjs_auth",
    }),
    puppeteer: {
      headless: true,
      executablePath: puppeteer.executablePath(),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  client.on("qr", (qr) => {
    latestQrText = qr;
    qrcode.generate(qr, { small: true });
    console.log(`Open this QR image URL: ${getQrImageUrl(qr)}`);
    console.log("Or open /qr endpoint on your Railway public URL.");
    console.log("Scan the QR code above in WhatsApp.");
  });

  client.on("ready", async () => {
    console.log("Bot is ready.");
    botReady = true;
    await markCurrentMembersAsWelcomed(client);
  });

  client.on("message_create", async (message) => {
    try {
      cacheAlbumMediaMessage(message);
      await handleCommand(client, message);
    } catch (error) {
      console.error("Command error:", error.message);
    }
  });

  client.on("group_join", async (notification) => {
    try {
      await handleGroupJoin(client, notification);
    } catch (error) {
      console.error("group_join error:", error.message);
    }
  });

  await client.initialize();
}

start().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
