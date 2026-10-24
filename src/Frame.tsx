import { site } from "./data/site";

// The mark: an isometric cube outline (the room) with a small amber cube in it (the agent).
const hex = (r: number) =>
  [0, 1, 2, 3, 4, 5]
    .map((i) => {
      const a = (Math.PI / 180) * (90 + i * 60);
      return `${(32 + r * Math.cos(a)).toFixed(2)},${(32 - r * Math.sin(a)).toFixed(2)}`;
    })
    .join(" ");
export const Mark = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <polygon points={hex(26)} fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinejoin="miter" />
    <polygon className="mk-in" points={hex(10.5)} fill="#ffb224" />
  </svg>
);

export function Bar({ here }: { here: "home" | "app" }) {
  return (
    <header className="bar">
      <a className="brand" href="/" aria-label={`${site.name}, home`}>
        <Mark />
        <span>{site.name}</span>
      </a>
      {here === "home" ? (
        <a className="chip" href="/app">
          Create an agent
        </a>
      ) : (
        <a className="chip chip-quiet" href="/">
          Back to the site
        </a>
      )}
    </header>
  );
}
