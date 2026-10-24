// The hero driver. One number (scroll progress through the hero, 0 to 1) places everything: how many crates are left
// on the belt, which parts of the agent are fitted, when it powers on, where the scan beam is, whether the glass room is
// closed, and which caption shows. Idle input: belt lanes run, smoke rises, the flame flickers, the core breathes and
// alert packets drift to the desk. All on gsap.ticker, paused off screen, and one still frame under reduced motion.
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { reduced } from "../engine";
import { BEAM_FROM, BEAM_TO, DESK_X, FURNACE_X, STEP_X, iso } from "./scene";

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
const along = (xWorld: number): [number, number] => [xWorld * STEP_X[0], xWorld * STEP_X[1]];

// timeline (scroll progress)
const T0 = 0.08; // the first crate starts into the furnace
const SLOT = 0.125; // scroll per crate
const POWER = [T0 + 5 * SLOT, T0 + 5 * SLOT + 0.08]; // eyes light
const TEST = [0.78, 0.9];
const ROOM = [0.9, 0.97];
const GAP = 3.2; // spacing of the queue, in world units
const PARTS = ["legs", "torso", "arms", "head", "core"];

type Cap = { el: HTMLElement; from: number; to: number };

export type WorkshopHandle = (() => void) & { set: (p: number) => void };

