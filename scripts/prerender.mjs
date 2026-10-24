// Writes the rendered pages into the build folder, so crawlers and visitors without JavaScript get the real content.
// The client then hydrates them. 404.html is the page for unknown addresses. OUT picks the folder (default dist).
import fs from "node:fs";
import { createServer } from "vite";

const OUT = process.env.OUT ?? "dist";

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
const { render } = await vite.ssrLoadModule("/src/entry-server.tsx");
const shell = fs.readFileSync(`${OUT}/index.html`, "utf8");
if (!shell.includes("<!--app-->")) throw new Error(`${OUT}/index.html has no <!--app--> marker`);

// a function replacement, so "$" in the markup is never read as a replacement pattern
const page = (path, title, noindex) => {
  let html = shell.replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`).replace("<!--app-->", () => render(path));
  if (noindex) html = html.replace("</head>", () => '  <meta name="robots" content="noindex" />\n  </head>');
  return html;
};

fs.writeFileSync(`${OUT}/index.html`, page("/", "Kennel: train your own trading agent", false));
fs.writeFileSync(`${OUT}/404.html`, page("/404", "Not found: Kennel", true));
fs.mkdirSync(`${OUT}/app`, { recursive: true });
fs.writeFileSync(`${OUT}/app/index.html`, page("/app", "Your agents: Kennel", true));
fs.mkdirSync(`${OUT}/burns`, { recursive: true });
fs.writeFileSync(`${OUT}/burns/index.html`, page("/burns", "Fees and burns: Kennel", false));
await vite.close();
console.log(`prerendered ${OUT}/index.html, 404.html, app/index.html and burns/index.html`);
