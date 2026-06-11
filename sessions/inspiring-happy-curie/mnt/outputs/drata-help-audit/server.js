#!/usr/bin/env node
/**
 * Drata Help Audit — Local Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Serves the dashboard and provides API endpoints so the Run button works.
 *
 * Usage:
 *   node server.js          # starts on http://localhost:3000
 *   PORT=8080 node server.js
 *
 * Endpoints:
 *   GET  /                    → dashboard.html
 *   GET  /results/latest.json → latest audit results
 *   POST /api/run             → start the audit (if not already running)
 *   GET  /api/status          → { running, startedAt, progress, lastLog }
 *   GET  /api/logs            → last 200 lines of current/last run log
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ─── State ───────────────────────────────────────────────────────────────────

let auditProcess = null;
let auditRunning = false;
let auditStartedAt = null;
let auditLogs = [];       // rolling buffer of last 500 lines
let auditProgress = 0;    // 0-100 estimate based on log lines

function appendLog(line) {
  auditLogs.push({ t: Date.now(), line });
  if (auditLogs.length > 500) auditLogs.shift();

  // Rough progress from log output: "[N/925]" pattern
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

// ─── Request handler ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── CORS for local dev ──
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── API routes ──────────────────────────────────────────────────────────

  // POST /api/run — kick off audit.js
  if (pathname === "/api/run" && req.method === "POST") {
    if (auditRunning) {
      json(res, 409, { error: "Audit already running", startedAt: auditStartedAt });
      return;
    }

    auditLogs = [];
    auditProgress = 0;
    auditRunning = true;
    auditStartedAt = new Date().toISOString();

    // Parse optional body for --limit flag
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let opts = {};
      try { opts = JSON.parse(body); } catch {}

      const args = ["audit.js"];
      if (opts.limit) args.push("--limit", String(opts.limit));
      if (opts.dryRun) args.push("--dry-run");

      appendLog(`[server] Starting audit: node ${args.join(" ")}`);

      auditProcess = spawn("node", args, {
        cwd: ROOT,
        env: { ...process.env },
      });

      auditProcess.stdout.on("data", (d) => {
        String(d).split("\n").filter(Boolean).forEach(appendLog);
      });
      auditProcess.stderr.on("data", (d) => {
        String(d).split("\n").filter(Boolean).forEach((l) => appendLog("[stderr] " + l));
      });
      auditProcess.on("close", (code) => {
        auditRunning = false;
        auditProgress = code === 0 ? 100 : auditProgress;
        appendLog(`[server] Audit finished with exit code ${code}`);
      });
      auditProcess.on("error", (err) => {
        auditRunning = false;
        appendLog(`[server] Failed to start audit: ${err.message}`);
      });

      json(res, 200, { started: true, startedAt: auditStartedAt });
    });
    return;
  }

  // GET /api/status
  if (pathname === "/api/status" && req.method === "GET") {
    const lastLog = auditLogs.length ? auditLogs[auditLogs.length - 1].line : null;
    json(res, 200, {
      running: auditRunning,
      startedAt: auditStartedAt,
      progress: auditProgress,
      lastLog,
    });
    return;
  }

  // GET /api/logs
  if (pathname === "/api/logs" && req.method === "GET") {
    json(res, 200, { logs: auditLogs.slice(-200) });
    return;
  }

  // ── Static files ─────────────────────────────────────────────────────────

  // Map / → dashboard.html
  let filePath = pathname === "/" ? "/dashboard.html" : pathname;
  filePath = path.join(ROOT, filePath);

  // Security: don't serve files outside ROOT
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
