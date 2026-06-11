#!/usr/bin/env node
/**
 * Drata Help Audit — Local Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Serves the dashboard and provides API endpoints so run buttons work.
 *
 * Usage:
 *   node server.js          # starts on http://localhost:3000
 *   PORT=8080 node server.js
 *
 * Endpoints:
 *   GET  /                           → dashboard.html
 *   GET  /results/latest.json        → latest audit results
 *   POST /api/run                    → full audit
 *   POST /api/run/links              → broken link check only
 *   POST /api/run/third-party        → 3rd-party terminology check only
 *   POST /api/run/grammar            → grammar check only
 *   POST /api/run/clean              → full re-audit on currently-clean articles
 *   POST /api/run/contradictions     → cross-article contradiction check only
 *   GET  /api/status                 → { running, activeCheck, checkState, progress }
 *   GET  /api/logs                   → last 200 log lines
 */

// Load .env so INTERCOM_TOKEN etc. are available for API calls
try { require("dotenv").config(); } catch {}

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ─── State ───────────────────────────────────────────────────────────────────

// Per-check state: tracks running status + last completed time for each check type
const CHECK_TYPES = ["full", "links", "third-party", "grammar", "clean", "contradictions"];

const checkState = Object.fromEntries(
  CHECK_TYPES.map(t => [t, { running: false, startedAt: null, lastRunAt: null }])
);

let auditProcess  = null;
let auditLogs     = [];   // rolling buffer of last 500 lines
let auditProgress = 0;    // 0–100 estimate

function isAnyRunning() {
  return CHECK_TYPES.some(t => checkState[t].running);
}

function appendLog(line) {
  auditLogs.push({ t: Date.now(), line });
  if (auditLogs.length > 500) auditLogs.shift();

  // Rough progress from "[N/total]" log pattern
  const m = line.match(/\[(\d+)\/(\d+)\]/);
  if (m) auditProgress = Math.round((parseInt(m[1]) / parseInt(m[2])) * 100);
}

// ─── MIME types ──────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".css":  "text/css",
  ".ico":  "image/x-icon",
};

// ─── Check runner ─────────────────────────────────────────────────────────────

function handleRunCheck(checkType, req, res) {
  if (isAnyRunning()) {
    const active = CHECK_TYPES.find(t => checkState[t].running) || "unknown";
    json(res, 409, { error: `'${active}' is already running`, activeCheck: active });
    return;
  }

  auditLogs     = [];
  auditProgress = 0;
  checkState[checkType].running   = true;
  checkState[checkType].startedAt = new Date().toISOString();

  let body = "";
  req.on("data", d => (body += d));
  req.on("end", () => {
    let opts = {};
    try { opts = JSON.parse(body); } catch {}

    // Build args for audit.js
    const args = ["audit.js"];
    if (checkType !== "full") args.push("--check", checkType);
    if (opts.limit) args.push("--limit", String(opts.limit));
    if (opts.collection) args.push("--collection", String(opts.collection));
    if (opts.dryRun) args.push("--dry-run");

    appendLog(`[server] Starting '${checkType}': node ${args.join(" ")}`);

    auditProcess = spawn("node", args, {
      cwd: ROOT,
      env: { ...process.env },
    });

    auditProcess.stdout.on("data", d => {
      String(d).split("\n").filter(Boolean).forEach(appendLog);
    });
    auditProcess.stderr.on("data", d => {
      String(d).split("\n").filter(Boolean).forEach(l => appendLog("[stderr] " + l));
    });
    auditProcess.on("close", code => {
      checkState[checkType].running   = false;
      checkState[checkType].lastRunAt = new Date().toISOString();
      auditProgress = code === 0 ? 100 : auditProgress;
      appendLog(`[server] '${checkType}' finished with exit code ${code}`);
    });
    auditProcess.on("error", err => {
      checkState[checkType].running = false;
      appendLog(`[server] Failed to start '${checkType}': ${err.message}`);
    });

    json(res, 200, { started: true, checkType, startedAt: checkState[checkType].startedAt });
  });
}

