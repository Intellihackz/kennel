# Kennel: design

The name "Kennel" was chosen by the owner on 2026-10-23. It lives in `src/data/site.ts` (`site.name`) and in the page titles.

## Brief

- **Subject:** a product where a creator makes a private trading agent, trains it on tokens (identified by contract address; 100,000 of the platform token per token, at least 5 tokens), and then gets private alerts and optional capped auto-trade from their own wallet.
- **Audience:** people who launch or trade tokens on Pons and Robinhood Chain and want a model of their own.
- **Job of the site:** sell the idea, explain the rules in a minute, send people into the app.
- **Decisions already made by the owner:** agents are private (no directory, no leaderboard, no public pages); only the creator adds tokens; minimum 5 tokens (a minimum to unlock, not a limit); flat 100k per token, no bundle price; an agent is created with just a name (no prediction picker); no tamper-evident log; sell, don't dwell on limits, never over-claim.
- **Not claimed anywhere:** profit, returns, "alpha", accuracy numbers. Sample figures are labelled as examples.

## Concept card

```
Idea:        A workshop at night where an agent is built one crate at a time, and only walks into its locked private room once it has had five.
Metaphor:    The workshop. Tokens are crates on a conveyor, the platform token is burned in a furnace, parts are fitted to a frame.
Signature:   The sticky hero. Scroll feeds five crates through the furnace; each one fits a part to the agent (legs, torso, arms, head, core). The fifth powers it on, a scan beam passes over it (the held-out test), and a glass room closes around it with a lock.
Emotion:     Quiet competence. A private machine, switched on by you.
Motion verb: "Slide and seat": things travel on rails and settle into place, no bounces.
Screenshot:  The agent with amber eyes inside its closed glass room, the belt of empty slots behind it.
Anchor:      The minimum of five tokens and the private-by-default room. Without those two facts the scene means nothing.
```

Other concepts considered: a flight school where each token is a logged flight hour (fit is fine, but the visual is a cockpit cliché and the privacy fact has no place in it); a wind tunnel where tokens are airflows (strong image, but "testing" is only one of the five facts).

## Palette (blueprint at night)

| Role | Hex | Use |
|---|---|---|
| ground | `#08161b` | page |
| panel | `#0e2128` | cards, app surfaces |
| line | `#244650` | strokes, rules |
| ink | `#e5f0ec` | text |
| muted | `#7f9c99` | secondary text |
| amber | `#ffb224` | the agent when lit, primary actions |
| coral | `#ff6a4d` | the burn only (furnace, burn counters) |

Amber is never used as decoration. When something is amber, it is the agent or the thing you are about to do.

## Type

- **Display:** Unbounded (variable, 400 to 800), wide and round. Tracking −0.03em on large sizes. Headlines are sentence case.
- **Text and UI:** IBM Plex Mono for labels, numbers, contract addresses. Body copy is also IBM Plex Mono at 15 to 16px: the site speaks like the workshop's gauges.
- Fluid scale: h1 `clamp(2.6rem, 1rem + 5.4vw, 6.2rem)`, h2 `clamp(1.9rem, 1rem + 2.6vw, 3.6rem)`.

## Grid and shape

12 columns, gutter `clamp(16px, 2.4vw, 32px)`, page margin `clamp(16px, 4vw, 64px)`. Radius rule: 0 on the scene and on rules, 10px on app controls. Sections alternate layout: sticky stage, split with a figure, three-column ledger, centred statement, table, footer.

## Motion

- One clock: `gsap.ticker`. Lenis smooth scroll feeds ScrollTrigger. No own `requestAnimationFrame`, no scroll listeners.
- Driver module `src/motion/workshop.ts`: one variable `p` (hero scroll progress, 0 to 1) places the crates, the parts, the beam, the room and the captions.
- Idle input: belt dashes run, smoke rises, flame flickers, the core breathes, alert packets drift along the pipe. Paused off screen, still under reduced motion.
- Reduced motion: no Lenis, no pin, the hero shows the finished frame (agent lit, room closed) and the five chapters read as a list.
- Eases: `expo.out` for arrivals, `power3.out` for UI. Big things slower than small things.

## Hero chapters (driver ranges)

| p | Chapter | What the scene does |
|---|---|---|
| 0.00 to 0.08 | Intro | Five crates queued on the belt, frame empty, belt and flame idling |
| 0.04 to 0.20 | 01 Make an agent | Camera moves in, headline lifts away |
| 0.20 to 0.58 | 02 Feed it tokens | Crates 1 to 4 enter the furnace; parts 1 to 4 seat on the frame; one seat lamp lights each |
| 0.58 to 0.78 | 03 Five is the floor | Crate 5, the core fits, eyes light amber |
| 0.78 to 0.90 | 04 It has to pass a test | A scan plane crosses the agent; the arch lamp lights |
| 0.90 to 1.00 | 05 Then it is yours | Glass room closes, padlock turns amber, alerts flow to the desk |

## Pages

1. `/` landing (hero journey, what you get, the rules of the room, the price, final call).
2. `/app` app shell: sign in, your agents (private), create an agent, train with tokens and see the gates. Data is local mock state until a backend exists.
3. 404.

## Genericness test

A generic landing page for "AI trading agents" would be a dark gradient hero with a chart and a robot head. This one has no chart and no gradient: the only picture is the machine that builds the agent, and the five-address minimum is physically in the scene. Changed after the first pass: dropped a glowing orb and a "live leaderboard" idea, because the product is private.

## Decisions made during the build

- **Stack:** Vite + React, GSAP, Lenis, prerendered by `scripts/prerender.mjs` (home, `/app`, 404), hydrated on the client. Reason: no server rendering needed, and the isometric and scroll engine was reused from an earlier project.
- **Still page:** the 404 has no idle motion on purpose. It is a quiet dead end with one way back.
- **Reduced motion:** Lenis off, no pin; the hero is the headline, the finished workshop and the five chapters as a list. The scroll-only UI (stepper, counter, cue) is removed from the page, not hidden.
- **Phones:** the scene is moved to the upper half during the story and the captions sit on a scrim below it.
- **Copy rule (decided 2026-10-24):** the 100,000 per token is burned (sent to the dead address). Kennel collects nothing and takes no other fee. The furnace in the scene is now literally true.
- **The app shell is a preview:** local state only, labelled as preview on screen, all numbers made up from the contract address.

## QA record (production build, 2026-10-23)

0 console errors, 0 axe violations, nothing hidden under reduced motion, no overflow, 60 fps desktop and phone (headless, software GPU), mobile LCP about 0.7 s, CLS 0 to 0.015, audit 0 FAIL. Warnings left need a domain: canonical, sitemap, absolute og:image URL.

Self-scored from the screenshots (no separate critic was run): Design 8, Usability 8, Creativity 8.5, Content 7.5. The one thing that would raise it most is real content: the platform token's name, real sample reports, and a real wallet flow in the app.

- **Naming rule (owner, 2026-10-23):** the agent learns from *tokens*, not addresses. A contract address is only how you identify a token when adding it. Five tokens is the minimum to unlock use, never the amount needed to train. There is no prediction picker: an agent has a name and nothing else to configure at creation.
