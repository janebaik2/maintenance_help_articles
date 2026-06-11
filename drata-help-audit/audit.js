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
  // --collection "name": only process articles in the named collection (case-insensitive partial match)
  collection: (() => {
    const i = process.argv.indexOf("--collection");
    return i !== -1 ? process.argv[i + 1] : null;
  })(),
  // --check <type>: run only a targeted check and merge into latest.json
  // valid types: links | third-party | grammar | clean | contradictions
  check: (() => {
    const i = process.argv.indexOf("--check");
    return i !== -1 ? process.argv[i + 1] : null;
  })(),
};

// ─── Collections never to audit (permanent skip) ─────────────────────────────
const SKIP_COLLECTION_PATTERNS = [
  /training videos/i,
  /video/i,  // any collection whose name contains "video"
];

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

/**
 * Fetch all Help Center collections and sections from Intercom.
 * Returns { collectionMap, sectionToCollection }
 *   collectionMap: Map<collectionId, collectionName>
 *   sectionToCollection: Map<sectionId, collectionId>
 */
async function fetchIntercomCollections() {
  const headers = {
    Authorization: `Bearer ${CONFIG.intercom.token}`,
    Accept: "application/json",
    "Intercom-Version": "2.10",
  };

  const collectionMap = new Map(); // id → name
  const sectionToCollection = new Map(); // section_id → collection_id

  // Fetch collections (paginated)
  let page = 1;
  while (true) {
    const res = await request(
      `https://api.intercom.io/help_center/collections?per_page=150&page=${page}`,
      { headers }
    );
    if (res.status !== 200) { log(`  Collections API ${res.status} — skipping collection filter`); break; }
    const data = res.body;
    for (const c of (data.data || [])) collectionMap.set(String(c.id), c.name || "");
    if (!data.pages?.next) break;
    page++;
    await sleep(150);
  }

  // Fetch sections (so articles in sub-sections can be matched to their parent collection)
  page = 1;
  while (true) {
    const res = await request(
      `https://api.intercom.io/help_center/sections?per_page=150&page=${page}`,
      { headers }
    );
    if (res.status !== 200) break;
    const data = res.body;
    for (const s of (data.data || [])) {
      if (s.parent_id) sectionToCollection.set(String(s.id), String(s.parent_id));
    }
    if (!data.pages?.next) break;
    page++;
    await sleep(150);
  }

  log(`  Collections fetched: ${collectionMap.size} collections, ${sectionToCollection.size} sections`);
  return { collectionMap, sectionToCollection };
}

/**
 * Determine the root collection name for an article.
 * article.parent_type = "collection" | "section" | null
 */
function articleCollectionName(article, collectionMap, sectionToCollection) {
  const pid = String(article.parent_id || "");
  const ptype = article.parent_type || "";
  if (!pid || pid === "null") return null;
  if (ptype === "collection") return collectionMap.get(pid) || null;
  if (ptype === "section") {
    const collId = sectionToCollection.get(pid);
    return collId ? (collectionMap.get(collId) || null) : null;
  }
  return null;
}

/**
 * Filter articles: remove permanently-skipped collections (video etc.)
 * and apply --collection filter if set.
 * Returns { filtered, skippedVideoCount }
 */
function applyCollectionFilters(articles, collectionMap, sectionToCollection) {
  let filtered = articles;
  let skippedVideoCount = 0;

  // 1. Remove permanently-skipped collections (Training Videos etc.) + body video embeds
  filtered = filtered.filter(a => {
    const colName = articleCollectionName(a, collectionMap, sectionToCollection) || "";
    if (SKIP_COLLECTION_PATTERNS.some(p => p.test(colName))) { skippedVideoCount++; return false; }
    // Also skip articles whose body contains embedded video iframes (YouTube, Wistia, Loom etc.)
    const body = (a.body || "").toLowerCase();
    if (/<iframe[^>]*(youtube|wistia|loom|vimeo|vidyard)[^>]*>/i.test(a.body || "")) {
      skippedVideoCount++; return false;
    }
    return true;
  });

  // 2. Apply --collection filter
  if (CONFIG.collection) {
    const needle = CONFIG.collection.toLowerCase();
    const before = filtered.length;
    filtered = filtered.filter(a => {
      const colName = articleCollectionName(a, collectionMap, sectionToCollection) || "";
      return colName.toLowerCase().includes(needle);
    });
    log(`  Collection filter "${CONFIG.collection}": ${filtered.length} of ${before} articles match`);
  }

  return { filtered, skippedVideoCount };
}

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

/**
 * Score a file path against title keywords (weight 3) and body keywords (weight 1).
 * Optionally score against file content too (weight 2 per body keyword hit in content).
 */
