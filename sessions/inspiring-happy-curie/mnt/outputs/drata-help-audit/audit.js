#!/usr/bin/env node
/**
 * Drata Help Center Audit
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches every published Intercom article, finds matching files in the Drata
 * GitHub repo, asks Claude to spot discrepancies, and checks every link.
 * Writes results to ./results/audit-YYYY-MM-DD.json
 *
 * Usage:
 *   node audit.js                 # run full audit
 *   node audit.js --dry-run       # fetch articles + GitHub matches, skip Claude
 *   node audit.js --limit 10      # only process first N articles (for testing)
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  intercom: {
    token: process.env.INTERCOM_TOKEN,
    // Filter to only published articles in your Help Center
    state: "published",
    perPage: 150, // max allowed by Intercom API
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER || "drata",
    repo: process.env.GITHUB_REPO, // e.g. "app" or "platform"
    // File extensions to pull content from
    extensions: [".md", ".mdx", ".ts", ".tsx", ".js", ".jsx", ".yaml", ".yml", ".json"],
    // Paths to EXCLUDE from matching (build artifacts, node_modules, etc.)
    excludePaths: ["node_modules", "dist", "build", ".next", "coverage", "__snapshots__"],
    // Max files to pull per article for comparison (keep costs down without skipping)
    maxFilesPerArticle: 8,
  },
  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: "claude-haiku-4-5-20251001", // fast + cheap; change to claude-sonnet-4-6 for higher accuracy
    maxTokens: 2048,
  },
  concurrency: 5,   // articles processed in parallel
  linkTimeout: 10000, // ms before a link check times out
  outputDir: path.join(__dirname, "results"),
  dryRun: process.argv.includes("--dry-run"),
  limit: (() => {
    const i = process.argv.indexOf("--limit");
    return i !== -1 ? parseInt(process.argv[i + 1], 10) : null;
  })(),
};

// ─── Utilities ───────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Generic HTTPS/HTTP request returning parsed JSON or raw text */
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers || {},
        timeout: options.timeout || 30000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (options.headOnly) return resolve({ status: res.statusCode, url });
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body), raw: body });
          } catch {
            resolve({ status: res.statusCode, body: null, raw: body });
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

/** Throttle: resolve at most `limit` promises at a time */
async function pLimit(tasks, limit) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** Strip HTML tags from Intercom article body */
function stripHtml(html) {
  return (html || "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract all HTTP/HTTPS URLs from HTML content */
function extractLinks(html) {
  const matches = (html || "").matchAll(/href=["']([^"']+)["']/gi);
  const urls = [];
  for (const m of matches) {
    const u = m[1];
    if (u.startsWith("http://") || u.startsWith("https://")) urls.push(u);
  }
  // Also catch plain text URLs
  const textMatches = (html || "").matchAll(/https?:\/\/[^\s<>"']+/g);
  for (const m of textMatches) urls.push(m[0]);
  return [...new Set(urls)];
}

/** Truncate string for API calls */
function truncate(str, maxLen) {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen) + "\n[...truncated]" : str;
}

// ─── Intercom ────────────────────────────────────────────────────────────────

async function fetchAllIntercomArticles() {
  log("Fetching all Intercom articles...");
  const articles = [];
  let page = 1;
  let totalPages = null;

  while (totalPages === null || page <= totalPages) {
    const res = await request(
      `https://api.intercom.io/articles?state=${CONFIG.intercom.state}&per_page=${CONFIG.intercom.perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${CONFIG.intercom.token}`,
          Accept: "application/json",
          "Intercom-Version": "2.10",
        },
      }
    );

    if (res.status !== 200) {
      throw new Error(`Intercom API error ${res.status}: ${res.raw}`);
    }

    const data = res.body;
    const pageArticles = data.data || [];
    articles.push(...pageArticles);

    if (totalPages === null) {
      totalPages = data.pages?.total_pages || 1;
      log(`  Found ${data.total_count} articles across ${totalPages} pages`);
    }

    log(`  Fetched page ${page}/${totalPages} (${pageArticles.length} articles)`);
    page++;

    if (page <= totalPages) await sleep(200); // gentle rate limiting
  }

  log(`Total articles fetched: ${articles.length}`);
  return articles;
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

/** Build a list of all repo files once (reused across all articles) */
async function fetchRepoFileTree() {
  log(`Fetching GitHub repo tree for ${CONFIG.github.owner}/${CONFIG.github.repo}...`);

  // Get default branch
  const repoRes = await request(
    `https://api.github.com/repos/${CONFIG.github.owner}/${CONFIG.github.repo}`,
    {
      headers: {
        Authorization: `token ${CONFIG.github.token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "drata-help-audit",
      },
    }
  );
  if (repoRes.status !== 200) throw new Error(`GitHub repo fetch error: ${repoRes.status}`);
  const defaultBranch = repoRes.body.default_branch || "main";

  // Fetch full recursive tree
  const treeRes = await request(
    `https://api.github.com/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/git/trees/${defaultBranch}?recursive=1`,
    {
      headers: {
        Authorization: `token ${CONFIG.github.token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "drata-help-audit",
      },
    }
  );
  if (treeRes.status !== 200) throw new Error(`GitHub tree fetch error: ${treeRes.status}`);

  const allFiles = (treeRes.body.tree || [])
    .filter((f) => f.type === "blob")
    .map((f) => f.path)
    .filter((p) => {
      // Must have a relevant extension
      const ext = path.extname(p).toLowerCase();
      if (!CONFIG.github.extensions.includes(ext)) return false;
      // Must not be in excluded paths
      for (const ex of CONFIG.github.excludePaths) {
        if (p.includes(ex)) return false;
      }
      return true;
    });

  log(`  Repo tree: ${allFiles.length} relevant files on branch '${defaultBranch}'`);
  return { files: allFiles, branch: defaultBranch };
}

/** Score how relevant a file path is to an article title (simple keyword match) */
function scoreRelevance(filePath, articleTitle, articleKeywords) {
  const lower = filePath.toLowerCase();
  let score = 0;
  for (const kw of articleKeywords) {
    if (lower.includes(kw)) score += 2;
  }
  // Bonus for docs/help folders
  if (lower.includes("doc") || lower.includes("help") || lower.includes("guide")) score += 1;
  return score;
}

/** Extract search keywords from article title */
function titleToKeywords(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !["with", "your", "from", "this", "that", "have", "will", "using", "when", "what", "how"].includes(w));
}

/** Fetch content of a specific file from GitHub */
async function fetchFileContent(filePath, branch) {
  const res = await request(
    `https://api.github.com/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/contents/${encodeURIComponent(filePath)}?ref=${branch}`,
    {
      headers: {
        Authorization: `token ${CONFIG.github.token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "drata-help-audit",
      },
    }
  );
  if (res.status !== 200) return null;
  if (res.body?.encoding === "base64") {
    return Buffer.from(res.body.content.replace(/\n/g, ""), "base64").toString("utf8");
  }
  return res.body?.content || null;
}

/** Find the most relevant GitHub files for a given article.
 *  Returns { files, noMatchReason } where noMatchReason is set when files is empty:
 *    "title_too_vague"    — couldn't extract any keywords from the title
 *    "no_path_match"      — keywords existed but zero repo files contained them
 *    "content_unreadable" — files matched by path but all content fetches failed
 */
async function findRelevantFiles(article, repoTree) {
  const keywords = titleToKeywords(article.title);
  if (keywords.length === 0) {
    return { files: [], noMatchReason: "title_too_vague" };
  }

  // Score and sort all repo files
  const scored = repoTree.files
    .map((f) => ({ path: f, score: scoreRelevance(f, article.title, keywords) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, CONFIG.github.maxFilesPerArticle);

  if (scored.length === 0) {
    return { files: [], noMatchReason: "no_path_match" };
  }

  // Fetch content for the top matches
  const contents = await Promise.all(
    scored.map(async (f) => {
      const content = await fetchFileContent(f.path, repoTree.branch);
      return content ? { path: f.path, score: f.score, content } : null;
    })
  );

  const files = contents.filter(Boolean);
  if (files.length === 0) {
    return { files: [], noMatchReason: "content_unreadable" };
  }

  return { files, noMatchReason: null };
}

// ─── Claude discrepancy + missing content detection ──────────────────────────

async function detectDiscrepancies(article, githubFiles) {
  if (CONFIG.dryRun || !CONFIG.claude.apiKey) {
    return { discrepancies: [], missingContent: [], skipped: true };
  }
  if (githubFiles.length === 0) {
    return { discrepancies: [], missingContent: [], noGithubMatch: true };
  }

  const articleText = truncate(stripHtml(article.body), 6000);
  const githubContext = githubFiles
    .map((f) => `=== FILE: ${f.path} ===\n${truncate(f.content, 2000)}`)
    .join("\n\n");

  const prompt = `You are auditing a software company's help center article against its codebase.

ARTICLE TITLE: ${article.title}
ARTICLE URL: ${article.url}

ARTICLE CONTENT:
${articleText}

GITHUB FILES (from the Drata codebase):
${githubContext}

Perform TWO types of analysis:

1. DISCREPANCIES — things the article says that are now WRONG or OUTDATED based on the code:
   - Feature names, UI labels, or menu paths that have changed
   - Settings or configuration options that no longer exist or have moved
   - Step-by-step instructions that don't match the current code
   - API endpoints, parameters, or responses that differ
   - Version numbers, requirements, or limits that differ

2. MISSING CONTENT — features or capabilities visible in the GitHub files that are NOT mentioned in the article at all, but clearly should be documented:
   - New features or options added to the code since the article was written
   - New configuration fields, flags, or settings not covered
   - New integration capabilities or supported values (e.g. extra providers, tiers, roles)
   - Enhancements that change how users should use the feature
   Only flag something as missing if it would genuinely matter to a user reading this article. Do not flag internal implementation details.

Respond ONLY with valid JSON in this exact format (use empty arrays if nothing found):
{
  "discrepancies": [
    {
      "field": "short label of what differs",
      "articleSays": "exact quote or description from the article",
      "githubSays": "what the GitHub file shows instead",
      "githubFile": "path/to/file.ts",
      "severity": "critical|high|medium|low",
      "explanation": "one sentence explaining why this matters to users"
    }
  ],
  "missingContent": [
    {
      "feature": "short name of the missing feature or capability",
      "githubEvidence": "the specific code, value, or constant that shows this exists",
      "githubFile": "path/to/file.ts",
      "suggestedAddition": "one or two sentences describing what the article should add",
      "priority": "high|medium|low"
    }
  ]
}`;

  const res = await request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": CONFIG.claude.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: {
      model: CONFIG.claude.model,
      max_tokens: CONFIG.claude.maxTokens,
      messages: [{ role: "user", content: prompt }],
    },
  });

  if (res.status !== 200) {
    log(`  Claude API error ${res.status} for article: ${article.title}`);
    return { discrepancies: [], missingContent: [], error: `Claude API ${res.status}` };
  }

  try {
    const text = res.body?.content?.[0]?.text || "{}";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { discrepancies: [], missingContent: [] };
    const parsed = JSON.parse(match[0]);
    return {
      discrepancies: parsed.discrepancies || [],
      missingContent: parsed.missingContent || [],
    };
  } catch (e) {
    return { discrepancies: [], missingContent: [], parseError: e.message };
  }
}

// ─── Link checking ───────────────────────────────────────────────────────────

async function checkLinks(article) {
  const links = extractLinks(article.body);
  if (links.length === 0) return [];

  const results = await pLimit(
    links.map((url) => async () => {
      try {
        const res = await request(url, {
          method: "HEAD",
          headOnly: true,
          timeout: CONFIG.linkTimeout,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Drata-HelpAudit/1.0)",
          },
        });
        return {
          url,
          status: res.status,
          ok: res.status >= 200 && res.status < 400,
          broken: res.status >= 400 || res.status === 0,
        };
      } catch (err) {
        return { url, status: 0, ok: false, broken: true, error: err.message };
      }
    }),
    8 // parallel link checks
  );

  return results.filter((r) => r.broken);
}

// ─── Main audit loop ──────────────────────────────────────────────────────────

async function auditArticle(article, repoTree, index, total) {
  log(`[${index + 1}/${total}] ${article.title}`);

  const result = {
    id: article.id,
    title: article.title,
    url: article.url,
    updatedAt: article.updated_at,
    githubFilesChecked: [],
    discrepancies: [],
    missingContent: [],
    brokenLinks: [],
    status: "ok", // ok | discrepancies | broken_links | missing_content | multiple | no_github_match | error
    noGithubMatchReason: null, // title_too_vague | no_path_match | content_unreadable
    auditedAt: new Date().toISOString(),
  };

  try {
    // 1. Find relevant GitHub files
    const { files: githubFiles, noMatchReason } = await findRelevantFiles(article, repoTree);
    result.githubFilesChecked = githubFiles.map((f) => f.path);
    if (noMatchReason) result.noGithubMatchReason = noMatchReason;

    // 2. Detect discrepancies + missing content
    const disc = await detectDiscrepancies(article, githubFiles);
    result.discrepancies = disc.discrepancies || [];
    result.missingContent = disc.missingContent || [];
    if (disc.noGithubMatch) result.status = "no_github_match";
    if (noMatchReason && result.status === "ok") result.status = "no_github_match";
    if (disc.error) result.error = disc.error;

    // 3. Check links
    result.brokenLinks = await checkLinks(article);

    // Determine status (flags all issue types found)
    const hasDisc    = result.discrepancies.length > 0;
    const hasMissing = result.missingContent.length > 0;
    const hasLinks   = result.brokenLinks.length > 0;
    const issueCount = [hasDisc, hasMissing, hasLinks].filter(Boolean).length;

    if (result.status !== "no_github_match") {
      if (issueCount > 1)   result.status = "multiple";
      else if (hasDisc)     result.status = "discrepancies";
      else if (hasMissing)  result.status = "missing_content";
      else if (hasLinks)    result.status = "broken_links";
      else                  result.status = "ok";
    }
  } catch (err) {
    result.status = "error";
    result.error = err.message;
    log(`  ERROR: ${err.message}`);
  }

  return result;
}

async function run() {
  // Validate required env vars
  const missing = [];
  if (!CONFIG.intercom.token) missing.push("INTERCOM_TOKEN");
  if (!CONFIG.github.token) missing.push("GITHUB_TOKEN");
  if (!CONFIG.github.repo) missing.push("GITHUB_REPO");
  if (!CONFIG.claude.apiKey && !CONFIG.dryRun) missing.push("ANTHROPIC_API_KEY");
  if (missing.length) {
    log(`ERROR: Missing required environment variables: ${missing.join(", ")}`);
    log("Copy .env.example to .env and fill in your tokens.");
    process.exit(1);
  }

  // Ensure output dir exists
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  const startTime = Date.now();
  log(`=== Drata Help Center Audit ${CONFIG.dryRun ? "[DRY RUN] " : ""}===`);
  log(`Target repo: ${CONFIG.github.owner}/${CONFIG.github.repo}`);
  log(`Claude model: ${CONFIG.claude.model}`);

  // Fetch articles
  let articles = await fetchAllIntercomArticles();
  if (CONFIG.limit) {
    log(`--limit flag: processing first ${CONFIG.limit} articles only`);
    articles = articles.slice(0, CONFIG.limit);
  }

  // Fetch GitHub tree (once for all articles)
  const repoTree = await fetchRepoFileTree();

  // Audit all articles with concurrency control
  log(`\nAuditing ${articles.length} articles (${CONFIG.concurrency} concurrent)...`);
  const tasks = articles.map((article, i) => () =>
    auditArticle(article, repoTree, i, articles.length)
  );
  const results = await pLimit(tasks, CONFIG.concurrency);

  // Summary stats
  const summary = {
    auditDate: new Date().toISOString().split("T")[0],
    totalArticles: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    withDiscrepancies: results.filter((r) => ["discrepancies", "multiple"].includes(r.status)).length,
    withMissingContent: results.filter((r) => ["missing_content", "multiple"].includes(r.status) || r.missingContent?.length > 0).length,
    withBrokenLinks: results.filter((r) => ["broken_links", "multiple"].includes(r.status)).length,
    noGithubMatch: results.filter((r) => r.status === "no_github_match").length,
    errors: results.filter((r) => r.status === "error").length,
    totalDiscrepancies: results.reduce((n, r) => n + r.discrepancies.length, 0),
    totalMissingContent: results.reduce((n, r) => n + (r.missingContent?.length || 0), 0),
    totalBrokenLinks: results.reduce((n, r) => n + r.brokenLinks.length, 0),
    criticalDiscrepancies: results.reduce(
      (n, r) => n + r.discrepancies.filter((d) => d.severity === "critical").length,
      0
    ),
    durationSeconds: Math.round((Date.now() - startTime) / 1000),
  };

  const output = { summary, articles: results };
  const outFile = path.join(CONFIG.outputDir, `audit-${summary.auditDate}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  log("\n=== AUDIT COMPLETE ===");
  log(`  Articles: ${summary.totalArticles}`);
  log(`  OK: ${summary.ok}`);
  log(`  With discrepancies: ${summary.withDiscrepancies} (${summary.totalDiscrepancies} total, ${summary.criticalDiscrepancies} critical)`);
  log(`  Missing content: ${summary.withMissingContent} articles (${summary.totalMissingContent} gaps found)`);
  log(`  Broken links: ${summary.withBrokenLinks} articles (${summary.totalBrokenLinks} links)`);
  log(`  No GitHub match: ${summary.noGithubMatch}`);
  log(`  Errors: ${summary.errors}`);
  log(`  Duration: ${summary.durationSeconds}s`);
  log(`  Results saved to: ${outFile}`);

  // Write a "latest" symlink/copy for the dashboard
  const latestFile = path.join(CONFIG.outputDir, "latest.json");
  fs.copyFileSync(outFile, latestFile);
  log(`  Latest results: ${latestFile}`);
}

run().catch((err) => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
});
