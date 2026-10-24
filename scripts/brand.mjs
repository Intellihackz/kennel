// Generates the brand assets into brand/ and the favicons into public/. Run after `npm run build`:
//   node scripts/brand.mjs http://127.0.0.1:4400          (needs the built site served at that URL, and Playwright)
// SVGs are written directly. PNGs are rendered in a browser, and the X banner uses the real workshop scene from the site.
import fs from "node:fs";
import path from "node:path";
import { launch } from "/Users/zed/.claude/skills/awwwards/scripts/browser.mjs";

const SITE = process.argv[2] ?? "http://127.0.0.1:4400";
const ROOT = "/Users/zed/dev/trainer";
const C = { ground: "#08161b", panel: "#0e2128", line: "#244650", ink: "#e5f0ec", muted: "#7f9c99", amber: "#ffb224" };
const w = (p, body) => (fs.mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true }), fs.writeFileSync(path.join(ROOT, p), body));

// ---------- the mark: an isometric cube outline (the room) with a small amber cube in it (the agent) ----------
const hex = (cx, cy, r) => [0, 1, 2, 3, 4, 5].map((i) => { const a = (Math.PI / 180) * (90 + i * 60); return [cx + r * Math.cos(a), cy - r * Math.sin(a)].map((n) => +n.toFixed(2)).join(","); }).join(" ");
const markBody = (outline, inner = C.amber) =>
  `<polygon points="${hex(32, 32, 26)}" fill="none" stroke="${outline}" stroke-width="4.5" stroke-linejoin="miter"/>` +
  `<polygon points="${hex(32, 32, 10.5)}" fill="${inner}"/>`;
const markSvg = (outline, bg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${bg ? `<rect width="64" height="64" fill="${bg}"/>` : ""}${markBody(outline)}</svg>`;
w("brand/mark/mark-ink.svg", markSvg(C.ink));
w("brand/mark/mark-ground.svg", markSvg(C.ground));
w("brand/mark/mark-on-ground.svg", markSvg(C.ink, C.ground));
w("public/favicon.svg", markSvg(C.ink, C.ground));
w("brand/icons/favicon.svg", markSvg(C.ink, C.ground));

// ---------- the wordmark, outlined from Unbounded 800 ----------
const wm = JSON.parse(fs.readFileSync(path.join(ROOT, "brand/fonts/wordmark.json"), "utf8"));
const pad = 40;
const wmW = wm.x2 - wm.x1;
const wmH = wm.y2 - wm.y1;
const wordmark = (fill) => `<path transform="translate(${pad - wm.x1} ${pad - wm.y1})" d="${wm.d}" fill="${fill}"/>`;
const wmSvg = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(wmW + pad * 2)} ${Math.round(wmH + pad * 2)}">${wordmark(fill)}</svg>`;
w("brand/wordmark/wordmark-ink.svg", wmSvg(C.ink));
w("brand/wordmark/wordmark-ground.svg", wmSvg(C.ground));
// lockup: the mark at the height of the x-height-ish letters, then the wordmark
const markH = wmH * 1.25;
const k = markH / 64;
const gap = wmH * 0.45;
const lockup = (outline, text) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(markH + gap + wmW + pad * 2)} ${Math.round(markH + pad * 2)}">` +
  `<g transform="translate(${pad} ${pad}) scale(${k.toFixed(4)})">${markBody(outline)}</g>` +
  `<g transform="translate(${(pad + markH + gap - wm.x1).toFixed(1)} ${(pad + (markH - wmH) / 2 - wm.y1).toFixed(1)})"><path d="${wm.d}" fill="${text}"/></g></svg>`;
w("brand/wordmark/lockup-ink.svg", lockup(C.ink, C.ink));
w("brand/wordmark/lockup-ground.svg", lockup(C.ground, C.ground));

// ---------- PNGs, rendered in a browser ----------
const browser = await launch();
const png = async (svg, size, out, bg = null) => {
  const page = await (await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })).newPage();
  await page.setContent(`<style>html,body{margin:0;background:${bg ?? "transparent"}}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: path.join(ROOT, out), omitBackground: !bg });
  await page.close();
};
for (const s of [16, 32, 48, 180, 192, 512]) {
  const name = s === 180 ? "apple-touch-icon.png" : `icon-${s}.png`;
  await png(markSvg(C.ink, C.ground), s, `brand/icons/${name}`);
}
fs.copyFileSync(path.join(ROOT, "brand/icons/apple-touch-icon.png"), path.join(ROOT, "public/apple-touch-icon.png"));
fs.copyFileSync(path.join(ROOT, "brand/icons/icon-32.png"), path.join(ROOT, "public/favicon-32.png"));
fs.copyFileSync(path.join(ROOT, "brand/icons/icon-16.png"), path.join(ROOT, "public/favicon-16.png"));
fs.copyFileSync(path.join(ROOT, "brand/icons/icon-192.png"), path.join(ROOT, "brand/icons/icon-192.png"));

// X avatar: the mark, large, on the ground colour (X crops it to a circle, so it stays inside the middle)
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-12 -12 88 88"><rect x="-12" y="-12" width="88" height="88" fill="${C.ground}"/>${markBody(C.ink)}</svg>`;
  await png(svg, 400, "brand/social/x-avatar-400.png");
}

// X banner 1500x500: the real workshop from the site (finished state), the lockup and one line
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 500 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(SITE);
  await page.waitForTimeout(1800);
  const lock = lockup(C.ink, C.ink).replace("<svg ", '<svg style="height:64px;width:auto;display:block" ');
  await page.evaluate((lockSvg) => {
    document.querySelectorAll(".bar, .intro, .caps, .vignette, #main > section:not(.hero), .foot, .skip").forEach((e) => e.remove());
    const stage = document.querySelector(".stage");
    const scene = document.querySelector("svg.scene");
    Object.assign(document.body.style, { margin: "0", overflow: "hidden", width: "1500px", height: "500px", background: "#08161b" });
    Object.assign(document.querySelector(".hero").style, { height: "500px" });
    Object.assign(stage.style, { height: "500px", padding: "0", overflow: "hidden", display: "block" });
    Object.assign(scene.style, { position: "absolute", left: "0", top: "0", width: "1500px", height: "500px", transformOrigin: "62% 52%", transform: "scale(1.55) translate(14%, 4%)" });
    const text = document.createElement("div");
    text.style.cssText = "position:absolute;left:72px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:22px;z-index:5;width:640px;background:linear-gradient(90deg,#08161b 78%,transparent)";
    text.innerHTML = `${lockSvg}<p style="margin:0;font:700 34px/1.12 'Unbounded Variable',sans-serif;letter-spacing:-0.03em;color:#e5f0ec">Train your own<br><span style="color:#ffb224">trading agent.</span></p>`;
    document.body.appendChild(text);
  }, lock);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(ROOT, "brand/social/x-banner-1500x500.png") });
  await ctx.close();
}
await browser.close();
console.log("brand assets written to brand/ and public/");
