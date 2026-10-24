// Writes the rendered pages into the build folder, so crawlers and visitors without JavaScript get the real content, with the right
// head on every page. The client then hydrates them. 404.html is the page for unknown addresses.
//   OUT       build folder (default dist)
//   SITE_URL  the public address, like https://kennel.example. With it, pages get canonical and absolute share-image links, and a
//             sitemap is written. Without it they are left out rather than guessed.
//   X_HANDLE  the X account without the @, for the Twitter card
import fs from "node:fs";
import { createServer } from "vite";

const OUT = process.env.OUT ?? "dist";
const SITE_URL = (process.env.SITE_URL ?? "").trim().replace(/\/+$/, "");
const X_HANDLE = (process.env.X_HANDLE ?? "").trim().replace(/^@/, "");
if (SITE_URL && !/^https?:\/\/[^/]+$/.test(SITE_URL)) throw new Error(`SITE_URL must look like https://example.com, got "${SITE_URL}"`);

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
const { render } = await vite.ssrLoadModule("/src/entry-server.tsx");
const { SITE, PAGES } = await vite.ssrLoadModule("/src/data/meta.ts");
const shell = fs.readFileSync(`${OUT}/index.html`, "utf8");
if (!shell.includes("<!--app-->")) throw new Error(`${OUT}/index.html has no <!--app--> marker`);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const abs = (p) => (SITE_URL ? SITE_URL + p : p);
// without a SITE_URL there is no honest absolute address, so there is no canonical or og:url at all (a relative one would be wrong)
const urlOf = (path) => (!SITE_URL || path === "/404" ? "" : SITE_URL + (path === "/" ? "/" : path));

function head(path) {
  const m = PAGES[path];
  const url = urlOf(path);
  const tags = [];
  if (url && !m.noindex) tags.push(`<link rel="canonical" href="${esc(url)}" />`);
  tags.push(m.noindex ? '<meta name="robots" content="noindex, nofollow" />' : '<meta name="robots" content="index, follow, max-image-preview:large" />');
  tags.push(
    '<meta property="og:type" content="website" />',
    `<meta property="og:site_name" content="${esc(SITE.name)}" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta property="og:title" content="${esc(m.title)}" />`,
    `<meta property="og:description" content="${esc(m.description)}" />`,
  );
  if (url) tags.push(`<meta property="og:url" content="${esc(url)}" />`);
  tags.push(
    `<meta property="og:image" content="${esc(abs("/og.png"))}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    `<meta property="og:image:alt" content="${esc(SITE.imageAlt)}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${esc(m.title)}" />`,
    `<meta name="twitter:description" content="${esc(m.description)}" />`,
    `<meta name="twitter:image" content="${esc(abs("/og.png"))}" />`,
    `<meta name="twitter:image:alt" content="${esc(SITE.imageAlt)}" />`,
  );
  if (X_HANDLE) tags.push(`<meta name="twitter:site" content="@${esc(X_HANDLE)}" />`, `<meta name="twitter:creator" content="@${esc(X_HANDLE)}" />`);
  if (path === "/") {
    // structured data: what the site is, stated plainly. No prices, ratings or claims about results.
    const graph = [
      { "@type": "WebSite", name: SITE.name, description: SITE.description, ...(SITE_URL ? { url: SITE_URL + "/" } : {}), inLanguage: "en" },
      { "@type": "WebApplication", name: SITE.name, description: SITE.description, applicationCategory: "FinanceApplication", operatingSystem: "Web", browserRequirements: "A browser with a wallet extension", ...(SITE_URL ? { url: SITE_URL + "/app" } : {}) },
    ];
    tags.push(`<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c")}</script>`);
  }
  return tags.map((t) => "    " + t).join("\n") + "\n  ";
}

// a function replacement everywhere, so "$" in the markup is never read as a replacement pattern
const page = (path) => {
  const m = PAGES[path];
  let html = shell
    .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(m.title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${esc(m.description)}" />`)
    .replace(/\s*<meta (?:property="og:|name="twitter:|name="robots")[^>]*>/g, "")
    .replace("</head>", () => head(path) + "</head>")
    .replace("<!--app-->", () => render(path));
  return html;
};

const write = (rel, html) => {
  const file = `${OUT}/${rel}`;
  fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  fs.writeFileSync(file, html);
};
write("index.html", page("/"));
write("404.html", page("/404"));
write("app/index.html", page("/app"));
write("burns/index.html", page("/burns"));

// robots.txt and sitemap.xml: the app is for signed-in people, so it is kept out of search
fs.writeFileSync(`${OUT}/robots.txt`, ["User-agent: *", "Allow: /", "Disallow: /app", "Disallow: /api/", ...(SITE_URL ? [`Sitemap: ${SITE_URL}/sitemap.xml`] : []), ""].join("\n"));
if (SITE_URL) {
  const day = new Date().toISOString().slice(0, 10);
  const urls = Object.entries(PAGES).filter(([, m]) => !m.noindex).map(([p]) => `  <url><loc>${SITE_URL}${p === "/" ? "/" : p}</loc><lastmod>${day}</lastmod></url>`);
  fs.writeFileSync(`${OUT}/sitemap.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
}
await vite.close();
console.log(`prerendered 4 pages into ${OUT}/ ${SITE_URL ? `for ${SITE_URL}, with sitemap.xml` : "(no SITE_URL: canonical links and the sitemap are left out)"}`);
