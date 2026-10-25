// Renders the social post images into brand/social/. No site needs to be running; the cards are drawn from the brand tokens.
//   node scripts/social.mjs            (needs Playwright)
// 1600x900 (16:9) cards, which X shows uncropped in a post. Copy lives in brand/social/POSTS.md.
import fs from "node:fs";
import path from "node:path";
import { launch } from "/Users/zed/.claude/skills/awwwards/scripts/browser.mjs";

const ROOT = "/Users/zed/dev/trainer";
const C = { ground: "#08161b", panel: "#0e2128", line: "#244650", ink: "#e5f0ec", muted: "#7f9c99", amber: "#ffb224", coral: "#ff6a4d" };
const b64 = (p) => fs.readFileSync(path.join(ROOT, p)).toString("base64");
const FONTS = `
@font-face{font-family:"Unbounded";font-weight:200 900;src:url(data:font/woff2;base64,${b64("node_modules/@fontsource-variable/unbounded/files/unbounded-latin-wght-normal.woff2")}) format("woff2")}
@font-face{font-family:"Plex";font-weight:400;src:url(data:font/woff2;base64,${b64("node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2")}) format("woff2")}
@font-face{font-family:"Plex";font-weight:500;src:url(data:font/woff2;base64,${b64("node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2")}) format("woff2")}`;

// ---------- shapes ----------
const hex = (cx, cy, r) => [0, 1, 2, 3, 4, 5].map((i) => { const a = (Math.PI / 180) * (90 + i * 60); return [cx + r * Math.cos(a), cy - r * Math.sin(a)].map((n) => +n.toFixed(2)).join(","); }).join(" ");
const mark = (size, outline = C.ink) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 64 64"><polygon points="${hex(32, 32, 26)}" fill="none" stroke="${outline}" stroke-width="4.5"/><polygon points="${hex(32, 32, 10.5)}" fill="${C.amber}"/></svg>`;
const wm = JSON.parse(fs.readFileSync(path.join(ROOT, "brand/fonts/wordmark.json"), "utf8"));
const wmW = wm.x2 - wm.x1, wmH = wm.y2 - wm.y1;
const wordmark = (h, fill = C.ink) => `<svg height="${h}" viewBox="${wm.x1} ${wm.y1} ${wmW} ${wmH}"><path d="${wm.d}" fill="${fill}"/></svg>`;
const lockup = (h) => `<div class="lockup" style="--h:${h}px">${mark(Math.round(h * 1.25))}${wordmark(h)}</div>`;

// an isometric cube: top, left and right faces. r is the half width.
function cube(cx, cy, r, { top, left, right, stroke = "none", sw = 0 }) {
  const h = r * 0.5, s = r;
  const T = `${cx},${cy - s} ${cx + r},${cy - h} ${cx},${cy} ${cx - r},${cy - h}`;
  const L = `${cx - r},${cy - h} ${cx},${cy} ${cx},${cy + s} ${cx - r},${cy + h}`;
  const R = `${cx + r},${cy - h} ${cx},${cy} ${cx},${cy + s} ${cx + r},${cy + h}`;
  const a = `stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"`;
  return `<polygon points="${L}" fill="${left}" ${a}/><polygon points="${R}" fill="${right}" ${a}/><polygon points="${T}" fill="${top}" ${a}/>`;
}
const crate = (cx, cy, r, tone = "line") => {
  const t = { line: ["#2f5a66", "#1b3b45", "#143039"], amber: ["#ffcb66", "#d98f0b", "#a96c00"], coral: ["#ff9279", "#d9432a", "#a82f1b"], ink: ["#f2faf7", "#a9bfba", "#7f9c99"] }[tone];
  return cube(cx, cy, r, { top: t[0], left: t[1], right: t[2] });
};
const outlineRoom = (cx, cy, r, color = C.line, sw = 3) =>
  `<g fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round"><polygon points="${hex(cx, cy, r)}"/><polyline points="${cx},${cy} ${cx},${cy + r}"/><polyline points="${cx},${cy} ${cx - r * 0.866},${cy - r / 2}"/><polyline points="${cx},${cy} ${cx + r * 0.866},${cy - r / 2}"/></g>`;

