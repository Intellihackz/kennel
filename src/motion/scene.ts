// The workshop, drawn once as an SVG string. View from +x, +y, +z: x runs to the lower right, y to the lower left, z is up.
// Depth order is far to near, which is also the order in the markup. Moving parts carry data-* hooks for the driver.
//
//   belt (x -16..-1)  ->  furnace (x -1..3)  ->  frame inside a glass room (x 4.6..10.4)  ->  scanner arch (x 11)  ->  desk (x 15)

export const U = 26; // pixels per world unit at camera scale 1
const C = Math.cos(Math.PI / 6);
export type P3 = [number, number, number];
export const iso = (x: number, y: number, z: number): [number, number] => [(x - y) * C * U, ((x + y) * 0.5 - z) * U];
/** Screen pixels covered by one world unit along +x. */
export const STEP_X: [number, number] = [C * U, 0.5 * U];

const f = (n: number) => +n.toFixed(1);
const P = (p: P3) => iso(...p).map(f).join(",");
const poly = (pts: P3[], cls: string, extra = "") => `<polygon class="${cls}" points="${pts.map(P).join(" ")}" ${extra}/>`;
const line = (a: P3, b: P3, cls: string, extra = "") => {
  const [x1, y1] = iso(...a);
  const [x2, y2] = iso(...b);
  return `<line class="${cls}" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ${extra}/>`;
};
const text = (at: P3, label: string, cls = "lbl", extra = "") => {
  const [x, y] = iso(...at);
  return `<text class="${cls}" x="${f(x)}" y="${f(y)}" ${extra}>${label}</text>`;
};

/** A box from its minimum corner. Faces: fl is the +y face (lower left), fr the +x face (lower right), ft the top. */
function box(x0: number, y0: number, z0: number, w: number, d: number, h: number, cls: string) {
  const x1 = x0 + w;
  const y1 = y0 + d;
  const z1 = z0 + h;
  return (
    poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], `${cls} fl`) +
    poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], `${cls} fr`) +
    poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], `${cls} ft`)
  );
}

const AX = 7.5; // the agent stands at x 7.5, y 0
export const CRATE_TAGS = ["7xKq…9Fa2", "3Hd8…pump", "Bv2m…Ye4r", "5nTz…pump", "Cw9L…u1Xs", "Gp4a…pump", "8rJf…Zk3d"]; // five are used in the story; the rest wait on the belt
export const FURNACE_X = -1; // where a crate meets the furnace
export const BEAM_FROM = 4.8;
export const BEAM_TO = 10.2;
export const DESK_X = 15;