function scoreRelevance(filePath, titleKeywords, bodyKeywords, fileContent) {
  const lowerPath = filePath.toLowerCase();
  let score = 0;

  for (const kw of titleKeywords) {
    if (lowerPath.includes(kw)) score += 3;
  }
  for (const kw of bodyKeywords) {
    if (lowerPath.includes(kw)) score += 1;
  }

  // If we have file content, reward body keywords found inside the file
  if (fileContent) {
    const lowerContent = fileContent.toLowerCase();
    for (const kw of bodyKeywords) {
      if (lowerContent.includes(kw)) score += 2;
    }
    // Extra bump for title keywords found in content too
    for (const kw of titleKeywords) {
      if (lowerContent.includes(kw)) score += 1;
    }
  }

  // Small bonus for docs/help folders
  if (lowerPath.includes("doc") || lowerPath.includes("help") || lowerPath.includes("guide")) score += 1;

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

/**
 * Extract technical keywords from article body HTML.
 * Prioritises terms from <code>/<pre> blocks, then scans plain text for:
 *  - camelCase / PascalCase identifiers  (e.g. enableJitProvisioning, SCIMAPIScope)
 *  - ALL_CAPS acronyms ≥ 3 chars         (e.g. SCIM, SAML, MFA, SSO)
 *  - snake_case / kebab-case tokens      (e.g. scim_oauth_client, redirect_uri)
 *  - Drata-specific UI terms             (e.g. workspace, controls, drawer)
 * Returns up to 40 lowercase keywords ranked by frequency.
 */
function bodyToKeywords(html) {
  if (!html) return [];

  const STOPWORDS = new Set([
    "with","your","from","this","that","have","will","using","when","what","into",
    "which","only","also","each","used","more","page","next","step","click","open",
    "note","make","sure","data","user","users","admin","role","roles","type","name",
    "list","able","been","they","their","then","these","some","here","section",
    "select","settings","setting","please","added","follow","below","above","after",
    "before","under","where","should","would","could","must","need","once","just",
  ]);

  // Pull text from <code>/<pre> blocks first (highest signal)
  const codeText = [];
  for (const m of (html.matchAll(/<(?:code|pre)[^>]*>([\s\S]*?)<\/(?:code|pre)>/gi))) {
    codeText.push(m[1].replace(/<[^>]+>/g, " "));
  }

  const plain = stripHtml(html);
  const allText = codeText.join(" ") + " " + plain;

  const terms = [];

  // camelCase / PascalCase  (e.g. enableJitProvisioning, companyProducts)
  for (const m of (allText.matchAll(/\b[a-z][a-zA-Z0-9]{4,}\b/g))) terms.push(m[0].toLowerCase());

  // ALL_CAPS acronyms ≥ 3 chars  (SCIM, SAML, SSO, MFA, JIT, IAM …)
  for (const m of (allText.matchAll(/\b[A-Z]{3,}\b/g))) terms.push(m[0].toLowerCase());

  // snake_case / kebab-case identifiers  (redirect_uri, scim_oauth_client)
  for (const m of (allText.matchAll(/\b[a-z][a-z0-9]+[_-][a-z0-9_-]{2,}\b/g))) terms.push(m[0].toLowerCase());

  // Quoted navigation paths  ("Settings > Workspaces > Edit" → workspace, workspaces)
  for (const m of (plain.matchAll(/Settings\s*[>→]\s*([A-Za-z\s]+?)(?:\s*[>→]|[.,"']|$)/g))) {
    for (const w of m[1].toLowerCase().split(/\s+/)) {
      if (w.length > 3) terms.push(w);
    }
  }

  // Rank by frequency, filter stopwords, return top 40
  const freq = {};
  for (const t of terms) {
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    freq[t] = (freq[t] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([w]) => w);
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

/**
 * Find the most relevant GitHub files for a given article.
 *
 * Pass 1 — path matching:
 *   Score every file by how many title + body keywords appear in its path.
 *   Fetch content for the top candidates and re-score with content hits.
 *
 * Pass 2 — content search (only if Pass 1 finds nothing):
 *   Sample a broader set of files whose paths contain ANY body keyword,
 *   fetch their content, and score by content keyword density.
 *   This catches cases like the logo-in-workspaces bug where the relevant
 *   code lives in a file whose path gives no hint (e.g. branding.ts).
 *
 * Returns { files, noMatchReason } where noMatchReason is set when files is []:
 *   "title_too_vague"    — no keywords could be extracted at all
 *   "no_path_match"      — keywords exist but zero files matched even after pass 2
 *   "content_unreadable" — files found but all content fetches failed
 */
async function findRelevantFiles(article, repoTree) {
  const titleKws  = titleToKeywords(article.title);
  const bodyKws   = bodyToKeywords(article.body);
  const allKws    = [...new Set([...titleKws, ...bodyKws])];

  if (allKws.length === 0) {
    return { files: [], noMatchReason: "title_too_vague" };
  }

  // ── Pass 1: path-based scoring ──────────────────────────────────────────────
  const pass1 = repoTree.files
    .map((f) => ({ path: f, score: scoreRelevance(f, titleKws, bodyKws, null) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, CONFIG.github.maxFilesPerArticle * 2); // fetch extra to re-rank by content

  if (pass1.length > 0) {
    // Fetch content for candidates and re-score with content hits
    const withContent = await Promise.all(
      pass1.map(async (f) => {
        const content = await fetchFileContent(f.path, repoTree.branch);
        if (!content) return null;
        const finalScore = scoreRelevance(f.path, titleKws, bodyKws, content);
        return { path: f.path, score: finalScore, content };
      })
    );
    const ranked = withContent
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, CONFIG.github.maxFilesPerArticle);

    if (ranked.length > 0) return { files: ranked, noMatchReason: null };
  }

  // ── Pass 2: content search for hard-to-match articles ──────────────────────
  // Take up to 40 files whose path contains at least one body keyword,
  // fetch their content, and find which ones actually contain article terms.
  if (bodyKws.length === 0) {
    return { files: [], noMatchReason: titleKws.length > 0 ? "no_path_match" : "title_too_vague" };
  }

  const pass2Candidates = repoTree.files
    .filter((f) => {
      const lower = f.toLowerCase();
      return bodyKws.some((kw) => lower.includes(kw));
    })
    .slice(0, 40);

  if (pass2Candidates.length === 0) {
    return { files: [], noMatchReason: "no_path_match" };
  }

  const pass2 = await Promise.all(
    pass2Candidates.map(async (f) => {
      const content = await fetchFileContent(f, repoTree.branch);
      if (!content) return null;
      const score = scoreRelevance(f, titleKws, bodyKws, content);
      return score > 0 ? { path: f, score, content } : null;
    })
  );

  const pass2Ranked = pass2
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, CONFIG.github.maxFilesPerArticle);

  if (pass2Ranked.length === 0) {
    return { files: [], noMatchReason: "no_path_match" };
  }

  // Mark these as pass-2 matches so the dashboard can show a lower-confidence indicator
  return { files: pass2Ranked, noMatchReason: null, pass2Match: true };
}

// ─── Cross-article contradiction detection ────────────────────────────────────

/**
 * Generic terms that appear in almost every article title and carry no
 * topic signal — filtering these out makes clusters tight and meaningful.
 */
const CLUSTER_STOPWORDS = new Set([
  "drata","help","center","guide","overview","setup","configure","configuration",
  "setting","settings","using","your","with","how","what","when","where","about",
  "more","learn","step","steps","page","section","feature","option","enable",
  "manage","managing","update","create","adding","remove","delete","connect",
  "connecting","account","user","users","admin","integration","article","getting",
  "started","introduction","understanding","work","works","working","first","use",
  "access","view","edit","save","apply","open","close","find","need","want",
]);

/**
 * Group articles into topic clusters using keyword overlap.
 * Two articles are "related" if they share ≥2 meaningful title keywords,
 * OR ≥1 title keyword + ≥2 cross-overlaps with each other's body keywords.
 * Uses union-find so transitive relationships form one cluster.
 *
 * @param {Array} articles - raw Intercom articles (must have .id, .title, .body)
 * @returns {Array<string[]>} - array of clusters, each cluster is an array of article IDs
 */
function buildTopicClusters(articles) {
  const meta = articles.map(a => {
    const titleKws = titleToKeywords(a.title).filter(kw => !CLUSTER_STOPWORDS.has(kw));
    const bodyKws  = bodyToKeywords(a.body).slice(0, 15).filter(kw => !CLUSTER_STOPWORDS.has(kw));
    return { id: String(a.id), titleKws, bodyKwSet: new Set(bodyKws) };
  });

  // Union-Find
  const parent = new Map();
  const find = id => {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)));
    return parent.get(id);
  };
  const union = (a, b) => { parent.set(find(a), find(b)); };

  for (let i = 0; i < meta.length; i++) {
    const a = meta[i];
    if (a.titleKws.length === 0) continue;

    for (let j = i + 1; j < meta.length; j++) {
      const b = meta[j];
      if (b.titleKws.length === 0) continue;

      const sharedTitle = a.titleKws.filter(kw => b.titleKws.includes(kw)).length;
      // Cross-overlap: a's title kws in b's body, or b's title kws in a's body
      const sharedCross = a.titleKws.filter(kw => b.bodyKwSet.has(kw)).length
                        + b.titleKws.filter(kw => a.bodyKwSet.has(kw)).length;

      if (sharedTitle >= 2 || (sharedTitle >= 1 && sharedCross >= 2)) {
        union(a.id, b.id);
      }
    }
  }

  const clusters = new Map();
  for (const a of meta) {
    const root = find(a.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(a.id);
  }

  return [...clusters.values()].filter(c => c.length >= 2);
}

/**
 * For each topic cluster, ask Claude whether any articles contradict each other
 * on specific facts (navigation paths, role names, option lists, step sequences).
 * Caps each batch at 8 articles to stay within token limits.
 *
 * @param {Array<string[]>} clusters - output of buildTopicClusters()
 * @param {Array} articles           - raw Intercom articles
 * @returns {Array} - flat list of contradiction objects
 */
async function detectContradictions(clusters, articles) {
  if (CONFIG.dryRun || !CONFIG.claude.apiKey) return [];

  const articleMap = new Map(articles.map(a => [String(a.id), a]));
  const all = [];

  log(`\nContradiction check: ${clusters.length} topic clusters to scan`);

  for (let ci = 0; ci < clusters.length; ci++) {
    const ids = clusters[ci].slice(0, 8); // cap per-batch
    const batch = ids.map(id => articleMap.get(id)).filter(Boolean);
    if (batch.length < 2) continue;

    log(`  Cluster ${ci + 1}/${clusters.length}: ${batch.length} articles — "${batch.map(a => a.title).join('", "')}"`);

    const summaries = batch.map((a, i) =>
      `[${i + 1}] "${a.title}"\n${a.url}\n${truncate(stripHtml(a.body), 700)}`
    ).join("\n\n---\n\n");

    const prompt = `You are checking a Drata help center for contradictions between related articles.

Find any SPECIFIC factual contradictions — cases where two articles make conflicting claims that would leave a user unsure which is correct.

Only flag conflicts on:
- Navigation paths ("Settings > Security" vs "Settings > Authentication")
- Feature or option names for the same concept
- Lists of available values (roles, frequencies, providers, permissions) that genuinely differ
- Step sequences that directly conflict
- Config keys or permission names that differ

Do NOT flag:
- One article being more detailed than another
- Different articles covering different audiences or entry points
- Articles about distinct but related features
- Minor wording differences that mean the same thing

ARTICLES:
${summaries}

Respond ONLY with valid JSON:
{
  "contradictions": [
    {
      "articleAIndex": 1,
      "articleAClaim": "exact phrase from article A",
      "articleBIndex": 2,
      "articleBClaim": "exact phrase from article B that conflicts",
      "topic": "short label e.g. 'SSO navigation path' | 'Available roles' | 'Evidence frequencies'",
      "severity": "high|medium|low",
      "explanation": "one sentence — why a user reading both would be confused"
    }
  ]
}

If no genuine contradictions exist, return: {"contradictions": []}`;

    const res = await request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": CONFIG.claude.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: {
        model: CONFIG.claude.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      },
    });

    if (res.status !== 200) {
      log(`  Contradiction API error ${res.status} for cluster ${ci + 1}`);
      await sleep(1000);
      continue;
    }

    try {
      const text = res.body?.content?.[0]?.text || "{}";
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) continue;
      const parsed = JSON.parse(match[0]);
      for (const c of (parsed.contradictions || [])) {
        const artA = batch[c.articleAIndex - 1];
        const artB = batch[c.articleBIndex - 1];
        if (!artA || !artB) continue;
        all.push({
          articleAId: String(artA.id), articleATitle: artA.title, articleAUrl: artA.url, articleAClaim: c.articleAClaim,
          articleBId: String(artB.id), articleBTitle: artB.title, articleBUrl: artB.url, articleBClaim: c.articleBClaim,
          topic: c.topic, severity: c.severity, explanation: c.explanation,
        });
      }
      if ((parsed.contradictions || []).length > 0) log(`    ⚡ ${parsed.contradictions.length} contradiction(s) found`);
    } catch (e) {
      log(`  Parse error in cluster ${ci + 1}: ${e.message}`);
    }

    await sleep(200);
  }

  log(`  Contradiction check complete: ${all.length} total contradiction(s) found`);
  return all;
}

/**
 * Attach contradiction findings to individual article results (both sides of each pair).
 */
function attachContradictions(results, allContradictions) {
  const resultMap = new Map(results.map(r => [String(r.id), r]));
  for (const r of results) r.contradictions = [];

  for (const c of allContradictions) {
    const artA = resultMap.get(c.articleAId);
    const artB = resultMap.get(c.articleBId);
    if (artA) artA.contradictions.push({
      withArticleId: c.articleBId, withArticleTitle: c.articleBTitle, withArticleUrl: c.articleBUrl,
      thisClaim: c.articleAClaim, otherClaim: c.articleBClaim, topic: c.topic, severity: c.severity, explanation: c.explanation,
    });
    if (artB) artB.contradictions.push({
      withArticleId: c.articleAId, withArticleTitle: c.articleATitle, withArticleUrl: c.articleAUrl,
      thisClaim: c.articleBClaim, otherClaim: c.articleAClaim, topic: c.topic, severity: c.severity, explanation: c.explanation,
    });
  }
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

  const prompt = `You are auditing a help center article for Drata, a compliance automation SaaS platform. Your job is to find every way the article could mislead a user — drawing on THREE independent sources of truth simultaneously:

SOURCE A — THE ARTICLE: what the help article currently says
SOURCE B — DRATA'S CODEBASE: the GitHub files provided below
SOURCE C — YOUR KNOWLEDGE: what you know about the third-party products, APIs, and UI referenced in the article (e.g. Google Workspace, AWS, Okta, Microsoft, GitHub, Slack, etc.)

ARTICLE TITLE: ${article.title}
ARTICLE URL: ${article.url}

ARTICLE CONTENT:
${articleText}

GITHUB FILES (from the Drata codebase):
${githubContext}

─────────────────────────────────────────────
ANALYSIS INSTRUCTIONS
─────────────────────────────────────────────

1. DISCREPANCIES — anything the article says that appears wrong when checked against Source B or Source C.

   For each discrepancy:
   - Identify WHICH sources conflict and HOW. Examples:
       • Article says X, Drata code says Y                     → sourcesConflict: false, drataSays: Y
       • Article says X, Drata code says Y, Google UI says Z   → sourcesConflict: true (all three differ)
       • Article says X, Drata code agrees, but Google changed → sourcesConflict: false, thirdPartySays: new Google value
       • Drata code says X, third-party says Y (article silent) → flag as missing content instead
   - When Drata's implementation and the third-party product give DIFFERENT answers (like domainsettings vs domain settings), flag BOTH values explicitly and mark sourcesConflict: true. Do NOT guess which is correct — surface both and let the writer verify.
   - Be specific about navigation paths, exact string values, field names, config keys, permission names.

2. MISSING CONTENT — capabilities in the code or the third-party product that the article doesn't cover but should.
   Only flag things a user reading this article genuinely needs to know. Skip internal implementation details.

─────────────────────────────────────────────
OUTPUT FORMAT — respond ONLY with valid JSON:
─────────────────────────────────────────────
{
  "discrepancies": [
    {
      "field": "short label (e.g. 'Navigation path', 'Permission name', 'Config value')",
      "articleSays": "exact quote from the article that is wrong or questionable",
      "drataSays": "what Drata's codebase shows — plain English for a technical writer, no raw code. Omit if code doesn't address this.",
      "thirdPartySays": "what the third-party product (Google, AWS, Okta, etc.) actually shows or requires — from your knowledge. Omit if not applicable.",
      "sourcesConflict": true/false,
      "conflictNote": "only present when sourcesConflict is true — one sentence describing exactly how Drata's implementation differs from the third-party product, so the writer knows what to verify",
      "action": "Update text | Add missing options | Remove outdated step | Replace screenshot | Verify with third party | Split into two paths",
      "suggestedFix": "the replacement text the writer can paste in, OR if sourcesConflict is true: describe both options and note that manual verification is needed",
      "githubFile": "path/to/file.ts if applicable",
      "severity": "critical|high|medium|low — critical: user will fail the task or be sent somewhere wrong; high: user confused but can proceed; medium: notable gap; low: cosmetic",
      "explanation": "one sentence on why this matters to users"
    }
  ],
  "missingContent": [
    {
      "feature": "short name",
      "source": "github|third-party-knowledge|both",
      "evidence": "what in the code or your knowledge shows this exists",
      "githubFile": "path/to/file.ts if applicable",
      "suggestedAddition": "one or two sentences describing what to add",
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

// ─── Third-party product detection ──────────────────────────────────────────

/**
 * Map of display names → lowercase detection keywords (body text + title scan).
 * Only products that Drata realistically integrates with or documents.
 */
const THIRD_PARTY_PRODUCT_MAP = {
  "Microsoft / Azure":    ["azure", "microsoft entra", "azure ad", "azure active directory", "microsoft 365", "office 365", "azure portal", "microsoft teams", "entra id"],
  "AWS":                  ["amazon web services", " aws ", "iam role", "iam policy", "s3 bucket", "cloudwatch", "eventbridge", "aws console", "aws lambda", "aws iam", "readonlyaccess"],
  "Google Workspace":     ["google workspace", "google admin", "g suite", "google cloud", "gcp", "google drive", "google cloud console", "google admin console"],
  "Okta":                 ["okta"],
  "GitHub":               ["github actions", "github enterprise", "github apps", "github.com"],
  "Slack":                ["slack"],
  "Atlassian / Jira":     ["jira", "confluence", "atlassian"],
  "Salesforce":           ["salesforce"],
  "ServiceNow":           ["servicenow"],
  "CyberArk":             ["cyberark"],
  "CrowdStrike":          ["crowdstrike"],
  "Datadog":              ["datadog"],
  "PagerDuty":            ["pagerduty"],
  "Zendesk":              ["zendesk"],
  "GitLab":               ["gitlab"],
  "Bitbucket":            ["bitbucket"],
  "Docker":               ["docker hub", "docker desktop"],
  "Snowflake":            ["snowflake"],
  "OneLogin":             ["onelogin"],
  "Duo / Cisco":          ["duo security", "duo mfa", "cisco duo"],
  "JumpCloud":            ["jumpcloud"],
  "BambooHR":             ["bamboohr"],
  "Rippling":             ["rippling"],
  "Workday":              ["workday"],
};

/**
 * Scan article title + body HTML for known third-party product names.
 * Returns an array of product display names detected (e.g. ["AWS", "Okta"]).
 */
function detectThirdPartyProducts(title, html) {
  const text = ((title || "") + " " + stripHtml(html || "")).toLowerCase();
  const detected = [];
  for (const [product, keywords] of Object.entries(THIRD_PARTY_PRODUCT_MAP)) {
    if (keywords.some((kw) => text.includes(kw))) {
      detected.push(product);
    }
  }
  return detected;
}

/**
 * Search Brave for recent renames/deprecations for each detected product.
 * Only runs if BRAVE_SEARCH_API_KEY is set in .env.
 * Returns a plain-text summary of search snippets to inject into the Claude prompt.
 */
async function searchProductChanges(products) {
  const braveKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!braveKey || products.length === 0) return "";

  const contexts = [];
  for (const product of products.slice(0, 3)) { // max 3 products per article to keep latency low
    const query = encodeURIComponent(`${product} renamed deprecated changed admin console 2025 2026`);
    try {
      const res = await request(
        `https://api.search.brave.com/res/v1/web/search?q=${query}&count=3&text_decorations=false`,
        {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": braveKey,
          },
          timeout: 8000,
        }
      );
      if (res.status === 200 && res.body?.web?.results?.length) {
        const snippets = res.body.web.results
          .slice(0, 3)
          .map((r) => `  • ${r.title}: ${r.description || ""}`)
          .join("\n");
        contexts.push(`Recent web results for "${product}":\n${snippets}`);
      }
    } catch (e) {
      log(`  Brave search failed for ${product}: ${e.message}`);
    }
    await sleep(300); // gentle rate limit between searches
  }

  return contexts.join("\n\n");
}