// ---------- shared page ----------
const page = (body, extra = "") => `<!doctype html><meta charset="utf-8"><style>${FONTS}
*{box-sizing:border-box;margin:0}
html,body{width:1600px;height:900px;background:${C.ground};color:${C.ink};overflow:hidden}
body{font-family:"Plex",monospace;position:relative}
.grid{position:absolute;inset:0;background-image:linear-gradient(${C.line}22 1px,transparent 1px),linear-gradient(90deg,${C.line}22 1px,transparent 1px);background-size:80px 80px;mask-image:radial-gradient(ellipse at 70% 50%,#000 10%,transparent 75%)}
.lockup{display:flex;align-items:center;gap:calc(var(--h)*.45)}
.lockup svg{display:block}
.display{font-family:"Unbounded";font-weight:800;letter-spacing:-.045em;line-height:1.02}
.amber{color:${C.amber}}.coral{color:${C.coral}}.muted{color:${C.muted}}
.foot{position:absolute;left:96px;right:96px;bottom:64px;display:flex;justify-content:space-between;align-items:center;font-size:24px;color:${C.muted};letter-spacing:.02em}
.foot b{color:${C.ink};font-weight:500}
.top{position:absolute;left:96px;top:72px}
.art{position:absolute;inset:0}
${extra}</style>${body}`;

// ---------- the cards ----------
const cards = {};

// 1. the launch card
cards["post-1-launch"] = page(`
<div class="grid"></div>
<svg class="art" viewBox="0 0 1600 900">
  ${outlineRoom(1290, 440, 270, C.ink, 5)}
  ${crate(1290, 468, 70, "amber")}
  ${crate(1170, 570, 40, "line")}${crate(1410, 580, 40, "line")}${crate(1410, 340, 32, "line")}
</svg>
<div class="top">${lockup(46)}</div>
<h1 class="display" style="position:absolute;left:96px;top:300px;font-size:92px;white-space:nowrap">Train your own<br><span class="amber">trading agent.</span></h1>
<p style="position:absolute;left:96px;top:590px;font-size:28px;line-height:1.5;width:700px" class="muted">Add Pons tokens. It learns, takes a test on tokens it never saw, then moves into a room only you can open.</p>
<div class="foot"><b>usekennel.lol</b><span>Private. Tested. Burned, not collected.</span></div>`);

// 2. how it works, four steps
const step = (n, title, line, art, tone) => `<div class="step"><div class="n">${n}</div><svg viewBox="0 0 240 200" width="240" height="200">${art}</svg><h3 class="display">${title}</h3><p class="muted">${line}</p></div>`;
cards["post-2-how"] = page(`
<div class="grid"></div>
<div class="top">${lockup(36)}</div>
<h1 class="display" style="position:absolute;left:96px;top:170px;font-size:64px">How an agent is made.</h1>
<div class="steps">
${step("01", "Make", "Give it a name. It starts private.", `${outlineRoom(120, 100, 76, C.line, 3)}${crate(120, 108, 18, "amber")}`)}
${step("02", "Feed", "Add tokens by contract address.", `${outlineRoom(120, 120, 56, C.line, 3)}${crate(70, 40, 24, "line")}${crate(120, 100, 24, "line")}${crate(170, 60, 24, "line")}`)}
${step("03", "Test", "Scored on tokens it never saw.", `${crate(60, 130, 22, "line")}${crate(100, 150, 22, "line")}<path d="M130 120 L190 70" stroke="${C.muted}" stroke-width="3" stroke-dasharray="6 7" fill="none"/>${crate(190, 56, 28, "amber")}`)}
${step("04", "Yours", "Alerts land in a private room.", `${outlineRoom(120, 100, 76, C.ink, 4)}${crate(120, 108, 24, "amber")}`)}
</div>
<div class="foot"><b>usekennel.lol</b><span>Five tokens unlock the test. Add as many as you like.</span></div>`,
`.steps{position:absolute;left:96px;right:96px;top:300px;display:grid;grid-template-columns:repeat(4,1fr);gap:28px}
.step{border-top:2px solid ${C.line};padding-top:22px}
.step .n{font-size:22px;color:${C.amber};margin-bottom:6px}
.step h3{font-size:44px;margin:10px 0 12px}
.step p{font-size:23px;line-height:1.45;max-width:300px}`);