export function sceneMarkup(): string {
  // ground: a slab and a faint grid
  let grid = "";
  for (let x = -26; x <= 23; x += 2) grid += line([x, -5, 0], [x, 5, 0], "grid");
  for (let y = -5; y <= 5; y += 2.5) grid += line([-26, y, 0], [23, y, 0], "grid");
  const floor = box(-26, -5, -0.6, 49, 10, 0.6, "m m-floor") + grid;

  // feed belt with dashed lanes that run toward the furnace
  const belt =
    box(-24, -1.15, 0, 23, 2.3, 0.5, "m m-belt") +
    [-0.6, 0.6].map((y) => line([-24, y, 0.5], [-1, y, 0.5], "lane", "data-lane")).join("");

  // seven crates, one per token (five are used in the story). Built around world x = 0 and moved by the driver.
  const crates = CRATE_TAGS.map(
    (tag, i) =>
      `<g data-crate="${i}">` +
      box(-0.9, -0.9, 0.5, 1.8, 1.8, 1.8, "m m-crate") +
      poly([[-0.55, 0.91, 1.0], [0.55, 0.91, 1.0], [0.55, 0.91, 1.55], [-0.55, 0.91, 1.55]], "plate") +
      line([-0.35, 0.91, 1.2], [0.35, 0.91, 1.2], "plate-line") +
      line([-0.35, 0.91, 1.38], [0.1, 0.91, 1.38], "plate-line") +
      `<g class="tag-g">${text([0, 0, 3.2], tag, "crate-tag")}</g>` +
      `</g>`,
  ).join("");

  // furnace: the platform token burns here. Flame sits in the mouth on the +y face.
  const flame = [0.5, 1.4, 2.3]
    .map((x, i) => {
      const w = 0.55;
      return `<polygon data-flame="${i}" class="flame" points="${[P([x - w, 2.52, 0.85]), P([x + w, 2.52, 0.85]), P([x, 2.52, 2.05])].join(" ")}"/>`;
    })
    .join("");
  const furnace =
    box(FURNACE_X, -2.5, 0, 4, 5, 3.6, "m m-furnace") +
    poly([[0.1, 2.51, 0.7], [2.7, 2.51, 0.7], [2.7, 2.51, 2.3], [0.1, 2.51, 2.3]], "mouth") +
    `<g data-mouth-glow>${flame}</g>` +
    box(0.2, -0.6, 3.6, 1.2, 1.2, 2.6, "m m-furnace2") +
    [0, 1, 2, 3].map((i) => `<circle data-smoke="${i}" class="smoke" r="${5 + i}" cx="${f(iso(0.8, 0, 6.4)[0])}" cy="${f(iso(0.8, 0, 6.4)[1])}"/>`).join("");

  // pipe from the furnace to the frame, and the frame's pad
  const pipe = box(3, -0.4, 0.6, 1.8, 0.8, 0.7, "m m-pipe") + line([3, 0, 1.3], [4.8, 0, 1.3], "feedline", "data-feedline");
  const pad = box(4.8, -2.4, 0, 5.4, 4.8, 0.4, "m m-pad");

  // the glass room: far faces first, near faces after the agent
  const RX0 = 4.6;
  const RX1 = 10.4;
  const RY0 = -2.6;
  const RY1 = 2.6;
  const RZ = 7.4;
  const glassFar =
    poly([[RX0, RY0, 0], [RX0, RY1, 0], [RX0, RY1, RZ], [RX0, RY0, RZ]], "glass gl-far") +
    poly([[RX0, RY0, 0], [RX1, RY0, 0], [RX1, RY0, RZ], [RX0, RY0, RZ]], "glass gl-far");
  const glassNear =
    poly([[RX0, RY1, 0], [RX1, RY1, 0], [RX1, RY1, RZ], [RX0, RY1, RZ]], "glass gl-near") +
    poly([[RX1, RY0, 0], [RX1, RY1, 0], [RX1, RY1, RZ], [RX1, RY0, RZ]], "glass gl-near") +
    poly([[RX0, RY0, RZ], [RX1, RY0, RZ], [RX1, RY1, RZ], [RX0, RY1, RZ]], "glass gl-top");
  // a padlock on the +y face of the room, clear of the scanner arch
  const ly = RY1 + 0.02;
  const lock =
    poly([[AX - 0.55, ly, 2.4], [AX + 0.55, ly, 2.4], [AX + 0.55, ly, 3.5], [AX - 0.55, ly, 3.5]], "lock-body") +
    `<path class="lock-shackle" d="M${P([AX - 0.3, ly, 3.5])} L${P([AX - 0.3, ly, 4.2])} L${P([AX + 0.3, ly, 4.2])} L${P([AX + 0.3, ly, 3.5])}"/>`;

  // the agent: five parts, one per token. Arms are split around the torso so the depth order stays right.
  const legs = `<g data-part="legs">${box(AX - 0.55, -0.75, 0.4, 1.1, 0.6, 1.8, "m m-agent")}${box(AX - 0.55, 0.15, 0.4, 1.1, 0.6, 1.8, "m m-agent")}</g>`;
  const armFar = `<g data-part="arms">${box(AX - 0.35, -1.65, 2.3, 0.7, 0.7, 2.0, "m m-agent")}</g>`;
  const torso =
    `<g data-part="torso">` +
    box(AX - 1.2, -0.9, 2.2, 2.4, 1.8, 2.3, "m m-agent2") +
    poly([[AX - 0.55, 0.91, 2.9], [AX + 0.55, 0.91, 2.9], [AX + 0.55, 0.91, 3.8], [AX - 0.55, 0.91, 3.8]], "core-slot") +
    `</g>`;
  const core = `<g data-part="core">${poly([[AX - 0.4, 0.92, 3.05], [AX + 0.4, 0.92, 3.05], [AX + 0.4, 0.92, 3.65], [AX - 0.4, 0.92, 3.65]], "core", "data-core")}</g>`;
  const armNear = `<g data-part="arms">${box(AX - 0.35, 0.9, 2.3, 0.7, 0.7, 2.0, "m m-agent")}</g>`;
  const head =
    `<g data-part="head">` +
    box(AX - 0.8, -0.8, 4.6, 1.6, 1.6, 1.5, "m m-agent2") +
    poly([[AX - 0.5, 0.81, 5.25], [AX - 0.12, 0.81, 5.25], [AX - 0.12, 0.81, 5.6], [AX - 0.5, 0.81, 5.6]], "eye", "data-eye") +
    poly([[AX + 0.12, 0.81, 5.25], [AX + 0.5, 0.81, 5.25], [AX + 0.5, 0.81, 5.6], [AX + 0.12, 0.81, 5.6]], "eye", "data-eye") +
    line([AX, 0, 6.1], [AX, 0, 6.7], "antenna") +
    `</g>`;
  const agent = legs + armFar + torso + core + armNear + head;

  // the held-out test: a scan plane that crosses the agent, and the arch that carries its lamp
  const beam = `<g data-beam>${poly([[BEAM_FROM, -2.2, 0.4], [BEAM_FROM, 2.2, 0.4], [BEAM_FROM, 2.2, 6.9], [BEAM_FROM, -2.2, 6.9]], "beam")}</g>`;
  const arch =
    box(11, -2.5, 0, 0.5, 0.5, 5.4, "m m-arch") +
    box(11, 2, 0, 0.5, 0.5, 5.4, "m m-arch") +
    box(11, -2.5, 5.4, 0.5, 5, 0.5, "m m-arch") +
    box(11.05, -0.35, 5.95, 0.4, 0.7, 0.35, "m m-lamp") +
    `<g data-testlamp>${poly([[11.5, -0.3, 6.0], [11.5, 0.3, 6.0], [11.5, 0.3, 6.25], [11.5, -0.3, 6.25]], "lamp-on")}</g>`;

  // five seat lamps on the floor in front of the room: one lights for every part fitted
  const seats = [0, 1, 2, 3, 4].map((i) => `<g data-seat="${i}">${box(5.2 + i * 1.0, 3.3, 0, 0.6, 0.6, 0.3, "m m-seat")}</g>`).join("");

  // alerts leave the room along the floor to the owner's desk
  const alertLine = line([RX1, 0, 0.06], [DESK_X, 0, 0.06], "alert-line");
  const packets = [0, 1, 2]
    .map((i) => `<g data-pkt="${i}">${box(-0.25, -0.25, 0.05, 0.5, 0.5, 0.5, "m m-pkt")}</g>`)
    .join("");
  const desk =
    box(DESK_X, -2.2, 0, 3.6, 3.4, 1.1, "m m-desk") +
    box(DESK_X + 0.4, -1.7, 1.1, 0.25, 2.4, 1.9, "m m-screen") +
    [2.5, 2.05, 1.6].map((z, i) => poly([[DESK_X + 0.66, -1.45, z], [DESK_X + 0.66, 0.3 - i * 0.5, z], [DESK_X + 0.66, 0.3 - i * 0.5, z + 0.22], [DESK_X + 0.66, -1.45, z + 0.22]], "row", `data-row="${i}"`)).join("");

  const labels =
    `<g data-lab="0">${text([-11.5, -1.6, 3.4], "token in", "lbl")}</g>` +
    `<g data-lab="1">${text([1, -2.2, 7.4], "100k burned", "lbl lbl-burn")}</g>` +
    `<g data-lab="2">${text([AX - 3.4, 2.7, 0.2], "agent", "lbl")}</g>` +
    `<g data-lab="3">${text([11.3, -2.6, 6.8], "held-out test", "lbl")}</g>` +
    `<g data-lab="4">${text([DESK_X + 0.2, 1.5, 0.15], "you", "lbl")}</g>` +
    `<g data-burn>${text([1.3, 2.6, 3.2], "-100,000", "burn-tag")}</g>`;

  return (
    `<g data-cam><g data-world>` +
    floor +
    belt +
    crates +
    furnace +
    pipe +
    pad +
    `<g data-room-far>${glassFar}</g>` +
    alertLine +
    agent +
    beam +
    `<g data-room-glass>${glassNear}${lock}</g>` +
    arch +
    seats +
    packets +
    desk +
    labels +
    `</g></g>`
  );
}
