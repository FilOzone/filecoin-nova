import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, renameSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { URL } from "node:url";
import { step, success, info, c } from "./ui.js";

export interface CloneConfig {
  /** URL of the website to clone */
  url: string;
  /** Output directory (default: temp dir) */
  output?: string;
  /** Max pages to crawl (default: 50) */
  maxPages?: number;
  /** Take screenshots for comparison (default: false) */
  screenshots?: boolean;
}

export interface CloneResult {
  /** Directory containing the cloned site */
  directory: string;
  /** Number of pages crawled */
  pages: number;
  /** Number of assets downloaded */
  assets: number;
  /** Original URL */
  sourceUrl: string;
  /** Total size in bytes */
  totalSize: number;
  /** Screenshot paths (original vs clone) */
  screenshots?: { original: string; clone: string }[];
}

/**
 * mkdirSync wrapper that handles file-blocks-directory collisions.
 * When a URL like /blog/author/nick.eth is saved as a file (extname
 * sees .eth), then /blog/author/nick.eth/posts needs a directory at
 * that path, mkdirSync fails with EEXIST. This catches that and moves
 * the blocking file to file/index.html so both can coexist.
 */
function mkdirSafe(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err: any) {
    if (err.code !== "EEXIST") throw err;
    const parts = dir.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const partial = parts.slice(0, i).join("/");
      if (existsSync(partial) && statSync(partial).isFile()) {
        const tmp = partial + ".__nova_tmp";
        renameSync(partial, tmp);
        mkdirSync(partial, { recursive: true });
        renameSync(tmp, join(partial, "index.html"));
        break;
      }
    }
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Convert a URL to a safe local file path.
 * Query strings are dropped -- static servers (including IPFS gateways)
 * ignore them, so foo.jpg?width=700 serves foo.jpg.
 */
function urlToLocalPath(urlStr: string, canonicalOrigin: string): string {
  try {
    const parsed = new URL(urlStr);
    let pathname = parsed.pathname;

    if (parsed.origin !== canonicalOrigin) {
      // External assets go under _ext/<hostname>/path
      const safePath = pathname.replace(/[^a-zA-Z0-9._/-]/g, "_");
      let base = safePath.replace(/^\//, "");
      // Ensure path doesn't end with / (would create directory, not file)
      if (!base || base.endsWith("/")) base = join(base, "index.html");
      else if (!extname(base)) base = join(base, "index.html");
      return join("_ext", parsed.hostname, base);
    }

    // Same-origin
    pathname = pathname.replace(/^\//, "");
    if (!pathname || pathname.endsWith("/")) {
      pathname = join(pathname, "index.html");
    } else if (!extname(pathname)) {
      pathname = join(pathname, "index.html");
    }

    return pathname;
  } catch {
    return "index.html";
  }
}


/** Extract all same-origin page links from the DOM. */
async function extractLinks(
  page: import("playwright").Page,
  canonicalOrigin: string
): Promise<string[]> {
  const hrefs: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((h) => h.startsWith("http"))
  );

  const unique = new Set<string>();
  for (const href of hrefs) {
    try {
      const u = new URL(href);
      if (u.origin !== canonicalOrigin || u.hash) continue;
      // Only crawl pages: no extension, or .html/.htm
      const lastSegment = u.pathname.split("/").pop() || "";
      const dot = lastSegment.lastIndexOf(".");
      if (dot > 0) {
        const ext = lastSegment.slice(dot).toLowerCase();
        if (ext !== ".html" && ext !== ".htm") continue;
      }
      unique.add(u.origin + u.pathname.replace(/\/$/, ""));
    } catch {
      // skip
    }
  }
  return [...unique];
}


/**
 * Rewrite URLs in CSS content. CSS url() references are not in the DOM,
 * so this uses regex (the standard approach for CSS processing).
 */
function rewriteCssUrls(
  css: string,
  assetMap: Map<string, string>,
  cssOriginalUrl: string,
  cssLocalPath: string
): string {
  const cssDir = dirname(cssLocalPath);
  const depth = cssDir === "." ? 0 : cssDir.split("/").filter(Boolean).length;
  const prefix = depth > 0 ? "../".repeat(depth) : "./";

  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (match, quote, refUrl) => {
      if (refUrl.startsWith("data:")) return match;
      // Already rewritten to local relative path
      if (refUrl.startsWith("./") || refUrl.startsWith("../")) return match;

      try {
        const resolved = new URL(refUrl, cssOriginalUrl);
        // Look up with and without query string
        const withQuery = resolved.href;
        const noQuery = resolved.origin + resolved.pathname;
        const localPath = assetMap.get(withQuery) || assetMap.get(noQuery);
        if (localPath) {
          return `url(${quote}${prefix}${localPath}${quote})`;
        }
      } catch {
        // skip
      }
      return match;
    }
  );
}

// ISO 639-1 language codes for locale detection in JS bundles
const ISO_639_1 = new Set([
  "aa","ab","af","ak","am","an","ar","as","av","ay","az","ba","be","bg","bh","bi","bm","bn","bo",
  "br","bs","ca","ce","ch","co","cr","cs","cu","cv","cy","da","de","dv","dz","ee","el","en","eo",
  "es","et","eu","fa","ff","fi","fj","fo","fr","fy","ga","gd","gl","gn","gu","gv","ha","he","hi",
  "ho","hr","ht","hu","hy","hz","ia","id","ie","ig","ii","ik","io","is","it","iu","ja","jv","ka",
  "kg","ki","kj","kk","kl","km","kn","ko","kr","ks","ku","kv","kw","ky","la","lb","lg","li","ln",
  "lo","lt","lu","lv","mg","mh","mi","mk","ml","mn","mr","ms","mt","my","na","nb","nd","ne","ng",
  "nl","nn","no","nr","nv","ny","oc","oj","om","or","os","pa","pi","pl","ps","pt","qu","rm","rn",
  "ro","ru","rw","sa","sc","sd","se","sg","si","sk","sl","sm","sn","so","sq","sr","ss","st","su",
  "sv","sw","ta","te","tg","th","ti","tk","tl","tn","to","tr","ts","tt","tw","ty","ug","uk","ur",
  "uz","ve","vi","vo","wa","wo","xh","yi","yo","za","zh","zu",
]);