// ─── Claude third-party terminology audit ────────────────────────────────────

async function detectThirdPartyTerms(article) {
  if (CONFIG.dryRun || !CONFIG.claude.apiKey) {
    return { thirdPartyIssues: [], skipped: true };
  }

  const articleText = truncate(stripHtml(article.body), 8000);
  if (articleText.length < 50) return { thirdPartyIssues: [] };

  // ── Step 1: Fast keyword scan — skip entirely if no third-party products found ──
  const detectedProducts = detectThirdPartyProducts(article.title, article.body);
  if (detectedProducts.length === 0) {
    return { thirdPartyIssues: [], skipped: "no_third_party_products" };
  }
  log(`  3P scan: [${detectedProducts.join(", ")}] → running knowledge pass`);

  // ── Step 2: Live web search for detected products (if Brave key available) ──
  const searchContext = await searchProductChanges(detectedProducts);
  const liveContextSection = searchContext
    ? `\nRECENT WEB SEARCH RESULTS (use these to supplement your training knowledge — they may contain changes after your knowledge cutoff):\n${searchContext}\n`
    : "";

  // ── Step 3: Claude knowledge pass with optional live context ──────────────
  const prompt = `You are auditing a help center article for Drata, a compliance automation SaaS platform. Your job is to identify references to THIRD-PARTY product names, UI navigation paths, or feature names that are OUTDATED as of early 2026.

DETECTED THIRD-PARTY PRODUCTS IN THIS ARTICLE: ${detectedProducts.join(", ")}
${liveContextSection}
IMPORTANT RULES:
- Only flag items where you are HIGHLY CONFIDENT the term has actually changed or been deprecated.
- Do NOT flag things you are uncertain about. It is better to miss something than to produce a false positive.
- Do NOT flag Drata's own UI or product — only flag EXTERNAL third-party products.
- Focus on confirmed rebrands, renamed console sections, deprecated services, and navigation paths that have moved.
- If the web search results above confirm a change, use that information. If they conflict with your knowledge, flag the discrepancy.

ARTICLE TITLE: ${article.title}

ARTICLE CONTENT:
${articleText}

Respond ONLY with valid JSON in this exact format:
{
  "thirdPartyIssues": [
    {
      "term": "the exact outdated term or phrase found in the article",
      "context": "the full sentence or phrase from the article that contains this term",
      "product": "which third-party product this refers to (e.g. Microsoft, AWS, Google Workspace, Okta)",
      "currentTerm": "the correct current name or path as of 2026",
      "suggestedFix": "the exact replacement text the writer should use in the article",
      "severity": "critical|high|medium|low",
      "explanation": "one sentence explaining what changed and approximately when",
      "sourceNote": "training-knowledge | web-search-confirmed | web-search-suggested — how confident is this finding"
    }
  ]
}

If no outdated third-party terms are found with HIGH confidence, return: {"thirdPartyIssues": []}`;

  const res = await request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": CONFIG.claude.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: {
      model: CONFIG.claude.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    },
  });

  if (res.status !== 200) {
    log(`  Claude 3P audit error ${res.status} for: ${article.title}`);
    return { thirdPartyIssues: [], error: `Claude API ${res.status}` };
  }

  try {
    const text = res.body?.content?.[0]?.text || "{}";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { thirdPartyIssues: [] };
    const parsed = JSON.parse(match[0]);
    return {
      thirdPartyIssues: parsed.thirdPartyIssues || [],
      detectedProducts, // store for dashboard use
    };
  } catch (e) {
    return { thirdPartyIssues: [], parseError: e.message };
  }
}