// 3. the test
cards["post-3-test"] = page(`
<div class="grid"></div>
<div class="top">${lockup(36)}</div>
<h1 class="display" style="position:absolute;left:96px;top:190px;font-size:92px;width:1100px">Tested on tokens<br>it <span class="amber">never saw.</span></h1>
<svg class="art" viewBox="0 0 1600 900">
  <text x="96" y="560" font-family="Plex" font-size="22" fill="${C.muted}">LEARNED FROM</text>
  ${[0, 1, 2, 3, 4].map((i) => crate(130 + i * 96, 630, 34, "line")).join("")}
  <line x1="640" y1="560" x2="640" y2="740" stroke="${C.line}" stroke-width="2" stroke-dasharray="6 8"/>
  <text x="700" y="560" font-family="Plex" font-size="22" fill="${C.amber}">THE TEST</text>
  ${[0, 1, 2, 3].map((i) => crate(734 + i * 96, 630, 34, i % 2 ? "ink" : "amber")).join("")}
</svg>
<p style="position:absolute;left:1110px;top:545px;width:440px;font-size:25px;line-height:1.5" class="muted">Scored against random alerts and a plain rule. If it is not reliably better, the room stays locked.</p>
<div class="foot"><b>usekennel.lol</b><span>Agents can be wrong. Not financial advice.</span></div>`);

// 4. private
cards["post-4-private"] = page(`
<div class="grid"></div>
<svg class="art" viewBox="0 0 1600 900">${outlineRoom(1170, 450, 330, C.ink, 5)}${crate(1170, 482, 84, "amber")}</svg>
<div class="top">${lockup(36)}</div>
<h1 class="display" style="position:absolute;left:96px;top:230px;font-size:96px;width:900px">Yours.<br><span class="muted">Only yours.</span></h1>
<ul style="position:absolute;left:96px;top:560px;list-style:none;padding:0;font-size:30px;line-height:1.9">
<li><span class="amber">+</span> No directory. No leaderboard.</li>
<li><span class="amber">+</span> Only you can add tokens.</li>
<li><span class="amber">+</span> It never trades for you.</li></ul>
<div class="foot"><b>usekennel.lol</b><span>Alerts come with their reasons.</span></div>`);

// 5. burn
cards["post-5-burn"] = page(`
<div class="grid"></div>
<svg class="art" viewBox="0 0 1600 900">
  <defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${C.coral}" stop-opacity=".35"/><stop offset="1" stop-color="${C.coral}" stop-opacity="0"/></radialGradient></defs>
  <circle cx="1170" cy="470" r="330" fill="url(#g)"/>
  ${crate(1170, 560, 64, "line")}${crate(1170, 440, 64, "coral")}${crate(1170, 330, 40, "coral")}
  <g fill="none" stroke="${C.coral}" stroke-width="4" stroke-linecap="round" opacity=".8"><path d="M1090 250 q-20 -50 0 -90"/><path d="M1170 220 q-24 -60 0 -110"/><path d="M1250 250 q22 -50 0 -90"/></g>
</svg>
<div class="top">${lockup(36)}</div>
<h1 class="display" style="position:absolute;left:96px;top:230px;font-size:96px;width:900px">Every token<br>you add is <span class="coral">burned.</span></h1>
<p style="position:absolute;left:96px;top:560px;font-size:30px;line-height:1.55;width:780px" class="muted">100,000 platform tokens go to the dead address per token. Kennel collects nothing, and every burn is on a public page.</p>
<div class="foot"><b>usekennel.lol/burns</b><span>Not an investment.</span></div>`);

// ---------- render ----------
const browser = await launch();
const dir = path.join(ROOT, "brand/social");
for (const [name, html] of Object.entries(cards)) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(html);
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: path.join(dir, `${name}.png`) });
  await ctx.close();
}
// the link preview image: the launch card at 1600x840, rendered at 0.75 so it comes out 1200x630 (the size X and others show)
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 840 }, deviceScaleFactor: 0.75 });
  const p = await ctx.newPage();
  await p.setContent(cards["post-1-launch"].replace("height:900px", "height:840px").replace("top:300px;font-size:92px", "top:250px;font-size:92px").replace("top:590px;font-size:28px", "top:535px;font-size:28px"));
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: path.join(ROOT, "public/og.png") });
  await ctx.close();
}
await browser.close();
console.log(`wrote ${Object.keys(cards).length} cards to brand/social/`);
