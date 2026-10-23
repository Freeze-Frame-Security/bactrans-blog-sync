/**
 * sync-ghl-blog.mjs — pull the GoHighLevel "BAC Blog" into this Astro site as committed
 * content (src/content/blog/<slug>.json), so posts render as native bactrans.com/blog/* pages.
 *
 * Cost: $0. Pure fetch, no headless browser. Designed to run in GitHub Actions (hourly + manual).
 *
 * Source of truth = GHL. The GHL public Blog API list endpoint (/blogs/posts/all) returns
 * metadata only (no body), and the single-post API is disabled (401). The full body lives in
 * the server-rendered post page at <GHL_BLOG_HOST>/post/<slug> inside a <script id="__NUXT_DATA__">
 * payload — we parse that. See the project's BLOG-SYNC.md for the full rationale.
 *
 * Self-heal: some GHL posts were shallow-imported from the old Squarespace site and only hold an
 * excerpt STUB (GHL's API won't let us replace the body on importer-locked posts). When we detect a
 * stub, we follow the /bacblog source link embedded in the stub and pull the full article from the
 * live Squarespace site. This is transitional — once a post has a real body in GHL (native authoring
 * or a one-time GHL-UI paste), the fallback never fires.
 *
 * Env:
 *   GHL_PIT        (required) location-scoped Private Integration Token (blogs read scope)
 *   GHL_LOCATION_ID  default 5vl1i6L9tX4pQoZOAD0j
 *   GHL_BLOG_ID      default UGWHOqzMETf25JAuLJRU
 *   GHL_BLOG_HOST    default https://seo.bactrans.com   (where /post/<slug> renders)
 *   SQSP_BASE        default https://www.bactrans.com   (Squarespace fallback /bacblog/<slug>)
 *   BLOG_DEFAULT_HERO default /images/scenery/chugach-dawn.webp (used when a post has no image)
 */
import { writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'node-html-parser';

const PIT = process.env.GHL_PIT;
const LOCATION_ID = process.env.GHL_LOCATION_ID || '5vl1i6L9tX4pQoZOAD0j';
const BLOG_ID = process.env.GHL_BLOG_ID || 'UGWHOqzMETf25JAuLJRU';
const BLOG_HOST = (process.env.GHL_BLOG_HOST || 'https://seo.bactrans.com').replace(/\/$/, '');
const SQSP_BASE = (process.env.SQSP_BASE || 'https://www.bactrans.com').replace(/\/$/, '');
const DEFAULT_HERO = process.env.BLOG_DEFAULT_HERO || '/images/scenery/chugach-dawn.webp';
// Output dir: BLOG_OUT_DIR (CI points this at the checked-out site repo) or local default.
const OUT_DIR = process.env.BLOG_OUT_DIR
  ? path.resolve(process.env.BLOG_OUT_DIR)
  : path.join(process.cwd(), 'src', 'content', 'blog');
// Browser-ish UA: Cloudflare in front of the GHL API 1010-blocks default runtime UAs.
const UA = 'Mozilla/5.0 (compatible; BACBlogSync/1.0; +https://www.bactrans.com)';

const KEEP_TAGS = new Set(['h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'a', 'img',
  'strong', 'em', 'b', 'i', 'blockquote', 'figure', 'figcaption', 'br', 'hr']);
const KEEP_ATTRS = { a: ['href'], img: ['src', 'alt'] };

if (!PIT) {
  console.error('FATAL: GHL_PIT env var is required (GHL location PIT with blogs read scope).');
  process.exit(1);
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}
async function fetchJSON(url, headers = {}) {
  return JSON.parse(await fetchText(url, headers));
}

/** List PUBLISHED posts (metadata only). Note: API returns 0 unless status is passed; limit<=50. */
async function listPublishedPosts() {
  const out = [];
  for (let offset = 0; ; offset += 50) {
    const url = `https://services.leadconnectorhq.com/blogs/posts/all`
      + `?locationId=${LOCATION_ID}&blogId=${BLOG_ID}&limit=50&offset=${offset}&status=PUBLISHED`;
    const data = await fetchJSON(url, { Authorization: `Bearer ${PIT}`, Version: '2021-07-28', Accept: 'application/json' });
    const batch = data.blogs || [];
    out.push(...batch);
    if (batch.length < 50) break;
  }
  return out;
}

/** Resolve the blog-post object out of a Nuxt __NUXT_DATA__ devalue array (shallow deref). */
function parseRenderedPost(html) {
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let arr;
  try { arr = JSON.parse(m[1]); } catch { return null; }
  const deref = (v) => (typeof v === 'number' && v >= 0 && v < arr.length) ? arr[v] : v;
  const ref = arr.find((el) => el && typeof el === 'object' && !Array.isArray(el)
    && 'rawHTML' in el && 'urlSlug' in el);
  if (!ref) return null;
  const g = (k) => deref(ref[k]);
  let author = g('author');
  if (author && typeof author === 'object') author = deref(author.name) || deref(author._id) || null;
  let categories = g('categories');
  if (Array.isArray(categories)) {
    categories = categories.map((c) => { const o = deref(c); return o && typeof o === 'object' ? deref(o.label) : o; })
      .filter((x) => typeof x === 'string');
  } else categories = [];
  return {
    title: g('title'), urlSlug: g('urlSlug'), rawHTML: g('rawHTML') || '',
    imageUrl: g('imageUrl') || '', imageAlt: g('imageAltText') || '',
    description: g('description') || '', publishedAt: g('publishedAt'),
    updatedAt: g('updatedAt'), author, categories,
    readTime: g('readTimeInMinutes') || null, wordCount: g('wordCount') || 0,
  };
}

const textOf = (html) => parse(html || '').text.replace(/\s+/g, ' ').trim();

/** A GHL post that's still a shallow Squarespace excerpt rather than a real article. */
function isExcerptStub(rawHTML) {
  if (!rawHTML) return true;
  if (/excerpt-thumb|entry-more-link|data-read-more/i.test(rawHTML)) return true;
  return textOf(rawHTML).split(' ').filter(Boolean).length < 60;
}

/** Pull the /bacblog/<slug> source link a Squarespace excerpt stub points back to. */
function squarespaceSlugFromStub(rawHTML) {
  const m = rawHTML.match(/\/bacblog\/([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
}

function normalizeImg(src) {
  if (!src) return '';
  if (src.startsWith('//')) src = 'https:' + src;
  if (src.startsWith('http://')) src = 'https://' + src.slice('http://'.length);
  return src.replace(/\?format=\d+w/, '?format=1500w');
}

/**
 * Is a link or image URL safe to publish? Same rules as bactrans-site's src/lib/safeHref.ts, which
 * checks every synced body again at build time: same-site /paths, https URLs, mailto:/tel: and
 * #anchors pass. Links (allowHttp) may also be plain http://, which older posts use: a weak link,
 * not a script one. Everything else fails: javascript:, data:, vbscript:, protocol-relative //host
 * or /\host, and any value with whitespace or control characters (browsers strip those out of URLs,
 * so "java<tab>script:" still runs). Takes the DECODED value: node-html-parser's getAttribute()
 * already resolves character references, so "&#106;avascript:" arrives here as "javascript:".
 */
function isSafeUrl(url, { allowHttp = false } = {}) {
  let u = (url || '').trim();
  if (allowHttp) u = u.replace(/^http:\/\//i, 'https://');
  if (!u || /[\s\u0000-\u001f\u007f]/.test(u)) return false;
  return /^\/(?![/\\])/.test(u) || /^https:\/\/[^/\\]/i.test(u)
    || /^(mailto|tel):./i.test(u) || /^#[\w-]*$/.test(u);
}

/** Strip arbitrary markup down to a safe, semantic subset for in-site rendering. */
function sanitize(html) {
  const root = parse(html || '', { lowerCaseTagName: true, comment: false });
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType !== 1) continue; // keep text, drop comments handled by parser
      walk(child);
      const tag = (child.rawTagName || '').toLowerCase();
      if (tag === 'img') {
        const src = normalizeImg(child.getAttribute('data-src') || child.getAttribute('src') || child.getAttribute('data-image') || '');
        const alt = child.getAttribute('alt') || '';
        for (const a of Object.keys(child.attributes)) child.removeAttribute(a);
        if (!isSafeUrl(src)) { child.remove(); continue; }
        // src came out of getAttribute() decoded and setAttribute() writes it back raw, so "&" is
        // escaped again; otherwise a browser decodes it twice ("/&amp;sol;x" -> "/&sol;x" -> "//x").
        child.setAttribute('src', src.replace(/&/g, '&amp;'));
        child.setAttribute('alt', alt);
        child.setAttribute('loading', 'lazy');
      } else if (KEEP_TAGS.has(tag)) {
        const allowed = KEEP_ATTRS[tag] || [];
        for (const a of Object.keys(child.attributes)) if (!allowed.includes(a)) child.removeAttribute(a);
        if (tag === 'a') {
          // getAttribute() returns the first href, the one browsers follow.
          const href = child.getAttribute('href');
          if (href !== undefined && !isSafeUrl(href, { allowHttp: true })) {
            child.removeAttribute('href'); // the link text stays, as plain text
          } else if (href !== undefined) {
            // Writing href back rebuilds the tag from the parsed attributes, so a second href that
            // browsers ignore (but that could still spell javascript:) is not copied through.
            child.setAttribute('href', child.rawAttributes.href);
            if (/^https?:\/\//i.test(href) && !href.includes('bactrans.com')) {
              child.setAttribute('rel', 'noopener');
              child.setAttribute('target', '_blank');
            }
          }
        }
      } else {
        child.replaceWith(...child.childNodes); // unwrap unknown tags, keep children
      }
    }
  };
  walk(root);
  let out = root.toString();
  out = out.replace(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '');
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/** Fallback: extract a full article body + hero from a Squarespace /bacblog/<slug> page. */
async function fetchSquarespaceArticle(slug) {
  const url = `${SQSP_BASE}/bacblog/${slug}`;
  const root = parse(await fetchText(url));
  const main = root.querySelector('[data-content-field="main-content"]');
  if (!main) return null;
  const parts = [];
  for (const block of main.querySelectorAll('.sqs-block')) {
    const cls = block.classList;
    if (cls.contains('sqs-block-html')) {
      const c = block.querySelector('.sqs-html-content');
      if (c) parts.push(c.innerHTML);
    } else if (cls.contains('sqs-block-image')) {
      const img = block.querySelector('img');
      const src = normalizeImg(img?.getAttribute('data-src') || img?.getAttribute('src') || img?.getAttribute('data-image') || '');
      if (src) {
        const cap = block.querySelector('.image-caption');
        const capTxt = cap ? cap.text.trim() : '';
        parts.push(`<figure><img src="${src}" alt="${(img.getAttribute('alt') || '').trim()}">${capTxt ? `<figcaption>${capTxt}</figcaption>` : ''}</figure>`);
      }
    }
  }
  const h1 = main.querySelector('h1');
  const og = (p) => root.querySelector(`meta[property="${p}"]`)?.getAttribute('content')
    || root.querySelector(`meta[name="${p}"]`)?.getAttribute('content') || '';
  return {
    body: sanitize(parts.join('\n')),
    title: h1 ? h1.text.trim() : '',
    image: normalizeImg(og('og:image')),
    description: og('og:description'),
  };
}

function frontmatterDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await mkdir(OUT_DIR, { recursive: true });

  const metas = await listPublishedPosts();
  console.log(`GHL: ${metas.length} published post(s).`);
  const writtenSlugs = new Set();
  let stubHeals = 0;

  for (const meta of metas) {
    const slug = meta.urlSlug;
    if (!slug) { console.warn(`  - skip post ${meta._id}: no urlSlug`); continue; }
    let rendered;
    try {
      rendered = parseRenderedPost(await fetchText(`${BLOG_HOST}/post/${slug}`));
    } catch (e) {
      console.warn(`  - ${slug}: render fetch failed (${e.message}); using list metadata only.`);
    }
    let title = (rendered?.title || meta.title || slug).trim();
    let body = rendered?.rawHTML || '';
    let image = normalizeImg(rendered?.imageUrl || '');
    let description = (rendered?.description || meta.description || '').trim();
    let source = 'ghl';

    if (isExcerptStub(body)) {
      const sqspSlug = squarespaceSlugFromStub(body) || slug;
      try {
        const full = await fetchSquarespaceArticle(sqspSlug);
        if (full && full.body && !isExcerptStub(full.body)) {
          body = full.body;
          image = image || full.image;
          description = description || full.description;
          if (full.title) title = full.title;
          source = 'squarespace-fallback';
          stubHeals++;
          console.log(`  - ${slug}: GHL body was a stub -> healed from Squarespace /bacblog/${sqspSlug}`);
        } else {
          console.warn(`  ! ${slug}: stub in GHL and no full Squarespace source; SKIPPING (won't publish a stub).`);
          continue;
        }
      } catch (e) {
        console.warn(`  ! ${slug}: stub in GHL and Squarespace fallback failed (${e.message}); SKIPPING.`);
        continue;
      }
    } else {
      body = sanitize(body);
    }

    const words = textOf(body).split(' ').filter(Boolean).length;
    const doc = {
      title,
      slug,
      description: description.slice(0, 300),
      publishedAt: frontmatterDate(rendered?.publishedAt || meta.publishedAt) || new Date(0).toISOString(),
      updatedAt: frontmatterDate(rendered?.updatedAt || meta.updatedAt),
      author: rendered?.author || 'BAC Transportation',
      image: image || DEFAULT_HERO,
      imageAlt: (rendered?.imageAlt || title).trim(),
      categories: rendered?.categories || [],
      readTime: Math.max(1, Math.round(words / 200)),
      body,
      source,
      ghlId: meta._id,
    };

    writtenSlugs.add(slug);
    const file = path.join(OUT_DIR, `${slug}.json`);
    const json = JSON.stringify(doc, null, 2) + '\n';
    if (dryRun) {
      console.log(`  [dry-run] ${slug}: ${words} words, image=${doc.image}, source=${source}`);
    } else {
      await writeFile(file, json, 'utf-8');
      console.log(`  ✓ ${slug}: ${words} words, source=${source}`);
    }
  }

  // Prune local posts that no longer exist (unpublished/deleted in GHL).
  const existing = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.json'));
  for (const f of existing) {
    const slug = f.replace(/\.json$/, '');
    if (!writtenSlugs.has(slug)) {
      if (dryRun) console.log(`  [dry-run] would prune ${f} (gone from GHL)`);
      else { await rm(path.join(OUT_DIR, f)); console.log(`  ✗ pruned ${f} (gone from GHL)`); }
    }
  }

  console.log(`Done. ${writtenSlugs.size} post(s) synced` + (stubHeals ? `, ${stubHeals} healed from Squarespace.` : '.'));
}

main().catch((e) => { console.error('Sync failed:', e); process.exit(1); });
