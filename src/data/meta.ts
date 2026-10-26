// Titles and descriptions for every page: the one place they are written. scripts/prerender.mjs turns them into the head of each page
// (canonical, Open Graph, Twitter, robots, structured data). Descriptions stay under about 160 characters and promise nothing about returns.

export const SITE = {
  name: "Kennel",
  tagline: "Train your own trading agent",
  description: "Train a private trading agent on tokens, test it on tokens it never saw, and keep its alerts in a room only you can open.",
  imageAlt: "Kennel: an isometric workshop where token crates feed a furnace and a trading agent is built, then locked in a glass room.",
};

export type PageMeta = { title: string; description: string; noindex?: boolean };

export const PAGES: Record<string, PageMeta> = {
  "/": { title: `${SITE.name}: ${SITE.tagline.toLowerCase()}`, description: SITE.description },
  "/burns": {
    title: `Fees and burns: ${SITE.name}`,
    description: "Kennel collects nothing. Every platform token paid to train an agent is burned. See the totals and how to check them on the chain.",
  },
  "/app": { title: `Your agents: ${SITE.name}`, description: "Your private agents. Sign in with your wallet to open them.", noindex: true },
  "/404": { title: `Not found: ${SITE.name}`, description: "This page does not exist.", noindex: true },
};