// ─── Grammar check ───────────────────────────────────────────────────────────

/**
 * Ask Claude to flag genuine grammatical errors in the article.
 * Deliberately ignores style, tone, and marketing language — only hard grammar.
 */
async function checkGrammar(article) {
  if (CONFIG.dryRun || !CONFIG.claude.apiKey) {
    return { grammarIssues: [], skipped: true };
  }

  const articleText = truncate(stripHtml(article.body), 6000);
  if (articleText.length < 80) return { grammarIssues: [] };

  const prompt = `You are proofreading a help center article for Drata, a B2B SaaS compliance platform. Your ONLY job is to find genuine GRAMMATICAL errors — things that are objectively wrong according to standard English grammar rules.

DO flag:
- Subject-verb agreement errors ("The settings was updated")
- Wrong verb tense or inconsistent tense within a sentence ("Click Save, then you selected the option")
- Incorrect pronoun case ("Contact your admin and I")
- Missing or misplaced apostrophes on possessives ("the users settings", "its" vs "it's")
- Dangling modifiers ("After logging in, the page will appear" — who logged in?)
- Double negatives ("you cannot not select")
- Sentence fragments used unintentionally (not as a deliberate stylistic bullet)
- Run-on sentences joined without correct punctuation

DO NOT flag:
- Oxford comma choices — both are acceptable
- Passive voice — common in technical writing
- Starting a sentence with "And", "But", or "Or" — acceptable in modern style
- Sentence-ending prepositions — acceptable in modern English
- Marketing language, hype words, or vague promises
- Wordiness, redundancy, or style preferences
- Inconsistent capitalization of product terms (that's a content issue, not grammar)
- Formatting or structure choices

ARTICLE TITLE: ${article.title}

ARTICLE CONTENT:
${articleText}

Respond ONLY with valid JSON:
{
  "grammarIssues": [
    {
      "errorType": "short label e.g. 'Subject-verb agreement' | 'Verb tense' | 'Dangling modifier' | 'Apostrophe' | 'Run-on sentence' | 'Sentence fragment' | 'Pronoun case'",
      "excerpt": "the exact sentence or phrase from the article containing the error (verbatim)",
      "issue": "one sentence describing the specific grammar error",
      "suggestedFix": "the corrected version of the excerpt",
      "severity": "high|medium|low — high: clearly confusing or wrong; medium: noticeable error; low: minor but technically incorrect"
    }
  ]
}

If no genuine grammatical errors are found, return: {"grammarIssues": []}`;

  const res = await request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": CONFIG.claude.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: {
      model: CONFIG.claude.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    },
  });

  if (res.status !== 200) {
    log(`  Grammar check error ${res.status} for: ${article.title}`);
    return { grammarIssues: [], error: `Claude API ${res.status}` };
  }

  try {
    const text = res.body?.content?.[0]?.text || "{}";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { grammarIssues: [] };
    const parsed = JSON.parse(match[0]);
    return { grammarIssues: parsed.grammarIssues || [] };
  } catch (e) {
    return { grammarIssues: [], parseError: e.message };
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
    body: article.body || "",   // stored for Replace Term search & apply
    githubFilesChecked: [],
    discrepancies: [],
    missingContent: [],
    brokenLinks: [],
    thirdPartyIssues: [],
    grammarIssues: [],
    status: "ok", // ok | discrepancies | broken_links | missing_content | multiple | no_github_match | third_party | grammar | error
    noGithubMatchReason: null, // title_too_vague | no_path_match | content_unreadable
    auditedAt: new Date().toISOString(),
  };

  try {
    // 1. Find relevant GitHub files
    const { files: githubFiles, noMatchReason, pass2Match } = await findRelevantFiles(article, repoTree);
    result.githubFilesChecked = githubFiles.map((f) => f.path);
    if (noMatchReason) result.noGithubMatchReason = noMatchReason;
    if (pass2Match) result.pass2Match = true; // found via content search, not path

    // 2. Detect discrepancies + missing content
    const disc = await detectDiscrepancies(article, githubFiles);
    result.discrepancies = disc.discrepancies || [];
    result.missingContent = disc.missingContent || [];
    if (disc.noGithubMatch) result.status = "no_github_match";
    if (noMatchReason && result.status === "ok") result.status = "no_github_match";
    if (disc.error) result.error = disc.error;

    // 3. Check links
    result.brokenLinks = await checkLinks(article);

    // 4. Third-party terminology audit (only runs when article mentions known products)
    const tpResult = await detectThirdPartyTerms(article);
    result.thirdPartyIssues = tpResult.thirdPartyIssues || [];
    if (tpResult.detectedProducts) result.detectedProducts = tpResult.detectedProducts;

    // 5. Grammar check
    const grammarResult = await checkGrammar(article);
    result.grammarIssues = grammarResult.grammarIssues || [];

    // Determine status (flags all issue types found)
    const hasDisc       = result.discrepancies.length > 0;
    const hasMissing    = result.missingContent.length > 0;
    const hasLinks      = result.brokenLinks.length > 0;
    const hasThirdParty = result.thirdPartyIssues.length > 0;
    const hasGrammar    = result.grammarIssues.length > 0;
    const issueCount = [hasDisc, hasMissing, hasLinks, hasThirdParty, hasGrammar].filter(Boolean).length;

    if (result.status !== "no_github_match") {
      if (issueCount > 1)        result.status = "multiple";
      else if (hasDisc)          result.status = "discrepancies";
      else if (hasMissing)       result.status = "missing_content";
      else if (hasLinks)         result.status = "broken_links";
      else if (hasThirdParty)    result.status = "third_party";
      else if (hasGrammar)       result.status = "grammar";
      else                       result.status = "ok";
    } else if (hasThirdParty || hasGrammar) {
      // no_github_match articles can still have other issues — flag both
      result.status = "multiple";
    }

    // Stale flag: last updated more than 2 years ago
    const TWO_YEARS_AGO = Date.now() / 1000 - 2 * 365 * 24 * 60 * 60;
    result.stale = !!result.updatedAt && result.updatedAt < TWO_YEARS_AGO;
  } catch (err) {
    result.status = "error";
    result.error = err.message;
    log(`  ERROR: ${err.message}`);
  }

  return result;
}

