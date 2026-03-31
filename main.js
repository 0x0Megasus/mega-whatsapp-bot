const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const puppeteer = require("puppeteer");
const qrcode = require("qrcode-terminal");
const http = require("http");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const cheerio = require("cheerio");

let WWebJSUtil = null;
try {
  WWebJSUtil = require("whatsapp-web.js/src/util/Util");
} catch {
  WWebJSUtil = null;
}

const ENV_TARGET_GROUP_ID = process.env.TARGET_GROUP_ID;
const MAX_TARGET_GROUPS = 4;
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || ".";
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STORE_FILE = path.join(DATA_DIR, "bot-store.json");
const COURSE_DOWNLOAD_DIR = process.env.COURSE_DOWNLOAD_DIR || path.join(DATA_DIR, "cources-downloads");
const ADMIN_JIDS = new Set(["212704588420@c.us"]);
const ADMIN_PHONE_NUMBERS = new Set(["212704588420"]);
let ffmpegBinaryPath = null;
const albumMediaCache = new Map();
let botReady = false;
let latestQrText = null;
const DEFAULT_COURCES_FETCH_TIMEOUT_MS = Number(process.env.COURCES_FETCH_TIMEOUT_MS || 180000);
const DEFAULT_COURCES_DOWNLOAD_TIMEOUT_MS = Number(process.env.COURCES_DOWNLOAD_TIMEOUT_MS || 120000);
const WWEBJS_INIT_MAX_RETRIES = Number(process.env.WWEBJS_INIT_MAX_RETRIES || 8);
const WWEBJS_INIT_RETRY_DELAY_MS = Number(process.env.WWEBJS_INIT_RETRY_DELAY_MS || 5000);

