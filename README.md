# bactrans-blog-sync

Syncs the **GoHighLevel "BAC Blog"** into the (private) [`bactrans-site`](https://github.com/Freeze-Frame-Security/bactrans-site)
repo as committed content, so posts render as native **bactrans.com/blog/** pages in the site's own design
— no iframe, no subdomain.

This repo is intentionally **public** so its GitHub Actions minutes are free. It contains nothing sensitive:
just a GHL → JSON fetcher. Credentials live only in repo **secrets** (never exposed, even on a public repo).

```
GHL "BAC Blog"  ──(hourly Action here)──▶  bactrans-site/src/content/blog/<slug>.json  ──▶  Cloudflare build ──▶ bactrans.com/blog/*
```

## How it works

`scripts/sync-ghl-blog.mjs` (pure `fetch`, no headless browser):

1. Lists PUBLISHED posts via the GHL API `GET /blogs/posts/all`.
2. For each, fetches the server-rendered post page `https://seo.bactrans.com/post/<slug>` and parses the
   full body out of its embedded `<script id="__NUXT_DATA__">` payload. (The API list returns metadata
   only — no body — and the single-post API is disabled, so the rendered page is the body source.)
3. Sanitizes the HTML to a safe semantic subset and writes `<BLOG_OUT_DIR>/<slug>.json`.
4. Prunes local posts that were unpublished/deleted in GHL.

The workflow (`.github/workflows/sync.yml`) checks out the private site repo with a scoped token, runs the
sync into it, and pushes any changes. The push triggers the site's existing Cloudflare build.

### Self-heal fallback (transitional)

Some GHL posts were shallow-imported from the old Squarespace site and GHL's API won't let us replace the
body on those importer-locked posts (it silently ignores `rawHTML` edits — only the GHL UI can). When the
sync detects a post is still an excerpt **stub**, it follows the `/bacblog/<slug>` source link embedded in
the stub and pulls the full article from the live Squarespace site. Once a post has a real body in GHL,
the fallback never fires. (Retire it by pasting any stub post's full body into the GHL blog editor.)

## One-time setup

In **this repo** → Settings → Secrets and variables → Actions:

- **Secrets**
  - `GHL_PIT` — the BAC location Private Integration Token (blogs read scope). It lives in `BAC-GHL/.env`.
  - `SITE_REPO_PAT` — a **fine-grained PAT**: resource owner `Freeze-Frame-Security`, repository access
    limited to **`bactrans-site` only**, permission **Contents: Read and write**. (This is what lets the
    public job push into the private site repo.)
- **Variables** (optional — the script defaults to these):
  - `GHL_LOCATION_ID` = `5vl1i6L9tX4pQoZOAD0j`
  - `GHL_BLOG_ID` = `UGWHOqzMETf25JAuLJRU`

Then it runs hourly automatically. Use **Actions → Sync GHL blog → Run workflow** to publish on demand.

## Run locally

```bash
npm install
GHL_PIT=<token> BLOG_OUT_DIR="../bactrans-site/src/content/blog" npm run sync
# preview without writing:
GHL_PIT=<token> node scripts/sync-ghl-blog.mjs --dry-run
```

## Env vars

| Var | Required | Default | Purpose |
|---|---|---|---|
| `GHL_PIT` | yes | — | GHL location PIT (blogs read) |
| `BLOG_OUT_DIR` | in CI | `./src/content/blog` | Where JSON files are written (CI: the site checkout) |
| `GHL_LOCATION_ID` | no | `5vl1i6L9tX4pQoZOAD0j` | GHL location |
| `GHL_BLOG_ID` | no | `UGWHOqzMETf25JAuLJRU` | GHL blog id |
| `GHL_BLOG_HOST` | no | `https://seo.bactrans.com` | Where `/post/<slug>` renders |
| `SQSP_BASE` | no | `https://www.bactrans.com` | Squarespace fallback host |

## Gotchas

- GHL `GET /blogs/posts/all` returns **0 results unless `status=PUBLISHED`** is passed; `limit` max is **50**.
- The GHL API is behind Cloudflare, which **1010-blocks default runtime User-Agents** — the script sends a
  browser-ish `User-Agent`. Any script hitting the GHL API needs this.
- GHL **ignores `rawHTML`/`type` writes on importer-sourced posts** (only the GHL UI can set their body).