interface LocaleDetection {
  urls: string[];
  /** Default locale code (e.g. "en") — pages exist at root without this prefix */
  defaultLocale?: string;
  /** All detected locale codes */
  codes: string[];
}

/** Detect locale URLs from standard signals or JS bundle analysis. */
async function detectLocales(
  page: import("playwright").Page,
  origin: string
): Promise<LocaleDetection> {
  const htmlLang = await page.evaluate(() => document.documentElement.lang?.split("-")[0]?.toLowerCase() || "");

  // 1. <link rel="alternate" hreflang> — the HTML standard
  const hreflangLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]'))
      .map(l => l.getAttribute("href"))
      .filter((h): h is string => !!h && h.startsWith("http"))
  );
  if (hreflangLinks.length > 0) {
    // Extract codes from URLs like https://example.com/fr/
    const codes = hreflangLinks
      .map(u => { try { return new URL(u).pathname.split("/")[1]; } catch { return ""; } })
      .filter(Boolean);
    const defaultLocale = htmlLang && codes.includes(htmlLang) ? htmlLang : undefined;
    return { urls: hreflangLinks, defaultLocale, codes };
  }

  // 2. og:locale:alternate meta tags
  const ogLocales = await page.evaluate(() =>
    Array.from(document.querySelectorAll('meta[property="og:locale:alternate"]'))
      .map(m => m.getAttribute("content")?.split("_")[0] || "")
      .filter(Boolean)
  );
  if (ogLocales.length > 0) {
    const defaultLocale = htmlLang && ogLocales.includes(htmlLang) ? htmlLang : undefined;
    return { urls: ogLocales.map(code => `${origin}/${code}/`), defaultLocale, codes: ogLocales };
  }

  // 3. Scan JS bundles for locale arrays (fallback for sites without standard tags)
  const scriptSrcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script[src]")).map(s => (s as HTMLScriptElement).src)
  );

  const allScriptTexts: string[] = [];
  // Inline scripts
  const inlineTexts = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script:not([src])"))
      .map(s => s.textContent || "")
      .filter(t => t.length > 0)
  );
  allScriptTexts.push(...inlineTexts);

  // External scripts
  for (const src of scriptSrcs) {
    try {
      const text = await page.evaluate(async (url: string) => {
        const r = await fetch(url);
        return r.text();
      }, src);
      allScriptTexts.push(text);
    } catch {}
  }

  // Search all script content for arrays of 2-letter ISO 639-1 codes
  const localeArrayRe = /\[(?:"[a-z]{2}",?\s*){3,}\]/g;
  for (const text of allScriptTexts) {
    const matches = text.match(localeArrayRe) || [];
    for (const m of matches) {
      try {
        const codes = JSON.parse(m) as string[];
        if (codes.length >= 3 && codes.every(lc => ISO_639_1.has(lc))) {
          const defaultLocale = htmlLang && codes.includes(htmlLang) ? htmlLang : undefined;
          return { urls: codes.map(code => `${origin}/${code}/`), defaultLocale, codes };
        }
      } catch {}
    }
  }

  return { urls: [], codes: [] };
}

/**
 * Clone a website using Playwright.
 *
 * Strategy:
 * 1. Crawl pages, capture all network responses + scan DOM for deferred URLs
 * 2. Save assets to disk (query strings dropped from filenames)
 * 3. Rewrite HTML URLs using Playwright's page.evaluate() -- the browser
 *    resolves every URL natively (srcset, data-*, any format). No regex parsing.
 * 4. Rewrite CSS url() references (regex, standard for CSS)
 */