function getQrImageUrl(qrText) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(qrText)}`;
}

const store = {
  targetGroupIds: [],
  welcomedUsers: {},
  welcomeState: {},
  games: {
    mafia: {},
    flag: {},
  },
};

function resetStoreToDefault() {
  store.targetGroupIds = [];
  store.welcomedUsers = {};
  store.welcomeState = {};
  store.games = { mafia: {}, flag: {} };
}

const welcomeEmojis = ["", "🔥", "😎", "🤝", "🌙", "✨"];
const localFlagBank = [
  {
    code: "MA",
    names: ["morocco", "kingdom of morocco", "maroc"],
  },
  {
    code: "US",
    names: ["united states", "usa", "united states of america", "america"],
  },
  {
    code: "GB",
    names: ["united kingdom", "uk", "great britain", "britain", "england"],
  },
  {
    code: "FR",
    names: ["france", "french republic"],
  },
  {
    code: "BR",
    names: ["brazil", "federative republic of brazil"],
  },
  {
    code: "JP",
    names: ["japan"],
  },
  {
    code: "CA",
    names: ["canada"],
  },
  {
    code: "DE",
    names: ["germany", "federal republic of germany", "deutschland"],
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

function getFlagStore(groupId) {
  if (!store.games.flag[groupId]) {
    store.games.flag[groupId] = {
      current: null,
      scores: {},
      streak: {
        userId: null,
        count: 0,
      },
    };
  }
  return store.games.flag[groupId];
}

function addFlagPoints(groupId, playerId, points) {
  const groupFlag = getFlagStore(groupId);
  groupFlag.scores[playerId] = (groupFlag.scores[playerId] || 0) + points;
}

async function fetchApiJson(url) {
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function countryCodeToFlagEmoji(code = "") {
  const upper = String(code).toUpperCase().trim();
  if (!/^[A-Z]{2}$/.test(upper)) return "";
  return [...upper].map((ch) => String.fromCodePoint(127397 + ch.charCodeAt(0))).join("");
}

function buildCountryAnswers(country) {
  const names = new Set();
  if (country?.name?.common) names.add(String(country.name.common));
  if (country?.name?.official) names.add(String(country.name.official));
  for (const alt of country?.altSpellings || []) {
    if (alt) names.add(String(alt));
  }
  if (country?.cca2) names.add(String(country.cca2));
  if (country?.cca3) names.add(String(country.cca3));
  return [...names].map(normalizeAnswer).filter(Boolean);
}

async function getFlagQuestion() {
  try {
    const countries = await fetchApiJson("https://restcountries.com/v3.1/all?fields=name,flag,cca2,cca3,altSpellings");
    if (!Array.isArray(countries) || !countries.length) throw new Error("invalid countries payload");

    const valid = countries.filter((country) => country?.cca2 && countryCodeToFlagEmoji(country.cca2));
    const selected = pickRandom(valid);
    if (!selected) throw new Error("no valid country found");

    return {
      type: "flag",
      source: "REST Countries",
      flag: selected.flag || countryCodeToFlagEmoji(selected.cca2),
      answers: buildCountryAnswers(selected),
      revealName: selected?.name?.common || selected?.name?.official || selected.cca2,
      hint: `Starts with: ${(selected?.name?.common || "").charAt(0).toUpperCase()}`,
    };
  } catch {
    const local = pickRandom(localFlagBank);
    return {
      type: "flag",
      source: "Local fallback",
      flag: countryCodeToFlagEmoji(local.code),
      answers: local.names.map(normalizeAnswer),
      revealName: local.names[0],
      hint: `Starts with: ${local.names[0].charAt(0).toUpperCase()}`,
    };
  }
}

function isCorrectFlagAnswer(session, input) {
  const guess = normalizeAnswer(input);
  if (!guess) return false;
  return session.answers.some((ans) => {
    return guess === ans || guess.includes(ans) || ans.includes(guess);
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

function getGroupParticipantJids(chat) {
  return (chat?.participants || [])
    .map((participant) => normalizeJid(participant?.id?._serialized || ""))
    .filter(Boolean);
}

function resolveKickTargets(message, args, participantJids = []) {
  const targets = new Set((message.mentionedIds || []).map(normalizeJid));
  for (const token of args) {
    const digits = toDigits(token || "");
    if (!digits) continue;
    const match = participantJids.find((jid) => {
      const jidDigits = toDigits(normalizeJid(jid).split("@")[0] || "");
      return jidDigits === digits || jidDigits.endsWith(digits) || digits.endsWith(jidDigits);
    });
    if (match) targets.add(match);
  }
  return [...targets].filter((jid) => participantJids.includes(jid));
}

async function resolveKickTargetsWithContext(message, args, participantJids = []) {
  const targets = new Set(resolveKickTargets(message, args, participantJids));

  try {
    const mentions = await message.getMentions();
    for (const contact of mentions || []) {
      const mentionJid = normalizeJid(contact?.id?._serialized || "");
      if (mentionJid && participantJids.includes(mentionJid)) targets.add(mentionJid);
    }
  } catch {
    // Continue with other target detection methods.
  }

  try {
    if (message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      const quotedSender = getSenderId(quoted);
      if (quotedSender && participantJids.includes(quotedSender)) targets.add(quotedSender);
    }
  } catch {
    // Continue with other target detection methods.
  }

  return [...targets].filter((jid) => participantJids.includes(jid));
}

function isGroupAdminParticipant(participant) {
  return Boolean(participant?.isAdmin || participant?.isSuperAdmin);
}

function getErrorText(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message.trim()) return error.message.trim();
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableInitializeError(error) {
  const text = getErrorText(error).toLowerCase();
  return (
    text.includes("execution context was destroyed") ||
    text.includes("runtime.callfunctionon") ||
    text.includes("target closed") ||
    text.includes("session closed") ||
    text.includes("navigation") ||
    text.includes("protocol error")
  );
}

function normalizeText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function getUcaConfig() {
  const api = String(process.env.UCA_API || process.env.api || "https://ecampus-flsh.uca.ma/login/index.php").trim();
  const username = String(process.env.UCA_USERNAME || process.env.username || "").trim();
  const password = String(process.env.UCA_PASSWORD || process.env.password || "").trim();
  const moodleSession = String(process.env.UCA_MOODLESESSION || process.env.moodlesession || "").trim();

  if (!api) throw new Error("Missing UCA_API/api");
  if (!moodleSession && (!username || !password)) {
    throw new Error("Set UCA_MOODLESESSION or set UCA_USERNAME + UCA_PASSWORD");
  }

  return { api, username, password, moodleSession };
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const raw = headers.get("set-cookie");
  if (!raw) return [];
  return raw.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}

function mergeCookies(existingCookieHeader = "", nextSetCookieValues = []) {
  const jar = new Map();
  if (existingCookieHeader) {
    for (const piece of existingCookieHeader.split(";")) {
      const [k, ...v] = piece.trim().split("=");
      if (k) jar.set(k, v.join("="));
    }
  }
  for (const cookie of nextSetCookieValues) {
    const first = cookie.split(";")[0];
    const [k, ...v] = first.split("=");
    if (k) jar.set(k.trim(), v.join("=").trim());
  }
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

async function fetchWithCookies(url, options, cookieHeader) {
  const headers = { ...(options?.headers || {}) };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: "manual",
    signal: options?.signal || AbortSignal.timeout(DEFAULT_COURCES_FETCH_TIMEOUT_MS),
  });
  const mergedCookie = mergeCookies(cookieHeader, getSetCookies(response.headers));
  return { response, cookieHeader: mergedCookie };
}

async function followRedirectChain(startUrl, cookieHeader, userAgent, maxHops = 10) {
  let url = startUrl;
  let hops = 0;
  while (hops < maxHops) {
    const { response, cookieHeader: nextCookie } = await fetchWithCookies(
      url,
      {
        method: "GET",
        headers: { "User-Agent": userAgent },
      },
      cookieHeader,
    );
    cookieHeader = nextCookie;

    if (!isRedirectStatus(response.status)) {
      const html = await response.text();
      return { finalUrl: url, finalResponse: response, html, cookieHeader };
    }

    const location = response.headers.get("location");
    if (!location) {
      const html = await response.text();
      return { finalUrl: url, finalResponse: response, html, cookieHeader };
    }
    url = new URL(location, url).toString();
    hops += 1;
  }
  throw new Error("Too many redirects while trying to reach dashboard");
}

function parseCoursesFromDashboard(html, baseUrl) {
  const $ = cheerio.load(html);
  const courses = new Map();
  const selectors = [
    'a[href*="/course/view.php?id="]',
    ".coursebox a",
    ".card.dashboard-card a",
    ".card-dashboard-course a",
    '[data-region="course-content"] a',
  ];

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const href = $(element).attr("href");
      const text = normalizeText($(element).text());
      if (!href || !text) return;

      let absoluteHref;
      try {
        absoluteHref = new URL(href, baseUrl).toString();
      } catch {
        return;
      }

      const idMatch = absoluteHref.match(/[?&]id=(\d+)/);
      const key = idMatch ? idMatch[1] : absoluteHref;
      if (!courses.has(key)) {
        courses.set(key, {
          id: idMatch ? idMatch[1] : null,
          name: text,
          url: absoluteHref,
        });
      }
    });
  }
  return Array.from(courses.values());
}

function looksLikeM2OrM4Course(courseName = "") {
  return /\bM(?:2|4)(?:\.\d+)?(?!\d)/i.test(courseName);
}

function isValidSemester(value = "") {
  return value === "2" || value === "4";
}

function courseMatchesSemester(courseName = "", semester = "") {
  if (!isValidSemester(semester)) return false;
  const pattern = new RegExp(`\\bM${semester}(?:\\.\\d+)?(?!\\d)`, "i");
  return pattern.test(courseName);
}

function extractModuleAndProfessor(courseName = "") {
  const moduleMatch = courseName.match(/\bM(?:2|4)(?:\.\d+)?(?!\d)/i);
  const profMatch = courseName.match(/\bPr\.?\s*([^\[\]|]+)/i);
  const module = moduleMatch ? moduleMatch[0].toUpperCase() : "Unknown Module";
  const professor = profMatch ? normalizeText(profMatch[1]).replace(/[.\s]+$/g, "") : "Unknown Professor";
  return { module, professor };
}

function isIgnoredCourseLink(link = {}) {
  const name = normalizeText(link.name || "").toLowerCase();
  const url = String(link.url || "").toLowerCase();
  if (!url) return true;

  // Ignore announcement/forum resources; they usually do not provide downloadable files.
  if (name.includes("announcement") || name.includes("annonce") || name.includes("annonces")) return true;
  if (url.includes("/mod/forum/")) return true;
  if (url.includes("newsforum")) return true;
  if (url.includes("annonces")) return true;
  if (url.includes("announcements")) return true;

  return false;
}

async function listDocumentsForM2M4Courses(courses, cookieHeader, userAgent, baseUrl) {
  const targetCourses = courses.filter((course) => looksLikeM2OrM4Course(course.name));
  const groupedDocs = new Map();

  const results = await Promise.all(
    targetCourses.map(async (course) => {
      const groupInfo = extractModuleAndProfessor(course.name);
      try {
        const page = await followRedirectChain(course.url, cookieHeader, userAgent);
        const $ = cheerio.load(page.html);
        const links = [];

        $("#page-content a[href]").each((_, element) => {
          const href = String($(element).attr("href") || "").trim();
          if (!href || href.startsWith("#") || /^javascript:/i.test(href) || /^mailto:/i.test(href)) return;

          let absoluteHref;
          try {
            absoluteHref = new URL(href, baseUrl).toString();
          } catch {
            return;
          }

          const instanceName = normalizeText($(element).find("span.instancename").first().text());
          const fallbackName = normalizeText($(element).text());
          const fileName = instanceName || fallbackName || "resource";
          const link = { url: absoluteHref, name: fileName };
          if (isIgnoredCourseLink(link)) return;
          links.push(link);
        });

        return { groupInfo, links };
      } catch {
        return { groupInfo, links: [] };
      }
    }),
  );

  for (const item of results) {
    if (!item.links.length) continue;
    const key = `${item.groupInfo.module}|||${item.groupInfo.professor}`;
    if (!groupedDocs.has(key)) {
      groupedDocs.set(key, {
        module: item.groupInfo.module,
        professor: item.groupInfo.professor,
        links: new Map(),
      });
    }

    for (const link of item.links) {
      groupedDocs.get(key).links.set(link.url, link.name);
    }
  }

  return Array.from(groupedDocs.values())
    .map((group) => ({
      ...group,
      links: Array.from(group.links.entries()).map(([url, name]) => ({ name, url })),
    }))
    .filter((group) => group.links.length > 0);
}

function parseLoginError(html) {
  const $ = cheerio.load(html);
  const candidates = ['[data-region="alert"]', ".alert-danger", ".loginerrors", ".error", ".invalid-feedback"];
  for (const selector of candidates) {
    const text = normalizeText($(selector).first().text());
    if (text) return text;
  }
  return "";
}

async function fetchUcaCourseLinks(semester) {
  const cfg = getUcaConfig();
  const userAgent = "whatsappMegaBot-cources/1.0";
  const baseUrl = `${new URL(cfg.api).protocol}//${new URL(cfg.api).host}`;
  const loginPath = new URL(cfg.api).pathname;
  let cookieHeader = "";
  let dashboardStep = null;

  if (cfg.moodleSession) {
    dashboardStep = await followRedirectChain(`${baseUrl}/my/`, `MoodleSession=${cfg.moodleSession}`, userAgent);
    const sessionPath = new URL(dashboardStep.finalUrl).pathname;
    if (sessionPath !== loginPath) {
      cookieHeader = dashboardStep.cookieHeader;
    } else {
      dashboardStep = null;
    }
  }

  if (!dashboardStep) {
    const loginPageStep = await fetchWithCookies(
      cfg.api,
      { method: "GET", headers: { "User-Agent": userAgent } },
      "",
    );
    const loginHtml = await loginPageStep.response.text();
    const $login = cheerio.load(loginHtml);
    const logintoken = String($login('input[name="logintoken"]').attr("value") || "").trim();
    if (!logintoken) {
      throw new Error("Could not read login token from UCA login page");
    }

    cookieHeader = loginPageStep.cookieHeader;
    const formBody = new URLSearchParams({
      username: cfg.username,
      password: cfg.password,
      logintoken,
    });

    const loginPost = await fetchWithCookies(
      cfg.api,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": userAgent,
        },
        body: formBody,
      },
      cookieHeader,
    );
    cookieHeader = loginPost.cookieHeader;
    const firstLocation = loginPost.response.headers.get("location");
    const startUrl = firstLocation ? new URL(firstLocation, baseUrl).toString() : `${baseUrl}/my/`;
    dashboardStep = await followRedirectChain(startUrl, cookieHeader, userAgent);

    const dashboardPath = new URL(dashboardStep.finalUrl).pathname;
    if (dashboardPath === loginPath) {
      const details = parseLoginError(dashboardStep.html);
      throw new Error(`Authentication failed${details ? ` (${details})` : ""}`);
    }
  }

  const courses = parseCoursesFromDashboard(dashboardStep.html, baseUrl);
  if (!courses.length) {
    throw new Error("No courses found");
  }

  const groups = await listDocumentsForM2M4Courses(courses, dashboardStep.cookieHeader, userAgent, baseUrl);
  const filteredGroups = groups
    .map((group) => ({
      ...group,
      links: group.links.filter((link) => courseMatchesSemester(`${group.module} ${link.name}`, semester)),
    }))
    .filter((group) => group.links.length > 0 && courseMatchesSemester(group.module, semester));
  const lines = [
    "_Cources Result_",
    `Semester: ${semester}`,
    `Courses found: ${courses.length}`,
    `Groups with files: ${filteredGroups.length}`,
    "",
  ];

  if (!filteredGroups.length) {
    lines.push(`No file URLs found for M${semester} courses.`);
    return { text: lines.join("\n"), entries: [], authCookieHeader: dashboardStep.cookieHeader || "" };
  }

  let globalId = 1;
  const entries = [];
  for (const group of filteredGroups) {
    lines.push("────────────────────────────");
    lines.push(`*${group.professor}*`);
    lines.push(`${group.module}`);
    lines.push("────────────────────────────");
    for (let i = 0; i < group.links.length; i += 1) {
      const link = group.links[i];
      lines.push(`ID ${globalId}: _${link.name}_`);
      lines.push(`${link.url}`);
      entries.push({
        id: globalId,
        module: group.module,
        professor: group.professor,
        name: link.name,
        url: link.url,
      });
      globalId += 1;
    }
    lines.push("");
  }

  lines.push(`Tip: ${COMMAND_PREFIX}cources download ${semester} <id>`);
  return { text: lines.join("\n"), entries, authCookieHeader: dashboardStep.cookieHeader || "" };
}