// ─── Request handler ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url      = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── CORS for local dev ──
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── Run routes ──────────────────────────────────────────────────────────

  if (pathname === "/api/run"                && req.method === "POST") { handleRunCheck("full",           req, res); return; }
  if (pathname === "/api/run/links"          && req.method === "POST") { handleRunCheck("links",          req, res); return; }
  if (pathname === "/api/run/third-party"    && req.method === "POST") { handleRunCheck("third-party",    req, res); return; }
  if (pathname === "/api/run/grammar"        && req.method === "POST") { handleRunCheck("grammar",        req, res); return; }
  if (pathname === "/api/run/clean"          && req.method === "POST") { handleRunCheck("clean",          req, res); return; }
  if (pathname === "/api/run/contradictions" && req.method === "POST") { handleRunCheck("contradictions", req, res); return; }

  // ── Status & logs ───────────────────────────────────────────────────────

  if (pathname === "/api/status" && req.method === "GET") {
    const activeCheck = CHECK_TYPES.find(t => checkState[t].running) || null;

    // Also read checkLastRun from latest.json so timestamps persist across server restarts
    let persistedLastRun = {};
    try {
      const latest = JSON.parse(fs.readFileSync(path.join(ROOT, "results", "latest.json"), "utf8"));
      persistedLastRun = latest.summary?.checkLastRun || {};
    } catch {}

    // Merge: in-memory lastRunAt takes priority over file (it's fresher)
    const mergedState = {};
    for (const t of CHECK_TYPES) {
      mergedState[t] = {
        ...checkState[t],
        lastRunAt: checkState[t].lastRunAt || persistedLastRun[t] || null,
      };
    }

    json(res, 200, {
      running:     isAnyRunning(),
      activeCheck,
      checkState:  mergedState,
      progress:    auditProgress,
      lastLog:     auditLogs.length ? auditLogs[auditLogs.length - 1].line : null,
    });
    return;
  }

  if (pathname === "/api/logs" && req.method === "GET") {
    json(res, 200, { logs: auditLogs.slice(-200) });
    return;
  }

  // ── History ──────────────────────────────────────────────────────────────

  if (pathname === "/api/history" && req.method === "GET") {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(ROOT, "results", "history.json"), "utf8"));
      json(res, 200, { history: data });
    } catch {
      json(res, 200, { history: [] });
    }
    return;
  }

  // ── Ignored articles ──────────────────────────────────────────────────────

  const ignoredFile = path.join(ROOT, "results", "ignored.json");

  function readIgnored() {
    try { return JSON.parse(fs.readFileSync(ignoredFile, "utf8")); } catch { return []; }
  }
  function writeIgnored(list) {
    fs.mkdirSync(path.dirname(ignoredFile), { recursive: true });
    fs.writeFileSync(ignoredFile, JSON.stringify(list, null, 2));
  }

  if (pathname === "/api/ignored" && req.method === "GET") {
    json(res, 200, { ignored: readIgnored() });
    return;
  }

  if (pathname === "/api/ignored" && req.method === "POST") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      try {
        const { id, title } = JSON.parse(body);
        if (!id) { json(res, 400, { error: "id required" }); return; }
        const list = readIgnored().filter(e => String(e.id) !== String(id));
        list.push({ id: String(id), title: title || "", ignoredAt: new Date().toISOString() });
        writeIgnored(list);
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }

  if (pathname.startsWith("/api/ignored/") && req.method === "DELETE") {
    const id = decodeURIComponent(pathname.split("/api/ignored/")[1]);
    writeIgnored(readIgnored().filter(e => String(e.id) !== String(id)));
    json(res, 200, { ok: true });
    return;
  }

  // ── Feedback ──────────────────────────────────────────────────────────────

  const feedbackFile = path.join(ROOT, "results", "feedback.json");

  function readFeedback() {
    try { return JSON.parse(fs.readFileSync(feedbackFile, "utf8")); } catch { return []; }
  }
  function writeFeedback(list) {
    fs.mkdirSync(path.dirname(feedbackFile), { recursive: true });
    fs.writeFileSync(feedbackFile, JSON.stringify(list, null, 2));
  }

  if (pathname === "/api/feedback" && req.method === "GET") {
    json(res, 200, { feedback: readFeedback() });
    return;
  }

  if (pathname === "/api/feedback" && req.method === "POST") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      try {
        const { text } = JSON.parse(body);
        if (!text?.trim()) { json(res, 400, { error: "text required" }); return; }
        const list = readFeedback();
        const entry = {
          id: Date.now().toString(),
          text: text.trim(),
          createdAt: new Date().toISOString(),
          resolved: false,
        };
        list.push(entry);
        writeFeedback(list);
        json(res, 200, { ok: true, entry });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }

  if (pathname.startsWith("/api/feedback/") && req.method === "PATCH") {
    const id = decodeURIComponent(pathname.split("/api/feedback/")[1]);
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      try {
        const updates = JSON.parse(body);
        writeFeedback(readFeedback().map(e => String(e.id) === String(id) ? { ...e, ...updates } : e));
        json(res, 200, { ok: true });
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    return;
  }

  if (pathname.startsWith("/api/feedback/") && req.method === "DELETE") {
    const id = decodeURIComponent(pathname.split("/api/feedback/")[1]);
    writeFeedback(readFeedback().filter(e => String(e.id) !== String(id)));
    json(res, 200, { ok: true });
    return;
  }

  // ── Replace Term — apply changes to Intercom ─────────────────────────────

  if (pathname === "/api/terms/apply" && req.method === "POST") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", async () => {
      try {
        const { articleId, newBody } = JSON.parse(body);
        if (!articleId || newBody === undefined) {
          json(res, 400, { error: "articleId and newBody required" });
          return;
        }
        const token = process.env.INTERCOM_TOKEN;
        if (!token) {
          json(res, 500, { error: "INTERCOM_TOKEN not set in .env" });
          return;
        }
        // Call Intercom API to update the article body
        const result = await new Promise((resolve, reject) => {
          const payload = JSON.stringify({ body: newBody });
          const reqOut = https.request({
            hostname: "api.intercom.io",
            path: `/articles/${articleId}`,
            method: "PUT",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              "Content-Type": "application/json",
              "Intercom-Version": "2.10",
              "Content-Length": Buffer.byteLength(payload),
            },
          }, (r) => {
            let data = "";
            r.on("data", c => (data += c));
            r.on("end", () => resolve({ status: r.statusCode, body: data }));
          });
          reqOut.on("error", reject);
          reqOut.write(payload);
          reqOut.end();
        });
        if (result.status >= 200 && result.status < 300) {
          json(res, 200, { ok: true, articleId });
        } else {
          json(res, result.status, { error: `Intercom API ${result.status}`, detail: result.body });
        }
      } catch (e) {
        json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // ── Static files ─────────────────────────────────────────────────────────

  let filePath = pathname === "/" ? "/dashboard.html" : pathname;
  filePath = path.join(ROOT, filePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found: " + pathname);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, () => {
  console.log(`\n✅ Dashboard running at http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop.\n`);
});
