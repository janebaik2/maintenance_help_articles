# Drata Help Center Audit

Nightly audit system that compares every published Intercom help center article against the Drata GitHub codebase — finding outdated content and broken links.

## What it does

For each of your 925 Intercom articles, the audit:

1. **Fetches article content** from Intercom (all published articles, paginated)
2. **Finds matching GitHub files** by scoring your entire repo tree against the article title keywords
3. **Detects discrepancies** — sends both the article text and GitHub file contents to Claude, which returns a structured list of differences: what the article says vs. what the code shows, with severity ratings (critical / high / medium / low)
4. **Checks every link** in the article with a HEAD request and flags anything returning 4xx/5xx or timing out
5. **Saves results** to `results/audit-YYYY-MM-DD.json` and `results/latest.json`

## Setup

### 1. Get your API tokens

You need three tokens:

**Intercom Token**
1. Go to [Intercom Settings → Developers → Your Apps](https://app.intercom.com/a/apps/_/settings/api-keys)
2. Create a new app (or use existing) and copy the Access Token

**GitHub Token**
1. Go to [GitHub → Settings → Developer settings → Personal access tokens → Fine-grained](https://github.com/settings/tokens?type=beta)
2. Create a token scoped to the `drata` org with **Contents: read** and **Metadata: read** permissions on the target repo

**Anthropic API Key**
1. Go to [Anthropic Console → API Keys](https://console.anthropic.com/settings/keys)
2. Create a key

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and fill in your three tokens plus the repo name:

```
INTERCOM_TOKEN=...
GITHUB_TOKEN=...
GITHUB_OWNER=drata
GITHUB_REPO=your-repo-name    # just the repo name, not the full URL
ANTHROPIC_API_KEY=...
```

### 3. Test it locally

```bash
# Run on 10 articles to verify everything works
node audit.js --limit 10

# Dry run (fetches articles + GitHub matches, skips Claude API calls)
node audit.js --dry-run

# Full run (all 925 articles, ~60-90 min)
node audit.js
```

### 4. View results

Open `dashboard.html` in your browser. It reads from `results/latest.json` automatically.

> **Note:** Browsers block local file fetches for security. Use a simple server:
> ```bash
> npx serve .
> # then open http://localhost:3000/dashboard.html
> ```

---

## Nightly automation via GitHub Actions (recommended)

This is the easiest way to run automatically — no server needed, uses Drata's existing GitHub infrastructure, runs free.

### Step 1: Put this folder in a GitHub repo

Push the contents of this folder to a new (or existing) private GitHub repo. Doesn't need to be the same repo as your codebase — a dedicated `help-audit` repo works great.

### Step 2: Add GitHub Actions secrets

Go to your repo → **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Value |
|---|---|
| `INTERCOM_TOKEN` | Your Intercom access token |
| `AUDIT_GITHUB_TOKEN` | Your GitHub fine-grained PAT |
| `AUDIT_GITHUB_REPO` | The repo name to audit against (e.g. `app`) |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

### Step 3: Push the workflow file

The workflow is already at `.github/workflows/nightly-audit.yml`. Once pushed, GitHub will run it automatically at **2 AM UTC every night**.

To change the schedule, edit the `cron` line in the workflow file. Use [crontab.guru](https://crontab.guru) to get the right expression.

### Step 4: Download results

After each run, go to your repo → **Actions** → click the run → scroll down to **Artifacts** → download `audit-results-XXXXX`. Open `dashboard.html` from the ZIP.

### Optional: Slack notifications

The workflow has a commented-out Slack notification step. Uncomment it and add `SLACK_WEBHOOK_URL` as a secret to get a nightly message with a summary.

---

## Configuration

All settings are at the top of `audit.js` in the `CONFIG` object:

| Setting | Default | Description |
|---|---|---|
| `concurrency` | 5 | Articles processed in parallel |
| `github.maxFilesPerArticle` | 8 | Max GitHub files compared per article |
| `github.extensions` | `.md .ts .js ...` | File types to include from repo |
| `github.excludePaths` | `node_modules dist ...` | Paths to skip |
| `claude.model` | `claude-haiku-4-5-20251001` | Switch to `claude-sonnet-4-6` for higher accuracy |
| `linkTimeout` | 10000ms | Timeout per link check |

## Cost estimate

- ~925 articles × avg ~4k tokens = ~3.7M tokens/night
- At Haiku pricing (~$0.25/MTok input): **~$1-3/night**
- Switch to Sonnet for higher accuracy: **~$10-15/night**

## Output schema

`results/latest.json`:

```json
{
  "summary": {
    "auditDate": "2026-06-09",
    "totalArticles": 925,
    "ok": 600,
    "withDiscrepancies": 200,
    "withBrokenLinks": 80,
    "noGithubMatch": 45,
    "errors": 0,
    "totalDiscrepancies": 450,
    "totalBrokenLinks": 120,
    "criticalDiscrepancies": 30,
    "durationSeconds": 4200
  },
  "articles": [
    {
      "id": "12345",
      "title": "How to set up SSO",
      "url": "https://help.drata.com/...",
      "updatedAt": 1717977600,
      "githubFilesChecked": ["src/sso/config.ts", "docs/sso.md"],
      "discrepancies": [
        {
          "field": "Configuration path",
          "articleSays": "Navigate to Settings > Security > SSO",
          "githubSays": "The route is /settings/authentication/sso",
          "githubFile": "src/sso/config.ts",
          "severity": "high",
          "explanation": "The navigation path in the article doesn't match the current route structure"
        }
      ],
      "brokenLinks": [
        {
          "url": "https://old-docs.drata.com/sso",
          "status": 404,
          "ok": false,
          "broken": true
        }
      ],
      "status": "both",
      "auditedAt": "2026-06-09T02:14:33.000Z"
    }
  ]
}
```