function sanitizeFileName(name = "file") {
  return String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "file";
}

function fileNameFromUrl(value = "") {
  try {
    const parsed = new URL(value);
    const base = decodeURIComponent(path.basename(parsed.pathname || ""));
    return sanitizeFileName(base || "file");
  } catch {
    return "file";
  }
}

function fileNameFromContentDisposition(header = "") {
  if (!header) return "";
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return sanitizeFileName(decodeURIComponent(utf8Match[1].trim()));
    } catch {
      return sanitizeFileName(utf8Match[1].trim());
    }
  }
  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  if (plainMatch?.[1]) return sanitizeFileName(plainMatch[1].trim());
  return "";
}

async function downloadCourseFile(url, index, total, authCookieHeader) {
  const headers = {};
  if (authCookieHeader) headers.Cookie = authCookieHeader;

  const response = await fetch(url, {
    method: "GET",
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(DEFAULT_COURCES_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const disposition = response.headers.get("content-disposition") || "";
  const candidateName = fileNameFromContentDisposition(disposition) || fileNameFromUrl(response.url || url);
  const prefix = String(index + 1).padStart(String(total).length, "0");
  const finalName = sanitizeFileName(`${prefix}-${candidateName || "file"}`);
  const outputPath = path.join(COURSE_DOWNLOAD_DIR, finalName);
  const data = Buffer.from(await response.arrayBuffer());

  await fs.writeFile(outputPath, data);
  return { fileName: finalName, outputPath, bytes: data.length };
}

function parseDownloadIds(raw = "") {
  const input = String(raw || "").trim();
  const numberMatches = [...input.matchAll(/#?(\d+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(numberMatches)];
}

async function cleanupCourseDownloadDir() {
  await fs.rm(COURSE_DOWNLOAD_DIR, { recursive: true, force: true });
}

function toMessageChunks(text = "", maxLen = 3500) {
  if (!text) return [];
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLen) {
      if (current) chunks.push(current);
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) {
          chunks.push(line.slice(i, i + maxLen));
        }
        current = "";
      } else {
        current = line;
      }
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTextInChunks(client, jid, text) {
  const chunks = toMessageChunks(text);
  for (const chunk of chunks) {
    if (chunk.trim()) await client.sendMessage(jid, chunk);
  }
}

async function handleCourcesCommand(client, message, args) {
  if (!(await isAdminMessage(message))) {
    await message.reply("Only bot owner can use this command.");
    return;
  }

  const targetJid = message.from;
  const sub = (args[0] || "").toLowerCase();
  const shouldDownload = sub === "download" || sub === "dl";
  const semester = shouldDownload ? String(args[1] || "").trim() : String(args[0] || "").trim();
  const targetQuery = shouldDownload ? args.slice(2).join(" ").trim() : "";

  await client.sendMessage(
    targetJid,
    shouldDownload
      ? "Fetching courses and downloading linked files, please wait..."
      : "Fetching courses, please wait...",
  );

  if (!isValidSemester(semester)) {
    await client.sendMessage(targetJid, "Invalid semester number. Use 2 or 4.");
    return;
  }

  const result = await fetchUcaCourseLinks(semester);
  if (!shouldDownload) {
    await sendTextInChunks(client, targetJid, result.text);
    return;
  }
  if (!targetQuery) {
    await client.sendMessage(targetJid, `Use: ${COMMAND_PREFIX}cources download ${semester} <id>`);
    return;
  }
  if (!result.entries.length) {
    await client.sendMessage(targetJid, "No URLs found, nothing to download.");
    return;
  }

  const ids = parseDownloadIds(targetQuery);
  if (!ids.length) {
    await client.sendMessage(targetJid, `Invalid id. Use: ${COMMAND_PREFIX}cources download ${semester} <id>`);
    return;
  }
  if (ids.length > 1) {
    await client.sendMessage(targetJid, "Use one id at a time to avoid conflicts.");
    return;
  }

  const selectedEntry = result.entries.find((entry) => entry.id === ids[0]);
  if (!selectedEntry) {
    await client.sendMessage(
      targetJid,
      `No file found for id ${ids[0]}. Run ${COMMAND_PREFIX}cources to refresh ids.`,
    );
    return;
  }

  await cleanupCourseDownloadDir();
  await fs.mkdir(COURSE_DOWNLOAD_DIR, { recursive: true });
  await client.sendMessage(targetJid, "Please wait...");
  try {
    const downloaded = await downloadCourseFile(selectedEntry.url, 0, 1, result.authCookieHeader);
    const media = MessageMedia.fromFilePath(downloaded.outputPath);
    await client.sendMessage(
      targetJid,
      media,
      {
        caption: `${selectedEntry.module} | ${selectedEntry.professor}\n${selectedEntry.name}\nID: ${selectedEntry.id}`,
      },
    );
    await fs.unlink(downloaded.outputPath).catch(() => {});
  } catch (error) {
    await client.sendMessage(targetJid, `Failed to send ID ${selectedEntry.id}: ${getErrorText(error)}`);
  } finally {
    await cleanupCourseDownloadDir();
  }
}

function configureFfmpegPath() {
  try {
    const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
    const candidatePath = ffmpegInstaller?.path || "";
    if (!candidatePath || !fsSync.existsSync(candidatePath)) throw new Error("ffmpeg binary not found");

    ffmpegBinaryPath = candidatePath;
    process.env.FFMPEG_PATH = candidatePath;
    process.env.PATH = `${path.dirname(candidatePath)}${path.delimiter}${process.env.PATH || ""}`;

    let configured = false;
    if (WWebJSUtil?.setFfmpegPath) {
      WWebJSUtil.setFfmpegPath(candidatePath);
      configured = true;
    }

    console.log(`FFmpeg configured for sticker conversion: ${candidatePath}`);
    return;
  } catch {
    // Fallback to system ffmpeg binary if installer package is unavailable.
    try {
      const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
      if (probe.status === 0) {
        ffmpegBinaryPath = "ffmpeg";
        process.env.FFMPEG_PATH = "ffmpeg";
        if (WWebJSUtil?.setFfmpegPath) {
          WWebJSUtil.setFfmpegPath("ffmpeg");
        }
        console.log("FFmpeg configured for sticker conversion: ffmpeg (system PATH)");
        return;
      }
    } catch {
      // Continue to warning below.
    }
  }
  ffmpegBinaryPath = null;
  console.warn("FFmpeg not configured. Video stickers will fail until FFmpeg is installed.");
}

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function cleanupChromiumProfileLocks(localAuthPath, clientId) {
  const sessionDir = path.join(localAuthPath, `session-${clientId || "default"}`);
  const candidates = [
    path.join(sessionDir, "SingletonLock"),
    path.join(sessionDir, "SingletonSocket"),
    path.join(sessionDir, "SingletonCookie"),
    path.join(sessionDir, "Default", "SingletonLock"),
    path.join(sessionDir, "Default", "SingletonSocket"),
    path.join(sessionDir, "Default", "SingletonCookie"),
  ];

  for (const lockPath of candidates) {
    await removeIfExists(lockPath);
  }
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
        flag: loadedGames.flag || {},
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

function flagHelpText() {
  return [
    "*Flag Game* 🚩",
    `${COMMAND_PREFIX}flag help`,
    `${COMMAND_PREFIX}flag start`,
    `${COMMAND_PREFIX}flag answer <country>`,
    `${COMMAND_PREFIX}flag hint`,
    `${COMMAND_PREFIX}flag skip`,
    `${COMMAND_PREFIX}flag score`,
    `${COMMAND_PREFIX}flag reset`,
  ].join("\n");
}

function getFfmpegExecutable() {
  if (ffmpegBinaryPath && fsSync.existsSync(ffmpegBinaryPath)) return ffmpegBinaryPath;
  if (process.env.FFMPEG_PATH && fsSync.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  return "ffmpeg";
}

async function flagScoreboardText(client, groupId) {
  const groupFlag = getFlagStore(groupId);
  const ranking = Object.entries(groupFlag.scores).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!ranking.length) return `No scores yet. Start with ${COMMAND_PREFIX}flag start ✨`;

  const lines = ["*Flag Scoreboard* 🏆"];
  for (let i = 0; i < ranking.length; i += 1) {
    const [jid, points] = ranking[i];
    lines.push(`${i + 1}. ${await formatUser(client, jid)}: ${points} pts`);
  }
  return lines.join("\n");
}

async function startFlagSession(message, groupId) {
  const groupFlag = getFlagStore(groupId);
  if (groupFlag.current) {
    await message.reply(`A flag round is already running. Use ${COMMAND_PREFIX}flag answer <country> 🎯`);
    return;
  }

  const session = await getFlagQuestion();
  groupFlag.current = {
    ...session,
    startedAt: Date.now(),
  };
  await saveStore();

  await message.reply(
    [
      "*Guess The Flag* 🌍",
      "",
      `🚩 ${session.flag}`,
      "",
      `Type your answer directly in chat, or use ${COMMAND_PREFIX}flag answer <country>`,
      `Source: ${session.source}`,
    ].join("\n"),
  );
}

async function resolveFlagGuess(client, message, guess, options = {}) {
  const { replyOnWrong = false } = options;
  const groupId = message.from;
  const sender = getSenderId(message);
  const groupFlag = getFlagStore(groupId);
  if (!groupFlag.current) return false;

  if (!isCorrectFlagAnswer(groupFlag.current, guess)) {
    if (replyOnWrong) {
      await message.reply("❌ Nope. Try again.");
    }
    return false;
  }

  if (groupFlag.streak.userId === sender) {
    groupFlag.streak.count += 1;
  } else {
    groupFlag.streak.userId = sender;
    groupFlag.streak.count = 1;
  }

  const streakBonus = groupFlag.streak.count >= 3 ? 1 : 0;
  const gained = 2 + streakBonus;
  addFlagPoints(groupId, sender, gained);

  const total = groupFlag.scores[sender];
  const winnerName = await formatUser(client, sender);
  const answer = groupFlag.current.revealName;
  groupFlag.current = null;
  await saveStore();

  await message.reply(
    [
      `✅ Correct, ${winnerName}!`,
      `Country: *${answer}*`,
      `+${gained} pts${streakBonus ? " (streak bonus)" : ""}`,
      `Total: ${total} pts 🏆`,
      `Start next round: ${COMMAND_PREFIX}flag start`,
    ].join("\n"),
  );
  return true;
}

async function handlePassiveFlagGuess(client, message) {
  if (isPrivateMessage(message)) return false;
  if (!ensureGroupOnly(message)) return false;
  const body = (message.body || "").trim();
  if (!body) return false;
  if (body.startsWith(COMMAND_PREFIX)) return false;

  const groupFlag = getFlagStore(message.from);
  if (!groupFlag.current) return false;
  return resolveFlagGuess(client, message, body, { replyOnWrong: false });
}

async function handleFlagCommand(client, message, args) {
  const groupId = message.from;
  const sub = (args.shift() || "help").toLowerCase();
  const groupFlag = getFlagStore(groupId);

  if (sub === "help") {
    await message.reply(flagHelpText());
    return;
  }

  if (sub === "start" || sub === "new") {
    await startFlagSession(message, groupId);
    return;
  }

  if (sub === "score" || sub === "scores" || sub === "leaderboard") {
    await message.reply(await flagScoreboardText(client, groupId));
    return;
  }

  if (sub === "reset") {
    groupFlag.scores = {};
    groupFlag.streak = { userId: null, count: 0 };
    groupFlag.current = null;
    await saveStore();
    await message.reply("Flag scoreboard reset for this group ✅");
    return;
  }

  if (!groupFlag.current) {
    await message.reply(`No active round. Start one with ${COMMAND_PREFIX}flag start ✨`);
    return;
  }

  if (sub === "hint") {
    await message.reply(`💡 Hint: ${groupFlag.current.hint || "No hint available."}`);
    return;
  }

  if (sub === "skip") {
    const reveal = groupFlag.current.revealName;
    groupFlag.current = null;
    groupFlag.streak = { userId: null, count: 0 };
    await saveStore();
    await message.reply(`⏭️ Skipped. Answer was: *${reveal}*`);
    return;
  }

  if (sub === "answer") {
    const guess = args.join(" ").trim();
    if (!guess) {
      await message.reply(`Use: ${COMMAND_PREFIX}flag answer <country>`);
      return;
    }
    await resolveFlagGuess(client, message, guess, { replyOnWrong: true });
    return;
  }

  await message.reply(`Unknown flag command. Use ${COMMAND_PREFIX}flag help`);
}

function getHelpText() {
  return [
    "*WHATSAPP MEGA BOT*",
    "",
    "Core Commands:",
    `${COMMAND_PREFIX}help`,
    `${COMMAND_PREFIX}sticker / ${COMMAND_PREFIX}s (DM or linked group, send with image/video)`,
    "",
    "Games:",
    `${COMMAND_PREFIX}mafia help`,
    `${COMMAND_PREFIX}flag help`,
    "",
    "Course Commands (owner only: DM or group):",
    `${COMMAND_PREFIX}cources <2|4>`,
    `${COMMAND_PREFIX}cources download <2|4> <id> (send one file by id, then delete from server)`,
    "",
    "Owner Commands:",
    `${COMMAND_PREFIX}kick @user (group only)`,
    `${COMMAND_PREFIX}close (group only)`,
    `${COMMAND_PREFIX}open (group only)`,
    `${COMMAND_PREFIX}resetstore`,
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
  const usesDefaultPrefix = body.startsWith(COMMAND_PREFIX);
  const usesPlusPrefix = body.startsWith("+");
  if (!usesDefaultPrefix && !usesPlusPrefix) {
    await handlePassiveFlagGuess(client, message);
    return;
  }

  const activePrefix = usesDefaultPrefix ? COMMAND_PREFIX : "+";
  const parts = body.slice(activePrefix.length).trim().split(/\s+/);
  const command = (parts.shift() || "").toLowerCase();
  if (!command) return;
  const isPlusAliasCommand = usesPlusPrefix && !usesDefaultPrefix && ["kick", "close", "open"].includes(command);
  if (usesPlusPrefix && !usesDefaultPrefix && !isPlusAliasCommand) {
    await handlePassiveFlagGuess(client, message);
    return;
  }

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

  if (command === "sticker" || command === "s") {
    if (!isPrivateMessage(message) && !ensureGroupOnly(message)) {
      return;
    }
    if (!message.hasMedia) {
      await message.reply(`Send an image or video with caption ${COMMAND_PREFIX}sticker or ${COMMAND_PREFIX}s`);
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

  if (command === "cources") {
    try {
      await handleCourcesCommand(client, message, parts);
    } catch (error) {
      await message.reply(`Failed to run ${COMMAND_PREFIX}cources: ${getErrorText(error)}`);
      console.error("Cources command error:", error);
    }
    return;
  }

  if (isPrivateMessage(message)) {
    if (command === "mafia") {
      await handleMafiaCommand(client, message, parts, { fromPrivate: true });
      return;
    }
    if (command === "flag") {
      await message.reply(`Use flag game in group chat only: ${COMMAND_PREFIX}flag start`);
    }
    return;
  }

  const didBind = await bindTargetGroupIfNeeded(message.from);
  if (didBind) {
    await message.reply(`This group is now linked to the bot (${getTargetGroupIds().length}/${MAX_TARGET_GROUPS}).`);
    await markCurrentMembersAsWelcomed(client);
  }

  if (!ensureGroupOnly(message)) return;

  if (command === "kick" || command === "close" || command === "open") {
    if (!(await isAdminMessage(message))) {
      await message.reply("Only bot owner can use this command.");
      return;
    }

    const chat = await message.getChat();
    if (!chat?.isGroup) {
      await message.reply("This command works in group chats only.");
      return;
    }

    const meJid = normalizeJid(client?.info?.wid?._serialized || "");
    const meParticipant = (chat.participants || []).find((participant) => {
      const participantJid = normalizeJid(participant?.id?._serialized || "");
      return participantJid && participantJid === meJid;
    });
    if (!isGroupAdminParticipant(meParticipant)) {
      await message.reply("I need to be a group admin to run this command.");
      return;
    }

    try {
      if (command === "close") {
        const success = await chat.setMessagesAdminsOnly(true);
        if (success === false) {
          await message.reply("Failed to close group chat. Check admin permissions and try again.");
          return;
        }
        await message.reply("Group chat is now closed. Only admins can send messages.");
        return;
      }

      if (command === "open") {
        const success = await chat.setMessagesAdminsOnly(false);
        if (success === false) {
          await message.reply("Failed to open group chat. Check admin permissions and try again.");
          return;
        }
        await message.reply("Group chat is now open for all members.");
        return;
      }

      const participantJids = getGroupParticipantJids(chat);
      const senderDigits = toDigits(getSenderId(message).split("@")[0] || "");
      const targets = (await resolveKickTargetsWithContext(message, parts, participantJids)).filter((jid) => {
        const targetDigits = toDigits(jid.split("@")[0] || "");
        return !senderDigits || senderDigits !== targetDigits;
      });
      if (!targets.length) {
        await message.reply(`Use: ${COMMAND_PREFIX}kick @user or reply to a user's message with ${COMMAND_PREFIX}kick`);
        return;
      }

      await chat.removeParticipants(targets);
      await message.reply(`Done. Removed ${targets.length} member(s).`);
    } catch (error) {
      await message.reply(`Failed to run ${activePrefix}${command}: ${getErrorText(error)}`);
      console.error("Group management command error:", error);
    }
    return;
  }

  if (command === "help") {
    await message.reply(getHelpText());
    return;
  }
  if (command === "mafia") {
    await handleMafiaCommand(client, message, parts);
    return;
  }
  if (command === "flag") {
    await handleFlagCommand(client, message, parts);
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

  const requestedAuthPath = process.env.LOCAL_AUTH_PATH || path.join(DATA_DIR, ".wwebjs_auth");
  let localAuthPath = path.resolve(requestedAuthPath);
  const dataDirResolved = path.resolve(DATA_DIR);
  const shouldForcePersistentAuth = String(process.env.FORCE_PERSISTENT_AUTH || "true").toLowerCase() !== "false";
  const pathStartsWithApp = localAuthPath === "/app" || localAuthPath.startsWith("/app/");
  const dataDirIsUsable = dataDirResolved === "/data" || dataDirResolved.startsWith("/data/");
  if (shouldForcePersistentAuth && pathStartsWithApp && dataDirIsUsable) {
    localAuthPath = path.join(dataDirResolved, ".wwebjs_auth");
    console.log(`LOCAL_AUTH_PATH remapped to persistent volume: ${localAuthPath}`);
  }
  const localAuthClientId = process.env.LOCAL_AUTH_CLIENT_ID || "default";
  await fs.mkdir(localAuthPath, { recursive: true });

  let attempts = 0;
  const maxRetries = Number.isFinite(WWEBJS_INIT_MAX_RETRIES) ? WWEBJS_INIT_MAX_RETRIES : 8;
  while (attempts < maxRetries) {
    attempts += 1;
    await cleanupChromiumProfileLocks(localAuthPath, localAuthClientId);
    botReady = false;
    latestQrText = null;

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: localAuthClientId,
        dataPath: localAuthPath,
      }),
      puppeteer: {
        headless: true,
        executablePath: puppeteer.executablePath(),
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
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
        console.error("Command error:", error);
      }
    });

    client.on("group_join", async (notification) => {
      try {
        await handleGroupJoin(client, notification);
      } catch (error) {
        console.error("group_join error:", error.message);
      }
    });

    try {
      await client.initialize();
      return;
    } catch (error) {
      const retryable = isRetryableInitializeError(error);
      const isLast = attempts >= maxRetries;
      console.error(`Initialize failed (attempt ${attempts}/${maxRetries}): ${getErrorText(error)}`);
      try {
        await client.destroy();
      } catch {}
      if (!retryable || isLast) {
        throw error;
      }
      const waitMs = WWEBJS_INIT_RETRY_DELAY_MS * attempts;
      console.log(`Retrying initialize in ${waitMs}ms...`);
      await delay(waitMs);
    }
  }
}

start().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