export async function clone(config: CloneConfig): Promise<CloneResult> {
  const playwright = await import("playwright");
  const maxPages = config.maxPages === 0 ? Infinity : (config.maxPages ?? 50);
  const takeScreenshots = config.screenshots === true;

  // Default output: ./domain-YYYYMMDD-HHMMSS/ in current directory
  let outDir = config.output;
  if (!outDir) {
    const hostname = new URL(config.url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
    outDir = join(process.cwd(), `${hostname}-${ts}`);
  }
  mkdirSync(outDir, { recursive: true });

  const visited = new Set<string>();
  const screenshots: { original: string; clone: string }[] = [];
  let assetCount = 0;
  let detectedDefaultLocale: string | undefined;
  let detectedLocaleCodes: string[] = [];

  const browser = await playwright.chromium.launch({ headless: true });
  try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    serviceWorkers: "block",
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  });

  // Step 0: Resolve canonical origin (follow redirects)
  info("Resolving URL...");
  const probePage = await context.newPage();
  await probePage.goto(config.url, { waitUntil: "domcontentloaded", timeout: 15000 });
  const canonicalUrl = new URL(probePage.url());
  const canonicalOrigin = canonicalUrl.origin;
  await probePage.close();

  const inputOrigin = new URL(config.url).origin;
  if (canonicalOrigin !== inputOrigin) {
    info(`Followed redirect: ${inputOrigin} -> ${canonicalOrigin}`);
  }

  // absolute URL -> local path (query strings stripped from paths)
  const assetMap = new Map<string, string>();
  const ssDir = outDir.replace(/\/$/, "") + "_screenshots";
  const deferredUrls = new Set<string>();
  // Track which URLs are HTML pages (for the rewrite step)
  const htmlPages = new Map<string, string>(); // originalUrl -> localPath

  // Cross-origin API response cache -- captured during crawl, replayed on the clone.
  // Frameworks (Nuxt, Next.js, React) re-fetch data after hydration. On IPFS the
  // cross-origin API calls fail (CORS) and the framework wipes SSR content.  Caching
  // the responses and injecting a fetch/XHR shim lets the framework hydrate with the
  // original data -- animations, interactions, and content all work.
  const apiResponseCache = new Map<string, { status: number; contentType: string; body: string }>();

  const queued = new Set<string>();
  const queue: string[] = [];
  const startUrl = canonicalUrl.origin + canonicalUrl.pathname.replace(/\/$/, "");
  queue.push(startUrl);
  queued.add(startUrl);
  const totalSteps = 4;

  // Fetch sitemap.xml to discover pages behind client-side navigation
  try {
    const sitemapUrls = [
      `${canonicalOrigin}/sitemap.xml`,
      `${canonicalOrigin}/sitemap_index.xml`,
    ];
    for (const sitemapUrl of sitemapUrls) {
      const resp = await context.request.get(sitemapUrl, { failOnStatusCode: false, timeout: 10000 });
      if (resp.status() >= 200 && resp.status() < 300) {
        const text = await resp.text();
        await resp.dispose();

        // Check for sitemap index (contains <sitemap><loc>...</loc></sitemap>)
        const sitemapRefs = text.match(/<sitemap>\s*<loc>(.*?)<\/loc>/g) || [];
        const childSitemapUrls: string[] = sitemapRefs.map(m =>
          (m.match(/<loc>(.*?)<\/loc>/)?.[1] || "").trim()
        ).filter(u => u.startsWith("http"));

        // Parse <loc> URLs from this sitemap (or from child sitemaps)
        const xmlTexts = [text];
        for (const childUrl of childSitemapUrls) {
          try {
            const childResp = await context.request.get(childUrl, { failOnStatusCode: false, timeout: 10000 });
            if (childResp.status() >= 200 && childResp.status() < 300) {
              xmlTexts.push(await childResp.text());
            }
            await childResp.dispose();
          } catch {}
        }

        let sitemapCount = 0;
        for (const xml of xmlTexts) {
          const locMatches = xml.match(/<loc>(.*?)<\/loc>/g) || [];
          for (const m of locMatches) {
            let url = (m.match(/<loc>(.*?)<\/loc>/)?.[1] || "").trim();
            // Normalize double slashes in path (common sitemap quirk)
            url = url.replace(/([^:])\/\//g, "$1/");
            const normalized = url.replace(/\/+$/, "");
            if (normalized.startsWith(canonicalOrigin) && !queued.has(normalized)) {
              queue.push(normalized);
              queued.add(normalized);
              sitemapCount++;
            }
          }
        }
        if (sitemapCount > 0) {
          info(`Sitemap: found ${sitemapCount} page(s) to crawl`);
        }
        if (sitemapCount > 0 || childSitemapUrls.length > 0) break; // Got a valid sitemap
      } else {
        await resp.dispose();
      }
    }
  } catch {}

  // ── Step 1: Crawl pages and intercept all network traffic ──
  step(1, totalSteps, "Crawling and capturing assets");
  console.log("");

  while (queue.length > 0 && visited.size < maxPages) {
    const currentUrl = queue.shift()!;
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    // Throttle requests to avoid CDN rate limiting
    if (visited.size > 1) await new Promise((r) => setTimeout(r, 500));

    info(`  ${visited.size}${maxPages === Infinity ? "" : `/${maxPages}`} ${currentUrl}`);

    const page = await context.newPage();
    const pageAssets: { url: string; body: Buffer; contentType: string }[] = [];
    const pendingResponses: Promise<void>[] = [];
    // We intentionally use page.content() (post-JS DOM) rather than the raw server
    // response. SSR HTML from animation-heavy sites (GSAP, ScrollTrigger) contains
    // opacity:0 / transform initial states and loader overlays. After the crawl scroll
    // cycle triggers all animations, page.content() captures the final visible state.
    // If JS crashes on the IPFS clone, elements stay visible because the saved HTML
    // is already in the post-animation state.

    page.on("response", (response) => {
      const p = (async () => {
        try {
          const url = response.url();
          const status = response.status();
          if (status < 200 || status >= 400) return;
          if (url.startsWith("data:") || !url.startsWith("http")) return;

          const contentType = response.headers()["content-type"] || "";

          // Cross-origin responses: cache API/data responses for replay on the clone
          if (!url.startsWith(canonicalOrigin)) {
            // Skip binary assets -- only cache data responses (JSON, text, XML)
            if (
              contentType.startsWith("image/") ||
              contentType.startsWith("font/") ||
              contentType.startsWith("video/") ||
              contentType.startsWith("audio/") ||
              contentType.includes("woff") ||
              contentType.includes("octet-stream") ||
              contentType.includes("javascript") ||
              contentType.includes("css")
            ) return;
            if (apiResponseCache.has(url)) return;
            const text = await response.text().catch(() => null);
            if (text && text.length > 0) {
              apiResponseCache.set(url, { status, contentType, body: text });
            }
            return;
          }

          // Same-origin responses: save as local assets
          // Skip streaming media -- browser may capture partial range responses.
          // The deferred fetch will get the full file via a clean GET request.
          if (contentType.startsWith("video/") || contentType.startsWith("audio/")) return;
          const body = await response.body().catch(() => null);
          if (body && body.length > 0) {
            pageAssets.push({ url, body, contentType });
          }
        } catch {}
      })();
      pendingResponses.push(p);
    });

    try {
      try {
        await page.goto(currentUrl, { waitUntil: "networkidle", timeout: 30000 });
      } catch (navErr: any) {
        // networkidle timed out but page likely loaded — continue with what we have.
        // Re-throw non-timeout errors (DNS failure, connection refused, etc.)
        if (!navErr.message?.includes("Timeout")) throw navErr;
      }

      // If we got redirected off-domain, skip this page entirely
      if (!page.url().startsWith(canonicalOrigin)) {
        await page.close();
        continue;
      }

      // Scroll to trigger lazy content behind scroll event listeners,
      // native loading="lazy", and IntersectionObserver-based lazy loaders
      const pageHeight = await page.evaluate(() => document.body.scrollHeight);
      for (let scrolled = 0; scrolled < pageHeight; scrolled += 900) {
        await page.mouse.wheel(0, 900);
      }
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.evaluate(() => window.scrollTo(0, 0));
      await Promise.all(pendingResponses);

      // Screenshot of original
      if (takeScreenshots && visited.size <= 5) {
        const ssPath = join(ssDir, `original-${visited.size}.png`);
        mkdirSync(ssDir, { recursive: true });
        await page.screenshot({ path: ssPath, fullPage: true });
      }

      // Universal DOM URL scanner -- try new URL() on every attribute value
      const domUrls = await page.evaluate(() => {
        const urls: string[] = [];
        const base = document.baseURI;
        for (const el of document.querySelectorAll("*")) {
          const isAnchor = el.tagName === "A";
          for (const attr of el.attributes) {
            // Skip <a> href -- navigation links, not assets to download
            if (isAnchor && attr.name === "href") continue;
            const val = attr.value.trim();
            if (!val || val.length > 2000) continue;
            if (val.startsWith("data:") || val.startsWith("javascript:") || val.startsWith("#")) continue;
            if (val.includes(",") && /\s\d+[wx]/.test(val)) {
              for (const entry of val.split(",")) {
                const raw = entry.trim().split(/\s+/)[0];
                if (raw) {
                  try {
                    const u = new URL(raw, base);
                    if (u.protocol === "http:" || u.protocol === "https:") urls.push(u.href);
                  } catch {}
                }
              }
              continue;
            }
            const raw = val.split(/\s/)[0];
            try {
              const u = new URL(raw, base);
              if (u.protocol === "http:" || u.protocol === "https:") urls.push(u.href);
            } catch {}
          }
        }
        return urls;
      });

      for (const u of domUrls) deferredUrls.add(u);

      // Hover nav triggers to reveal dropdown links (Radix/React menus open on hover, not click)
      // Only targets elements inside <nav> — FAQ accordions and other expandables are skipped
      // as they contain text content, not page links.
      const navTriggers = await page.locator("nav [aria-expanded]").all();
      const dropdownHrefs: string[] = [];
      for (const trigger of navTriggers) {
        if (await trigger.isVisible()) {
          try {
            await trigger.hover();
            await page.waitForSelector("[role='menuitem'], [data-radix-menu-content]", { timeout: 500 }).catch(() => {});
            const hrefs = await page.evaluate(() =>
              Array.from(document.querySelectorAll("a[href]"))
                .map((a) => (a as HTMLAnchorElement).href)
                .filter((h) => h.startsWith("http"))
            );
            dropdownHrefs.push(...hrefs);
          } catch {}
        }
      }

      // Extract links for further crawling
      const links = await extractLinks(page, canonicalOrigin);
      // Merge dropdown-discovered links through the same filtering
      for (const href of dropdownHrefs) {
        try {
          const u = new URL(href);
          if (u.origin !== canonicalOrigin || u.hash) continue;
          const lastSegment = u.pathname.split("/").pop() || "";
          const dot = lastSegment.lastIndexOf(".");
          if (dot > 0) {
            const ext = lastSegment.slice(dot).toLowerCase();
            if (ext !== ".html" && ext !== ".htm") continue;
          }
          const normalized = u.origin + u.pathname.replace(/\/+$/, "");
          links.push(normalized);
        } catch {}
      }
      for (const link of links) {
        if (!visited.has(link) && !queued.has(link)) {
          queue.push(link);
          queued.add(link);
        }
      }

      // Detect locale URLs on the first page (hreflang, og:locale, JS bundle scan)
      if (visited.size === 1) {
        try {
          const detection = await detectLocales(page, canonicalOrigin);
          detectedDefaultLocale = detection.defaultLocale;
          detectedLocaleCodes = detection.codes;
          for (const localeUrl of detection.urls) {
            const normalized = localeUrl.replace(/\/+$/, "");
            if (normalized && !visited.has(normalized) && !queued.has(normalized)) {
              queue.push(normalized);
              queued.add(normalized);
            }
          }
          if (detection.urls.length > 0) {
            info(`  Found ${detection.urls.length} locale variants${detection.defaultLocale ? ` (default: ${detection.defaultLocale})` : ""}`);
          }
        } catch {}

      }

      // Save captured assets
      const pagePath = urlToLocalPath(currentUrl, canonicalOrigin);
      for (const asset of pageAssets) {
        const assetNoQuery = asset.url.split("?")[0];
        if (assetMap.has(asset.url) || assetMap.has(assetNoQuery)) continue;

        // Skip page HTML from response body — we use page.content() below
        const isPageHtml = asset.contentType.includes("text/html") &&
          (asset.url === currentUrl || asset.url === currentUrl + "/" ||
           asset.url.replace(/\/$/, "") === currentUrl.replace(/\/$/, ""));
        if (isPageHtml) continue;

        const localPath = urlToLocalPath(asset.url, canonicalOrigin);
        assetMap.set(asset.url, localPath);
        assetMap.set(assetNoQuery, localPath);

        const fullPath = join(outDir, localPath);
        mkdirSafe(dirname(fullPath));
        writeFileSync(fullPath, asset.body);
        assetCount++;
      }

      // Always use page.content() for HTML — captures the post-animation DOM
      // (GSAP ScrollTrigger resolved, loader removed, all elements visible).
      // The raw response body has opacity:0 initial states from SSR.
      {
        const html = await page.content();
        const fullPath = join(outDir, pagePath);
        mkdirSafe(dirname(fullPath));
        writeFileSync(fullPath, html);
        assetMap.set(currentUrl, pagePath);
        assetMap.set(currentUrl + "/", pagePath);
        htmlPages.set(currentUrl, pagePath);
      }
    } catch (err: any) {
      info(`  ${c.yellow}Skipped:${c.reset} ${currentUrl} (${err.message})`);
    } finally {
      await page.close();
    }
  }

  success(`Crawled ${visited.size} page(s), captured ${assetCount} asset(s)`);
  if (apiResponseCache.size > 0) {
    const totalBytes = [...apiResponseCache.values()].reduce((s, r) => s + r.body.length, 0);
    info(`  Cached ${apiResponseCache.size} cross-origin API response(s) (${Math.round(totalBytes / 1024)}KB) for replay`);
  }
  console.log("");

  // ── Safari asset discovery ──
  // Some sites serve different assets to Safari (e.g. .mov instead of .webm).
  // A second pass with a Safari UA on the same Chromium browser catches these.
  const safariCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    serviceWorkers: "block",
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  });

  let safariAssetCount = 0;
  const safariTotal = htmlPages.size;
  let safariPageIdx = 0;
  info(`  Scanning ${safariTotal} page(s) with Safari UA...`);
  for (const [pageUrl] of htmlPages) {
    safariPageIdx++;
    const shortUrl = pageUrl.replace(canonicalOrigin, "") || "/";
    info(`  ${safariPageIdx}/${safariTotal} ${shortUrl}`);
    const safariPage = await safariCtx.newPage();
    try {
      try {
        await safariPage.goto(pageUrl, { waitUntil: "networkidle", timeout: 30000 });
      } catch (navErr: any) {
        if (!navErr.message?.includes("Timeout")) throw navErr;
      }
      // Extract all media source URLs from the hydrated DOM
      const mediaUrls: string[] = await safariPage.evaluate(() => {
        const urls: string[] = [];
        // <source src="..."> inside <video>/<audio>/<picture>
        for (const el of document.querySelectorAll("source[src]")) {
          urls.push((el as HTMLSourceElement).src);
        }
        // <video src="..."> and <audio src="..."> direct sources
        for (const el of document.querySelectorAll("video[src], audio[src]")) {
          urls.push((el as HTMLVideoElement).src);
        }
        // <video poster="...">
        for (const el of document.querySelectorAll("video[poster]")) {
          urls.push((el as HTMLVideoElement).poster);
        }
        // <img srcset="..."> and <source srcset="...">
        for (const el of document.querySelectorAll("[srcset]")) {
          const srcset = el.getAttribute("srcset") || "";
          for (const entry of srcset.split(",")) {
            const url = entry.trim().split(/\s+/)[0];
            if (url) urls.push(new URL(url, location.href).href);
          }
        }
        return urls.filter(u => u.startsWith("http"));
      });
      // Download new assets not already captured by the main crawl
      const newUrls = mediaUrls.filter(u => {
        const noQ = u.split("?")[0];
        return u.startsWith(canonicalOrigin) && !assetMap.has(u) && !assetMap.has(noQ);
      });
      if (newUrls.length > 0) {
        info(`    ${newUrls.length} new asset(s) to download`);
      }
      for (const url of newUrls) {
        try {
          const resp = await context.request.get(url, { failOnStatusCode: false });
          if (resp.status() >= 200 && resp.status() < 400) {
            const ct = resp.headers()["content-type"] || "";
            if (!ct.includes("text/html")) {
              const body = await resp.body();
              await resp.dispose();
              if (body.length > 0) {
                const localPath = urlToLocalPath(url, canonicalOrigin);
                const noQuery = url.split("?")[0];
                assetMap.set(url, localPath);
                assetMap.set(noQuery, localPath);
                const fullPath = join(outDir, localPath);
                mkdirSafe(dirname(fullPath));
                writeFileSync(fullPath, body);
                safariAssetCount++;
                const sizeKB = Math.round(body.length / 1024);
                info(`    ${c.green}+${c.reset} ${localPath} (${sizeKB}KB)`);
              }
            } else {
              await resp.dispose();
            }
          } else {
            await resp.dispose();
          }
        } catch {}
      }
    } catch {} finally {
      await safariPage.close();
    }
  }
  await safariCtx.close();

  if (safariAssetCount > 0) {
    assetCount += safariAssetCount;
    info(`  Found ${safariAssetCount} Safari-specific asset(s)`);
  }

  // Scan CSS for url() references not triggered during browsing
  const scannedCss = new Set<string>();
  for (const [cssOrigUrl, localPath] of assetMap) {
    if (extname(localPath).toLowerCase() !== ".css") continue;
    if (scannedCss.has(localPath)) continue;
    scannedCss.add(localPath);
    const cssPath = join(outDir, localPath);
    if (!existsSync(cssPath)) continue;
    try {
      const css = readFileSync(cssPath, "utf-8");
      const urlPattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = urlPattern.exec(css)) !== null) {
        const ref = m[2];
        if (ref.startsWith("data:")) continue;
        try {
          const abs = new URL(ref, cssOrigUrl).href;
          if (abs.startsWith("http")) deferredUrls.add(abs);
        } catch {}
      }
    } catch {}
  }

  // Fetch deferred assets using context.request (preserves cookies/auth)
  // Pre-filter: remove already-captured URLs and external URLs without file extensions
  const toFetch: string[] = [];
  for (const absoluteUrl of deferredUrls) {
    if (!absoluteUrl.startsWith("http://") && !absoluteUrl.startsWith("https://")) continue;
    const noQuery = absoluteUrl.split("?")[0];
    if (assetMap.has(absoluteUrl) || assetMap.has(noQuery)) continue;
    // URLs without a file extension are page links, not assets
    const lastSegment = noQuery.split("/").pop() || "";
    if (!lastSegment.includes(".")) continue;
    toFetch.push(absoluteUrl);
  }

  const skipped = deferredUrls.size - toFetch.length;
  if (skipped > 0) {
    info(`  ${skipped} already captured or not assets, ${toFetch.length} to fetch`);
  }

  let deferredCount = 0;
  const BATCH_SIZE = 10;
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (absoluteUrl) => {
        const noQuery = absoluteUrl.split("?")[0];
        const resp = await context.request.get(absoluteUrl, { failOnStatusCode: false });
        if (resp.status() < 200 || resp.status() >= 400) {
          await resp.dispose();
          return null;
        }
        const ct = resp.headers()["content-type"] || "";
        if (ct.includes("text/html")) { await resp.dispose(); return null; }
        const body = await resp.body();
        await resp.dispose();
        if (body.length === 0) return null;
        return { absoluteUrl, noQuery, body };
      })
    );

    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const { absoluteUrl, noQuery, body } = r.value;
      const localPath = urlToLocalPath(absoluteUrl, canonicalOrigin);
      assetMap.set(absoluteUrl, localPath);
      assetMap.set(noQuery, localPath);
      const destPath = join(outDir, localPath);
      mkdirSafe(dirname(destPath));
      writeFileSync(destPath, body);
      deferredCount++;
    }

    const done = Math.min(i + BATCH_SIZE, toFetch.length);
    if (done % 50 < BATCH_SIZE || done === toFetch.length) {
      info(`  ${done}/${toFetch.length} deferred assets checked`);
    }
  }

  if (deferredCount > 0) {
    assetCount += deferredCount;
    info(`  Fetched ${deferredCount} deferred asset(s)`);
  }

  // ── Step 2: Rewrite URLs in HTML using Playwright ──
  // The browser resolves every URL natively -- no regex parsing of srcset,
  // data-srcset, or any other format. We load each HTML file, set a <base>
  // tag so the browser resolves URLs against the original origin, then
  // iterate every element attribute and replace matching URLs with local paths.
  step(2, totalSteps, "Rewriting URLs (Playwright)");
  console.log("");

  // Build a serializable lookup: absolute URL (with & without query) -> local path
  const lookupEntries: [string, string][] = [...assetMap.entries()];

  // Single JS-disabled context for all rewrites — avoids creating 1 context per page
  const rewriteCtx = await browser.newContext({ javaScriptEnabled: false });
  const rewritePage = await rewriteCtx.newPage();
  await rewritePage.route("**/*", (route) => route.abort());

  // Inject the asset lookup map once into the page via a script tag
  await rewritePage.setContent("<html><head></head><body></body></html>", { waitUntil: "domcontentloaded" });
  await rewritePage.evaluate((entries: [string, string][]) => {
    const map = new Map<string, string>();
    for (const [k, v] of entries) {
      map.set(k, v);
      const qIdx = k.indexOf("?");
      if (qIdx > 0) map.set(k.slice(0, qIdx), v);
    }
    (window as any).__novaAssetMap = map;
  }, lookupEntries);

  // Serialize the API response cache for injection into each page
  const apiCacheObj: Record<string, { status: number; contentType: string; body: string }> = {};
  for (const [url, resp] of apiResponseCache) {
    apiCacheObj[url] = resp;
  }
  const apiCacheJSON = JSON.stringify(apiCacheObj);
  await rewritePage.evaluate((json: string) => {
    (window as any).__novaApiCache = json;
  }, apiCacheJSON);

  let rewriteCount = 0;
  const totalPages = htmlPages.size;

  for (const [origUrl, localPath] of htmlPages) {
    rewriteCount++;
    info(`  ${rewriteCount}/${totalPages} ${localPath}`);
    const fullPath = join(outDir, localPath);
    if (!existsSync(fullPath)) continue;

    let html = readFileSync(fullPath, "utf-8");

    // Skip redirect stubs -- meta-refresh triggers navigation inside setContent,
    // destroying the execution context. These pages have no content to rewrite.
    if (/http-equiv=["']?refresh/i.test(html)) continue;

    const fileDir = dirname(localPath);
    const depth = fileDir === "." ? 0 : fileDir.split("/").filter(Boolean).length;
    const relPrefix = depth > 0 ? "../".repeat(depth) : "./";

    try {
      await rewritePage.setContent(html, { waitUntil: "domcontentloaded" });

      // Inject <base> so the browser resolves URLs against the original origin
      await rewritePage.evaluate((baseUrl: string) => {
        let base = document.querySelector("base");
        if (!base) {
          base = document.createElement("base");
          document.head.prepend(base);
        }
        base.href = baseUrl;
      }, origUrl.endsWith("/") ? origUrl : origUrl + "/");

      // Rewrite all URLs in the DOM using the pre-injected asset map
      const rewrittenHtml = await rewritePage.evaluate(
        (prefix: string) => {
          const map: Map<string, string> = (window as any).__novaAssetMap;

          // Remove SRI attributes that break when served from a different origin
          // Keep crossorigin — stripping it causes credential mismatches for font/payload preloads
          for (const el of document.querySelectorAll("[integrity], [nonce]")) {
            el.removeAttribute("integrity");
            el.removeAttribute("nonce");
          }

          // React sets video.muted via JS, not as an HTML attribute.
          // Static clones miss this — Safari blocks autoplay without the attribute.
          for (const v of document.querySelectorAll("video[autoplay]:not([muted])")) {
            v.setAttribute("muted", "");
          }

          function lookup(url: string): string | undefined {
            return map.get(url)
              || map.get(url.split("?")[0])
              || map.get(url.replace(/\/$/, ""));
          }

          for (const el of document.querySelectorAll("*")) {
            const isAnchor = el.tagName === "A";
            for (const attr of el.attributes) {
              if (isAnchor && attr.name === "href") continue;
              const val = attr.value.trim();
              if (!val || val.length > 2000) continue;
              if (!val.startsWith("http://") && !val.startsWith("https://")) {
                if (val.includes(",") && /\s\d+[wx]/.test(val) && val.includes("http")) {
                  let changed = false;
                  const newVal = val.split(",").map((entry: string) => {
                    const parts = entry.trim().split(/\s+/);
                    if (parts[0].startsWith("http")) {
                      const localPath = lookup(parts[0]);
                      if (localPath) {
                        parts[0] = prefix + localPath;
                        changed = true;
                      }
                    }
                    return parts.join(" ");
                  }).join(", ");
                  if (changed) attr.value = newVal;
                }
                continue;
              }

              if (val.includes(",") && /\s\d+[wx]/.test(val)) {
                let changed = false;
                const newVal = val.split(",").map((entry: string) => {
                  const parts = entry.trim().split(/\s+/);
                  if (parts[0].startsWith("http")) {
                    const localPath = lookup(parts[0]);
                    if (localPath) {
                      parts[0] = prefix + localPath;
                      changed = true;
                    }
                  }
                  return parts.join(" ");
                }).join(", ");
                if (changed) attr.value = newVal;
                continue;
              }

              const localPath = lookup(val);
              if (localPath) {
                attr.value = prefix + localPath;
              }
            }
          }

          document.querySelector("base")?.remove();

          // Add muted attribute to dynamically-created autoplay videos.
          // React/Vue set muted via JS property, not HTML attribute;
          // Safari blocks autoplay without the attribute.
          const ms = document.createElement("script");
          ms.textContent = `new MutationObserver(m=>m.forEach(r=>r.addedNodes.forEach(n=>{if(n.querySelectorAll)for(const v of n.querySelectorAll('video[autoplay]:not([muted])'))v.setAttribute('muted','')}))).observe(document.documentElement,{childList:true,subtree:true})`;
          document.head.prepend(ms);

          // Inject API response cache -- frameworks (Nuxt, Next.js, React) re-fetch
          // data on client render. On IPFS the cross-origin API calls fail (CORS).
          // This shim replays the original responses captured during crawl so the
          // framework renders with real data.
          const cacheJSON: string = (window as any).__novaApiCache;
          if (cacheJSON && cacheJSON !== "{}") {
            const cs = document.createElement("script");
            cs.textContent = `(function(){`
              + `var c=${cacheJSON};`
              + `var oF=window.fetch;`
              + `window.fetch=function(){`
              +   `var u=typeof arguments[0]==="string"?arguments[0]:(arguments[0]&&arguments[0].url)||"";`
              +   `if(c[u]){var r=c[u];return Promise.resolve(new Response(r.body,{status:r.status,headers:{"content-type":r.contentType}}))}`
              +   `if(u.startsWith("http")&&!u.startsWith(location.origin))return new Promise(function(){});`
              +   `return oF.apply(this,arguments)};`
              + `var oO=XMLHttpRequest.prototype.open;var oS=XMLHttpRequest.prototype.send;`
              + `XMLHttpRequest.prototype.open=function(m,u){`
              +   `this._nu=typeof u==="string"?u:"";this._nc=null;this._nb=false;`
              +   `if(c[this._nu])this._nc=c[this._nu];`
              +   `else if(this._nu.startsWith("http")&&!this._nu.startsWith(location.origin))this._nb=true;`
              +   `return oO.apply(this,arguments)};`
              + `XMLHttpRequest.prototype.send=function(){`
              +   `if(this._nc){var r=this._nc,x=this;`
              +     `Object.defineProperty(x,"status",{get:function(){return r.status}});`
              +     `Object.defineProperty(x,"responseText",{get:function(){return r.body}});`
              +     `Object.defineProperty(x,"response",{get:function(){return r.body}});`
              +     `Object.defineProperty(x,"readyState",{get:function(){return 4}});`
              +     `x.getResponseHeader=function(h){return h.toLowerCase()==="content-type"?r.contentType:null};`
              +     `x.getAllResponseHeaders=function(){return"content-type: "+r.contentType+"\\r\\n"};`
              +     `setTimeout(function(){x.dispatchEvent(new Event("readystatechange"));x.dispatchEvent(new Event("load"));x.dispatchEvent(new Event("loadend"))},0);`
              +     `return}`
              +   `if(this._nb)return;`
              +   `return oS.apply(this,arguments)}`
              + `})();`;
            // Must be FIRST script in <head> so it patches fetch/XHR before any
            // framework code executes
            document.head.insertBefore(cs, document.head.firstChild);
          }

          const doctype = document.doctype;
          const dt = doctype
            ? `<!DOCTYPE ${doctype.name}${doctype.publicId ? ` PUBLIC "${doctype.publicId}"` : ""}${doctype.systemId ? ` "${doctype.systemId}"` : ""}>`
            : "<!DOCTYPE html>";
          return dt + "\n" + document.documentElement.outerHTML;
        },
        relPrefix
      );

      writeFileSync(fullPath, rewrittenHtml);
    } catch (err: any) {
      info(`  ${c.yellow}Rewrite failed:${c.reset} ${localPath} (${err.message})`);
    }
  }

  await rewritePage.close();
  await rewriteCtx.close();

  success("HTML URLs rewritten");
  console.log("");

  // ── Step 3: Rewrite CSS url() references ──
  step(3, totalSteps, "Resolving CSS references");
  console.log("");

  let cssCount = 0;
  const processedCss = new Set<string>();
  for (const [origUrl, localPath] of assetMap) {
    if (extname(localPath).toLowerCase() !== ".css") continue;
    if (processedCss.has(localPath)) continue;
    processedCss.add(localPath);
    cssCount++;
    info(`  ${cssCount} ${localPath}`);
    const fullPath = join(outDir, localPath);
    if (!existsSync(fullPath)) continue;
    try {
      let css = readFileSync(fullPath, "utf-8");
      css = rewriteCssUrls(css, assetMap, origUrl, localPath);
      writeFileSync(fullPath, css);
    } catch {}
  }

  success("CSS references resolved");
  console.log("");

  // ── Mirror root pages into default locale prefix ──
  // Sites like Next.js serve English at / (no prefix) but language switchers
  // construct /en/page URLs. On IPFS there's no server to redirect, so we
  // copy non-prefixed pages into the default locale directory.
  if (detectedDefaultLocale && detectedLocaleCodes.length > 0) {
    const defLoc = detectedDefaultLocale;
    const locPrefixes = detectedLocaleCodes.map(code => `${code}/`);
    const defLocDir = join(outDir, defLoc);

    let mirrorCount = 0;

    const mirrorDir = (srcDir: string, destDir: string) => {
      if (!existsSync(srcDir)) return;
      for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
        const srcPath = join(srcDir, entry.name);
        const destPath = join(destDir, entry.name);

        if (entry.isDirectory()) {
          // Skip locale-prefixed directories (don't mirror /zh/ into /en/zh/)
          if (locPrefixes.includes(entry.name + "/")) continue;
          // Skip internal directories
          if (entry.name.startsWith("_")) continue;
          mirrorDir(srcPath, destPath);
          continue;
        }

        if (!entry.name.endsWith(".html") && !entry.name.endsWith(".htm")) continue;
        // Skip files already created by the crawler (e.g. /en/index.html from redirect)
        if (existsSync(destPath)) continue;

        // Read HTML content and adjust relative paths (one level deeper).
        // Files move from /page/index.html to /en/page/index.html, so every
        // relative reference needs one extra ../ to reach the same target.
        // ./foo → ../foo, ../foo → ../../foo, ../../foo → ../../../foo
        let html = readFileSync(srcPath, "utf-8");
        html = html.replace(
          /((?:href|src|action|poster|data-src)=["'])(\.\/|(?:\.\.\/)+)/g,
          (_match, attr, relPath) => `${attr}../${relPath === "./" ? "" : relPath}`
        );
        // srcset/data-srcset need per-entry adjustment (comma-separated values)
        html = html.replace(
          /((?:srcset|data-srcset)=["'])([^"']*)/g,
          (_match, attr, value) =>
            attr + value.replace(/(^|,\s*)(\.\/|(?:\.\.\/)+)/g,
              (_m: string, sep: string, rel: string) => `${sep}../${rel === "./" ? "" : rel}`)
        );

        mkdirSafe(destDir);
        writeFileSync(destPath, html);
        mirrorCount++;
      }
    };

    mirrorDir(outDir, defLocDir);

    if (mirrorCount > 0) {
      info(`  Mirrored ${mirrorCount} page(s) into /${defLoc}/ for default locale`);
    }
  }

  // ── Step 4: Verify clone with screenshots ──
  step(4, totalSteps, "Verifying clone");
  console.log("");

  if (takeScreenshots) {
    const visitedPages = [...visited];
    for (let i = 1; i <= Math.min(visited.size, 5); i++) {
      const pagePath = urlToLocalPath(visitedPages[i - 1], canonicalOrigin);
      const filePath = join(outDir, pagePath);
      if (!existsSync(filePath)) continue;

      const page = await context.newPage();
      try {
        await page.goto(`file://${filePath}`, { waitUntil: "load", timeout: 10000 });
        await page.waitForLoadState("networkidle").catch(() => {});

        // Scroll to trigger lazy-load and scroll-based animations
        const cloneHeight = await page.evaluate(() => document.body.scrollHeight);
        for (let scrolled = 0; scrolled < cloneHeight; scrolled += 900) {
          await page.mouse.wheel(0, 900);
        }
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.evaluate(() => window.scrollTo(0, 0));

        const cloneSsPath = join(ssDir, `clone-${i}.png`);
        mkdirSync(ssDir, { recursive: true });
        await page.screenshot({ path: cloneSsPath, fullPage: true });
        screenshots.push({
          original: join(ssDir, `original-${i}.png`),
          clone: cloneSsPath,
        });
      } catch {} finally {
        await page.close();
      }
    }
  }

  await browser.close();
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }

  success("Clone complete");

  // Calculate total size
  let totalSize = 0;
  const countSize = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) countSize(p);
      else totalSize += statSync(p).size;
    }
  };
  countSize(outDir);

  return {
    directory: outDir,
    pages: visited.size,
    assets: assetCount,
    totalSize,
    sourceUrl: config.url,
    screenshots,
  };
}