// ─── Targeted check mode (--check <type>) ────────────────────────────────────

/**
 * Run a single targeted check and merge results back into latest.json.
 * Used by the individual dashboard buttons (Links, 3P, Grammar, Clean, Contradictions).
 */
async function runCheckMode(checkType) {
  const latestFile = path.join(CONFIG.outputDir, "latest.json");
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(latestFile, "utf8"));
  } catch {
    log("ERROR: No existing results found. Run a full audit first.");
    process.exit(1);
  }

  log(`=== Targeted check: ${checkType} ===`);

  // Fetch fresh article bodies from Intercom
  let articles = await fetchAllIntercomArticles();

  // Apply collection filters (skip video collections, --collection filter)
  const { collectionMap, sectionToCollection } = await fetchIntercomCollections();
  const { filtered: collFiltered, skippedVideoCount } = applyCollectionFilters(articles, collectionMap, sectionToCollection);
  articles = collFiltered;
  if (skippedVideoCount > 0) log(`Skipping ${skippedVideoCount} video/training articles`);

  if (CONFIG.limit) articles = articles.slice(0, CONFIG.limit);

  // Filter out ignored articles
  const ignoredFilePath = path.join(CONFIG.outputDir, "ignored.json");
  try {
    const ig = JSON.parse(fs.readFileSync(ignoredFilePath, "utf8"));
    const ignoredSet = new Set(ig.map(e => String(e.id)));
    if (ignoredSet.size > 0) {
      const before = articles.length;
      articles = articles.filter(a => !ignoredSet.has(String(a.id)));
      log(`Skipping ${before - articles.length} ignored articles`);
    }
  } catch {}

  // For 'clean': only re-audit articles currently marked ok
  if (checkType === "clean") {
    const okIds = new Set(existing.articles.filter(a => a.status === "ok").map(a => String(a.id)));
    articles = articles.filter(a => okIds.has(String(a.id)));
    log(`'clean' mode: processing ${articles.length} currently-clean articles`);
  }

  if (articles.length === 0) {
    log("No articles to process for this check type.");
    process.exit(0);
  }

  const resultMap = new Map(existing.articles.map(a => [String(a.id), a]));

  if (checkType === "contradictions") {
    // Clear existing contradictions from all articles
    for (const a of resultMap.values()) a.contradictions = [];

    const clusters = buildTopicClusters(articles);
    log(`Built ${clusters.length} topic clusters`);
    const allContradictions = await detectContradictions(clusters, articles);

    // Attach to results
    const resultArr = [...resultMap.values()];
    attachContradictions(resultArr, allContradictions);

    existing.summary.totalContradictions = allContradictions.length;
    existing.summary.withContradictions  = resultArr.filter(r => (r.contradictions||[]).length > 0).length;
  } else {
    // Per-article targeted checks
    const repoTree = checkType === "clean" ? await fetchRepoFileTree() : null;

    const tasks = articles.map((article, i) => async () => {
      log(`[${i + 1}/${articles.length}] ${article.title}`);
      const rec = resultMap.get(String(article.id)) || { id: article.id, title: article.title, url: article.url };

      if (checkType === "links") {
        rec.brokenLinks = await checkLinks(article);
      } else if (checkType === "third-party") {
        const tp = await detectThirdPartyTerms(article);
        rec.thirdPartyIssues = tp.thirdPartyIssues || [];
        if (tp.detectedProducts) rec.detectedProducts = tp.detectedProducts;
      } else if (checkType === "grammar") {
        const g = await checkGrammar(article);
        rec.grammarIssues = g.grammarIssues || [];
      } else if (checkType === "clean") {
        // Full re-audit on this previously-clean article
        const fresh = await auditArticle(article, repoTree, i, articles.length);
        Object.assign(rec, fresh);
      }

      resultMap.set(String(article.id), rec);
    });

    await pLimit(tasks, CONFIG.concurrency);

    // Recalculate relevant summary fields
    const all = [...resultMap.values()];
    if (checkType === "links" || checkType === "clean") {
      existing.summary.withBrokenLinks  = all.filter(r => (r.brokenLinks||[]).length > 0).length;
      existing.summary.totalBrokenLinks = all.reduce((n, r) => n + (r.brokenLinks?.length || 0), 0);
    }
    if (checkType === "third-party" || checkType === "clean") {
      existing.summary.withThirdPartyIssues  = all.filter(r => (r.thirdPartyIssues||[]).length > 0).length;
      existing.summary.totalThirdPartyIssues = all.reduce((n, r) => n + (r.thirdPartyIssues?.length || 0), 0);
    }
    if (checkType === "grammar" || checkType === "clean") {
      existing.summary.withGrammarIssues  = all.filter(r => (r.grammarIssues||[]).length > 0).length;
      existing.summary.totalGrammarIssues = all.reduce((n, r) => n + (r.grammarIssues?.length || 0), 0);
    }
    if (checkType === "clean") {
      existing.summary.ok = all.filter(r => r.status === "ok").length;
      existing.summary.withDiscrepancies = all.filter(r => ["discrepancies","multiple"].includes(r.status)).length;
    }
  }

  // Store per-check last-run timestamp
  if (!existing.summary.checkLastRun) existing.summary.checkLastRun = {};
  existing.summary.checkLastRun[checkType] = new Date().toISOString();

  existing.articles = [...resultMap.values()];

  fs.writeFileSync(latestFile, JSON.stringify(existing, null, 2));
  log(`\n=== CHECK COMPLETE: ${checkType} — results merged into latest.json ===`);
}