/** `fixed` holds one state and only idles (a figure). `view` frames the camera on a world x and a zoom. `set` moves the state later. */
export function startWorkshop(root: HTMLElement, opts: { fixed?: number; view?: { lx: number; zoom: number; oy?: number } } = {}): WorkshopHandle {
  const fixed = opts.fixed;
  const view = opts.view;
  let target = fixed ?? 0;
  let cur = fixed ?? 0;
  const handle = (fn: () => void): WorkshopHandle =>
    Object.assign(fn, {
      set: (p: number) => {
        target = p;
        if (still) draw(p, 0); // reduced motion: no easing, show the state
      },
    });
  const svg = root.querySelector<SVGSVGElement>("svg.scene");
  const cam = svg?.querySelector<SVGGElement>("[data-cam]");
  if (!svg || !cam) return handle(() => {});
  const q = <T extends Element>(sel: string) => [...cam.querySelectorAll<T>(sel)];
  const svgEl: SVGSVGElement = svg;
  const camEl: SVGGElement = cam;

  const crates = q<SVGGElement>("[data-crate]");
  const partEls = PARTS.map((id) => q<SVGGElement>(`[data-part="${id}"]`));
  const seats = q<SVGGElement>("[data-seat]");
  const flames = q<SVGGElement>("[data-flame]").map((el, i) => ({ el, bx: iso([0.5, 1.4, 2.3][i], 2.52, 0.85) }));
  const smoke = q<SVGElement>("[data-smoke]");
  const lanes = q<SVGElement>("[data-lane]");
  const burn = cam.querySelector<SVGGElement>("[data-burn]")!;
  const mouth = cam.querySelector<SVGGElement>("[data-mouth-glow]")!;
  const beam = cam.querySelector<SVGGElement>("[data-beam]")!;
  const lamp = cam.querySelector<SVGGElement>("[data-testlamp]")!;
  const glassNear = cam.querySelector<SVGGElement>("[data-room-glass]")!;
  const glassFar = cam.querySelector<SVGGElement>("[data-room-far]")!;
  const pkts = q<SVGGElement>("[data-pkt]");
  const rows = q<SVGElement>("[data-row]");
  const labs = q<SVGGElement>("[data-lab]");
  const feedline = cam.querySelector<SVGElement>("[data-feedline]")!;

  const intro = root.querySelector<HTMLElement>("[data-intro]");
  const actions = root.querySelector<HTMLElement>("[data-actions]");
  const counter = root.querySelector<HTMLElement>("[data-count]");
  const caps: Cap[] = [...root.querySelectorAll<HTMLElement>("[data-cap]")].map((el) => ({ el, from: Number(el.dataset.from), to: Number(el.dataset.to) }));
  const steps = [...root.querySelectorAll<HTMLElement>("[data-step]")];

  let vw = 0;
  let vh = 0;
  const measure = () => {
    vw = svg.clientWidth;
    vh = svg.clientHeight;
  };
  const ro = new ResizeObserver(() => {
    measure();
    if (still) draw(1, 0);
  });
  ro.observe(svg);
  measure();

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointer = (e: PointerEvent) => {
    pointer.tx = (e.clientX / innerWidth - 0.5) * 2;
    pointer.ty = (e.clientY / innerHeight - 0.5) * 2;
  };

  const setT = (el: Element, x: number, y: number, s = 1, ox = 0, oy = 0) =>
    el.setAttribute("transform", s === 1 ? `translate(${x.toFixed(1)} ${y.toFixed(1)})` : `translate(${(x + ox).toFixed(1)} ${(y + oy).toFixed(1)}) scale(${s.toFixed(3)}) translate(${(-ox).toFixed(1)} ${(-oy).toFixed(1)})`);

  let lastLabels = "";
  function draw(p: number, time: number) {
    const u = clamp((p - T0) / SLOT, 0, 5); // crates consumed so far, continuous
    const whole = Math.min(4, Math.floor(u));
    const frac = u >= 5 ? 1 : u - whole;
    const q = whole + smooth(frac) * (u >= 5 ? 0 : 1) + (u >= 5 ? 1 : 0); // eased per crate
    const active = u >= 5 ? -1 : whole; // the crate currently in the furnace
    const burning = active >= 0 ? smooth(clamp((frac - 0.2) / 0.5)) * (1 - smooth(clamp((frac - 0.75) / 0.25))) : 0;

    // ---------------- crates ----------------
    crates.forEach((g, i) => {
      const s = i - q; // slots from the furnace: 0 at the mouth, negative inside
      const x = s >= 0 ? FURNACE_X - 0.9 - GAP * s : FURNACE_X - 0.9 - s * 3.0;
      const [ax, ay] = along(x);
      const inside = clamp(-s / 0.85);
      g.style.opacity = String(inside > 0.55 ? 0 : 1);
      setT(g, ax, ay);
      const tag = g.querySelector<SVGElement>(".tag-g");
      if (tag) tag.style.opacity = s <= 0.05 ? "0" : "1";
    });

    // ---------------- parts of the agent ----------------
    partEls.forEach((els, i) => {
      const e = smooth(clamp((u - i - 0.5) / 0.5));
      for (const el of els) {
        setT(el, 0, -(1 - e) * 260);
        (el as SVGElement).style.opacity = e.toFixed(2);
      }
      if (seats[i]) (seats[i] as SVGElement).style.setProperty("--on", e.toFixed(2));
    });

    // ---------------- furnace: flame, glow, burn tag, smoke ----------------
    const flick = still ? 0.5 : 0.5 + 0.5 * Math.sin(time * 9.3);
    flames.forEach((fl, i) => {
      const s = 0.55 + 0.1 * Math.sin(time * 7 + i * 2) + burning * 0.9;
      setT(fl.el, 0, 0, s, fl.bx[0], fl.bx[1]);
    });
    mouth.style.opacity = (0.45 + 0.2 * flick + 0.35 * burning).toFixed(2);
    const [bx, by] = iso(1.3, 2.6, 3.2);
    setT(burn, 0, -burning * 26);
    burn.style.opacity = burning.toFixed(2);
    void bx;
    void by;
    smoke.forEach((c, i) => {
      const f = still ? i / 4 : (time * 0.18 + i * 0.25) % 1;
      setT(c, f * 26 + burning * 10, -f * 90 - burning * 20);
      (c as SVGElement).style.opacity = (Math.sin(f * Math.PI) * (0.35 + burning * 0.5)).toFixed(2);
    });
    const dash = still ? 0 : (time * 26) % 28;
    lanes.forEach((l) => l.setAttribute("stroke-dashoffset", (-dash).toFixed(1)));
    feedline.setAttribute("stroke-dashoffset", (-dash).toFixed(1));

    // ---------------- power on, test, room ----------------
    const lit = smooth(clamp((p - POWER[0]) / (POWER[1] - POWER[0])));
    const breathe = still ? 1 : 0.8 + 0.2 * Math.sin(time * 2.2);
    svgEl.style.setProperty("--lit", lit.toFixed(2));
    svgEl.style.setProperty("--core", (0.08 + lit * 0.92 * breathe).toFixed(2));

    const bt = clamp((p - TEST[0]) / (TEST[1] - TEST[0]));
    const [bdx, bdy] = along(lerp(0, BEAM_TO - BEAM_FROM, smooth(bt)));
    setT(beam, bdx, bdy);
    beam.style.opacity = (bt > 0 && bt < 1 ? Math.sin(bt * Math.PI) : 0).toFixed(2);
    const pass = smooth(clamp((p - (TEST[1] - 0.03)) / 0.03));
    lamp.style.opacity = pass.toFixed(2);

    const rm = smooth(clamp((p - ROOM[0]) / (ROOM[1] - ROOM[0])));
    setT(glassNear, 0, (1 - rm) * -34);
    glassNear.style.opacity = rm.toFixed(2);
    setT(glassFar, 0, (1 - rm) * -34);
    glassFar.style.opacity = rm.toFixed(2);
    svgEl.style.setProperty("--lock", smooth(clamp((p - ROOM[1] + 0.03) / 0.04)).toFixed(2));

    // alerts flow from the room to the desk once it is closed
    const flow = smooth(clamp((p - ROOM[1] + 0.02) / 0.04));
    pkts.forEach((g, i) => {
      const f = still ? (i + 0.5) / 3 : (time * 0.35 + i / 3) % 1;
      const [px, py] = along(lerp(10.4, DESK_X - 0.2, f));
      setT(g, px, py);
      g.style.opacity = (flow * Math.sin(f * Math.PI)).toFixed(2);
    });
    rows.forEach((r, i) => (r.style.fillOpacity = (0.1 + flow * (still ? 0.8 : 0.35 + 0.45 * (Math.sin(time * 1.6 + i * 2.1) > -0.2 ? 1 : 0.2))).toFixed(2)));

    // ---------------- station labels: only the one you are at stays on show ----------------
    const stationAt = p < 0.2 ? 0 : p < T0 + 5 * SLOT * 0.8 ? 1 : p < TEST[0] ? 2 : p < ROOM[0] ? 3 : 4;
    const key = String(stationAt);
    if (key !== lastLabels) {
      lastLabels = key;
      labs.forEach((l, i) => ((l as SVGElement).style.opacity = i === stationAt ? "1" : "0"));
    }

    // ---------------- camera ----------------
    const phone = vw < 900; // matches the narrow layout in the stylesheet
    const kO = phone ? (vw * 0.95) / 1330 : Math.min((vw * 0.9) / 1330, (vh * 0.82) / 740);
    // keyframes: [p, world x of the look-at point, zoom multiplier, shift right (share of width), shift down (share of height)]
    const KF: [number, number, number, number, number][] = [
      [0, 4, 0.76, 0.14, 0.27],
      [0.07, 4, 0.76, 0.14, 0.27],
      [0.16, 1.5, 1.55, 0.06, 0.12],
      [0.7, 4, 1.6, 0.06, 0.12],
      [0.8, 7.5, 1.75, 0.06, 0.12],
      [0.9, 8, 1.6, 0.06, 0.12],
      [1, 8.6, 1.25, 0.06, 0.12],
    ];
    let a = KF[0];
    let b = KF[KF.length - 1];
    for (let i = 1; i < KF.length; i++) {
      if (p <= KF[i][0]) {
        a = KF[i - 1];
        b = KF[i];
        break;
      }
    }
    const t = a === b ? 1 : smooth(clamp((p - a[0]) / (b[0] - a[0])));
    // a fixed figure at the end state is a close-up of the closed room and the desk
    const closeUp = fixed !== undefined && fixed >= 0.9;
    const calm = still && fixed === undefined; // the reduced-motion hero: the whole finished workshop, centred
    const lx = view ? view.lx : closeUp ? 10.2 : calm ? 3.5 : lerp(a[1], b[1], t);
    const zoom = view ? view.zoom : closeUp ? 1.9 : calm ? 1 : lerp(a[2], b[2], t);
    const k = kO * (phone && !closeUp && !view ? Math.min(zoom, 1.35) : zoom);
    const [cx, cy] = iso(lx, 0, 2.5);
    const ox = (closeUp || calm || view ? 0 : phone ? 0 : vw * lerp(a[3], b[3], t)) + pointer.x * 12;
    const oy = (view ? vh * (view.oy ?? 0) : closeUp ? vh * 0.03 : calm ? 0 : phone ? vh * lerp(0.28, -0.2, smooth(clamp((p - 0.04) / 0.12))) : vh * lerp(a[4], b[4], t)) + pointer.y * 8;
    const ts = clamp(0.95 / k, 1, 3.4);
    svgEl.style.setProperty("--ts", ts.toFixed(2));
    camEl.setAttribute("transform", `translate(${(vw / 2 - cx * k + ox).toFixed(1)} ${(vh / 2 - cy * k + oy).toFixed(1)}) scale(${k.toFixed(3)})`);

    // ---------------- text over the scene ----------------
    if (intro && !still) {
      const o = clamp(1 - (p - 0.04) / 0.07);
      intro.style.opacity = o.toFixed(2);
      intro.style.translate = `0 ${(-36 * (1 - o)).toFixed(1)}px`;
      if (actions) actions.style.visibility = o < 0.05 ? "hidden" : "visible";
    }
    if (counter) {
      const n = Math.min(5, Math.floor(u + (u >= 5 ? 0 : 0.35)));
      const label = n >= 5 ? "5+" : `${n} / 5`;
      if (counter.textContent !== label) counter.textContent = label;
      counter.classList.toggle("is-ok", n >= 5);
    }
    root.classList.toggle("is-moving", p > 0.05);
    caps.forEach((c) => c.el.classList.toggle("is-on", p >= c.from && p < c.to));
    steps.forEach((s, i) => s.classList.toggle("is-on", caps[i] ? p >= caps[i].from : false));
  }

  const still = reduced();
  if (still) {
    if (fixed === undefined) {
      root.classList.add("is-static");
      // nothing here is a scroll story any more, so the scroll-only UI leaves the page and the chapters read as a list
      for (const sel of [".stepper", ".meter", ".cue"]) root.querySelector(sel)?.remove();
    }
    draw(fixed ?? 1, 0);
    return handle(() => ro.disconnect());
  }

  let active = true;
  let last = 0;
  const tick = (time: number) => {
    if (!active || time - last < 1 / 50) return;
    last = time;
    cur += (target - cur) * (1 - Math.pow(0.86, gsap.ticker.deltaRatio()));
    pointer.x += (pointer.tx - pointer.x) * 0.06;
    pointer.y += (pointer.ty - pointer.y) * 0.06;
    draw(cur, time);
  };
  gsap.ticker.add(tick);
  addEventListener("pointermove", onPointer, { passive: true });
  draw(cur, 0);

  // A fixed figure keeps its state and only idles while it is on screen.
  if (fixed !== undefined) {
    const seen = ScrollTrigger.create({ trigger: root, start: "top bottom", end: "bottom top", onToggle: (s) => (active = s.isActive) });
    return handle(() => {
      gsap.ticker.remove(tick);
      removeEventListener("pointermove", onPointer);
      seen.kill();
      ro.disconnect();
    });
  }

  const st = ScrollTrigger.create({ trigger: root, start: "top top", end: "bottom bottom", onUpdate: (s) => (target = s.progress) });
  const vis = ScrollTrigger.create({
    trigger: root,
    start: "top bottom",
    end: "bottom top",
    onToggle: (s) => {
      active = s.isActive;
      document.documentElement.classList.toggle("hero-on", s.isActive);
    },
  });

  return handle(() => {
    gsap.ticker.remove(tick);
    removeEventListener("pointermove", onPointer);
    st.kill();
    vis.kill();
    ro.disconnect();
    document.documentElement.classList.remove("hero-on");
  });
}
