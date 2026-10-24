// One clock: Lenis is driven by gsap.ticker and ScrollTrigger reads Lenis. Reduced motion means native scroll and no Lenis.
import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

export const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export const ease = { out: "expo.out", soft: "power3.out" } as const;

let lenis: Lenis | null = null;

export function initScroll() {
  if (lenis || reduced()) return;
  lenis = new Lenis({ lerp: 0.1, anchors: true });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis?.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}
export const stopScroll = () => lenis?.stop();
export const startScroll = () => lenis?.start();

/** Reveal blocks once they enter the viewport. The block slides in along its rail (see .rv in the stylesheet). */
export function watchReveals(): () => void {
  const els = [...document.querySelectorAll<HTMLElement>("[data-rv]")];
  if (reduced() || !("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("is-in"));
    return () => {};
  }
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add("is-in");
        io.unobserve(e.target);
      }),
    { rootMargin: "0px 0px -10% 0px" },
  );
  els.forEach((el) => io.observe(el));
  return () => io.disconnect();
}

/** The corner bar steps aside while the visitor scrolls down and returns on the way up. */
export function watchFrame(): () => void {
  let last = scrollY;
  const tick = () => {
    const y = scrollY;
    if (Math.abs(y - last) < 4) return;
    document.documentElement.classList.toggle("bar-away", y > 220 && y > last);
    last = y;
  };
  gsap.ticker.add(tick);
  return () => gsap.ticker.remove(tick);
}
