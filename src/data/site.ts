// Placeholders the owner must replace (flagged placeholder: true):
// - The name Kennel was chosen by the owner.
// - site.token is a generic phrase until the token has a name.
// - The 100,000 per token is BURNED (decided by the owner), burned (destroyed on Solana). Kennel collects nothing.
// - The example token contract addresses in the scene and the app are illustrations, not real tokens.

export const site = {
  name: "Kennel",
  token: "the platform token", // placeholder: true
  year: 2026,
  perToken: 100_000,
  minTokens: 5,
  minTrades: 300,
  minAgeHours: 24,
};

export const hero = {
  h1: ["Train your own", "trading agent."],
  lede: "Add tokens and watch your agent get built. Train it on as many tokens as you like. It moves into a room only you can open.",
  cta: "Create an agent",
  link: "Watch it get built",
};

export const chapters = [
  {
    n: "01",
    title: "Make an agent.",
    body: "Give it a name. It starts empty and private, from the first second.",
    from: 0.04,
    to: 0.2,
  },
  {
    n: "02",
    title: "Feed it tokens.",
    body: "Add a pump.fun token by its address. 100,000 platform tokens are burned, and the full trade history of that token goes into the agent. Only you can add tokens.",
    from: 0.2,
    to: 0.58,
  },
  {
    n: "03",
    title: "Five unlocks it.",
    body: "Five is the minimum before an agent can take its test, not the limit. Add as many tokens as you like, and it learns from every one. Each needs enough history, at least 300 trades and a day of age, or to have graduated. A token that is too thin is refused before anything is burned.",
    from: 0.58,
    to: 0.78,
  },
  {
    n: "04",
    title: "It has to pass a test.",
    body: "Once it has learned from at least five tokens, the agent is scored on tokens it never saw. If it does not beat a plain baseline it stays locked, and you can add more tokens and test it again.",
    from: 0.78,
    to: 0.9,
  },
  {
    n: "05",
    title: "Then it is yours.",
    body: "Alerts arrive in your private room with the reasoning attached, and each one links straight to the token. You decide, from your own wallet. Nothing trades for you.",
    from: 0.9,
    to: 1.01,
  },
];
export const stations = ["Make", "Feed", "Unlock", "Test", "Yours"];

export const gets = {
  title: "What one agent gives you.",
  rows: [
    { k: "The agent", v: "A saved strategy trained on every token you gave it. Export it, re-run it, keep it." },
    { k: "A test report", v: "How often its alerts were right on tokens it never saw, set against random alerts and a simple rule, the average and the worst return of its alerts, and a warning when it looks overfit." },
    { k: "Alerts with reasons", v: "Telegram, browser push or a webhook. Every alert says why it fired." },
    { k: "A journal", v: "Each decision it made, fired or not, with the time. Read it in your room." },
    { k: "A way to act", v: "Every alert links straight to the token on pump.fun. You decide and trade from your own wallet. Kennel never holds your funds." },
  ],
};

export const room = {
  title: "Nobody sees your agent but you.",
  lede: "There is no directory, no leaderboard and no public page. Your agent lives behind your wallet, at a link only you can open.",
  rules: [
    { k: "Only you add tokens", v: "Training, settings and trading all need your signature." },
    { k: "Your keys stay yours", v: "We never hold your funds, and nothing trades for you. You act on an alert from your own wallet." },
    { k: "You choose what to do", v: "An alert is a signal and a reason. Whether to act on it is always yours." },
  ],
};

export const price = {
  title: "One price per token.",
  lede: "Every token costs the same, whether it is your first or your fiftieth. There are no bundles and no tiers, so you can always count what an agent cost. All of it is burned. Kennel collects nothing.",
  perLabel: "per token",
  rows: [
    { n: 1, total: "100,000" },
    { n: 2, total: "200,000" },
    { n: 3, total: "300,000" },
    { n: 4, total: "400,000" },
    { n: 5, total: "500,000", note: "Minimum to unlock." },
    { n: 10, total: "1,000,000", note: "As many as you like." },
  ],
  foot: "Priced in the platform token, and burned: sent to an address nobody controls. Five tokens is the minimum to take the test, not a cap. A token that is too thin is refused before anything is burned.",
};

export const finale = {
  title: "Train it. Test it. Keep it private.",
  cta: "Create an agent",
};

export const footer = {
  x: { label: "@usekennel on X", href: "https://x.com/usekennel" },
  fine: "Experimental software. Not financial advice. An agent is a model: it can be wrong, and trading can lose money. The platform token is burned to train an agent. It is not an investment, and Kennel collects none of it.",
};