// ─── Full audit ───────────────────────────────────────────────────────────────

async function run() {
  // Validate required env vars
  const missing = [];
  if (!CONFIG.intercom.token) missing.push("INTERCOM_TOKEN");
  if (!CONFIG.github.token) missing.push("GITHUB_TOKEN");
  if (!CONFIG.github.repo && !CONFIG.check) missing.push("GITHUB_REPO");
  if (!CONFIG.claude.apiKey && !CONFIG.dryRun) missing.push("ANTHROPIC_API_KEY");
  if (missing.length) {
    log(`ERROR: Missing required environment variables: ${missing.join(", ")}`);
    log("Copy .env.example to .env and fill in your tokens.");
    process.exit(1);
  }

  // Ensure output dir exists
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  // ── Targeted check mode ──────────────────────────────────────────────────
  if (CONFIG.check) {
    await runCheckMode(CONFIG.check);
    return;
  }

  // ── Full audit ───────────────────────────────────────────────────────────
  const startTime = Date.now();
  log(`=== Drata Help Center Audit ${CONFIG.dryRun ? "[DRY RUN] " : ""}===`);
  log(`Target repo: ${CONFIG.github.owner}/${CONFIG.github.repo}`);
  log(`Claude model: ${CONFIG.claude.model}`);

  // Fetch articles
  let articles = await fetchAllIntercomArticles();

  // Fetch collections and apply filters (skip video collections, apply --collection)
  const { collectionMap, sectionToCollection } = await fetchIntercomCollections();
  const { filtered: collFiltered, skippedVideoCount } = applyCollectionFilters(articles, collectionMap, sectionToCollection);
  articles = collFiltered;
  if (skippedVideoCount > 0) log(`Skipping ${skippedVideoCount} video/training articles`);
  if (CONFIG.collection) log(`--collection "${CONFIG.collection}": filtered to ${articles.length} articles`);

  if (CONFIG.limit) {
    log(`--limit flag: processing first ${CONFIG.limit} articles only`);
    articles = articles.slice(0, CONFIG.limit);
  }

  // Filter out ignored articles
  const ignoredFile = path.join(CONFIG.outputDir, "ignored.json");
  let ignoredIds = new Set();
  try {
    const ig = JSON.parse(fs.readFileSync(ignoredFile, "utf8"));
    for (const e of ig) ignoredIds.add(String(e.id));
  } catch {}
  if (ignoredIds.size > 0) {
    const before = articles.length;
    articles = articles.filter(a => !ignoredIds.has(String(a.id)));
    log(`Skipping ${before - articles.length} ignored articles (${articles.length} remaining)`);
  }

  // Fetch GitHub tree (once for all articles)
  const repoTree = await fetchRepoFileTree();

  // Audit all articles with concurrency control
  log(`\nAuditing ${articles.length} articles (${CONFIG.concurrency} concurrent)...`);
  const tasks = articles.map((article, i) => () =>
    auditArticle(article, repoTree, i, articles.length)
  );
  const results = await pLimit(tasks, CONFIG.concurrency);

  // ── Post-audit: cross-article contradiction detection ────────────────────
  log("\nBuilding topic clusters for contradiction check...");
  const clusters = buildTopicClusters(articles);
  log(`  ${clusters.length} clusters found across ${articles.length} articles`);
  const allContradictions = await detectContradictions(clusters, articles);
  attachContradictions(results, allContradictions);

  // Summary stats
  const summary = {
    auditDate: new Date().toISOString().split("T")[0],
    totalArticles: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    withDiscrepancies: results.filter((r) => ["discrepancies", "multiple"].includes(r.status)).length,
    withMissingContent: results.filter((r) => ["missing_content", "multiple"].includes(r.status) || r.missingContent?.length > 0).length,
    withBrokenLinks: results.filter((r) => ["broken_links", "multiple"].includes(r.status)).length,
    staleArticles: results.filter((r) => r.stale).length,
    noGithubMatch: results.filter((r) => r.noGithubMatchReason).length,
    errors: results.filter((r) => r.status === "error").length,
    totalDiscrepancies: results.reduce((n, r) => n + r.discrepancies.length, 0),
    totalMissingContent: results.reduce((n, r) => n + (r.missingContent?.length || 0), 0),
    totalBrokenLinks: results.reduce((n, r) => n + r.brokenLinks.length, 0),
    criticalDiscrepancies: results.reduce(
      (n, r) => n + r.discrepancies.filter((d) => d.severity === "critical").length,
      0
    ),
    withThirdPartyIssues: results.filter((r) => (r.thirdPartyIssues?.length || 0) > 0).length,
    totalThirdPartyIssues: results.reduce((n, r) => n + (r.thirdPartyIssues?.length || 0), 0),
    withGrammarIssues: results.filter((r) => (r.grammarIssues?.length || 0) > 0).length,
    totalGrammarIssues: results.reduce((n, r) => n + (r.grammarIssues?.length || 0), 0),
    withContradictions: results.filter((r) => (r.contradictions||[]).length > 0).length,
    totalContradictions: allContradictions.length,
    checkLastRun: { full: new Date().toISOString() },
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
  log(`  Outdated 3rd-party terms: ${summary.withThirdPartyIssues} articles (${summary.totalThirdPartyIssues} terms)`);
  log(`  Grammar issues: ${summary.withGrammarIssues} articles (${summary.totalGrammarIssues} issues)`);
  log(`  Cross-article contradictions: ${summary.withContradictions} articles involved (${summary.totalContradictions} pairs)`);
  log(`  No GitHub match: ${summary.noGithubMatch}`);
  log(`  Errors: ${summary.errors}`);
  log(`  Duration: ${summary.durationSeconds}s`);
  log(`  Results saved to: ${outFile}`);

  // Write a "latest" symlink/copy for the dashboard
  const latestFile = path.join(CONFIG.outputDir, "latest.json");
  fs.copyFileSync(outFile, latestFile);
  log(`  Latest results: ${latestFile}`);

  // Append to run history (used for trend chart on dashboard)
  const historyFile = path.join(CONFIG.outputDir, "history.json");
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyFile, "utf8")); } catch {}
  history.push({
    date:                  summary.auditDate,
    runAt:                 new Date().toISOString(),
    totalArticles:         summary.totalArticles,
    ok:                    summary.ok,
    withDiscrepancies:     summary.withDiscrepancies,
    withBrokenLinks:       summary.withBrokenLinks,
    withThirdPartyIssues:  summary.withThirdPartyIssues,
    withGrammarIssues:     summary.withGrammarIssues,
    withContradictions:    summary.withContradictions,
    noGithubMatch:         summary.noGithubMatch,
    durationSeconds:       summary.durationSeconds,
  });
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
  log(`  History updated: ${history.length} run(s) recorded`);
}

run().catch((err) => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
});
