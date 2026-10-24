# Running Kennel

One process does everything: the website, the API, the chain indexer, the training and test worker, and the live alert scorer. The only state is one SQLite file.

## Locally

```bash
cp .env.example .env     # then edit it (see the notes in the file)
npm install
npm run build            # builds the site
npm run server           # API + indexer + site on http://localhost:8788
```

For development with hot reload run `npm run server` in one terminal and `npm run dev` in another (the site on :3140 proxies `/api` to :8788).

On the first start the indexer reads `BACKFILL_DAYS` (default 3) of Pons launches and trades. That is about 270,000 trades and takes a few minutes. While it catches up, the app says so and refuses token checks. After that it follows the chain head every few seconds. `GET /api/status` shows the indexer lag.

Without `PLATFORM_TOKEN`, development mode adds tokens without burning anything. In production (`NODE_ENV=production`) that is off, and adding a token is refused until `PLATFORM_TOKEN` is set.

## On a host

- One instance only. The indexer and the job runner must not run twice.
- Put `DB_PATH` on a persistent volume, and back it up. Everything lives in that file: indexed trades, agents, models, orders, alerts.
- Set `SESSION_SECRET` (a long random string), `TRUST_PROXY=1` behind a proxy, and an RPC with room to breathe (`RPC_URL`).
- Docker: `docker build -t kennel .` then run it with the volume and the env vars. Port 8788.
- Disk grows by roughly 25 to 40 MB per day of indexed trades. Old trades of tokens nobody trained on can be deleted without harming anything: they are fetched again on demand.

## Payments are burned

Set `PLATFORM_TOKEN` (the ERC-20 address). There is no treasury: Kennel collects nothing. The app asks the user's wallet to send `PRICE_PER_TOKEN` tokens to the dead address (`0x000000000000000000000000000000000000dEaD`), then sends the transaction hash to `POST /api/orders/:id/claim`. The server reads that transaction from the chain, checks that it is a Transfer of that token, from that user, to the dead address, for at least the price, and refuses a hash that has already paid for an order.

A burn cannot be returned. So when a run fails because of a problem on our side (or a verified burn turns out to be for a token that can no longer be used), the user gets a **credit** (table `credits`): their next token is added without a new burn. Credits are used by sending a claim with no transaction hash. Failures caused by the tokens themselves (for example none of them ever moved) keep the tokens and tell the user why. Nothing is burned for a token that the checks refuse.

Two pages show the burns. `GET /api/burns` (public) gives totals and the last 14 days, with no wallet and no token named. `GET /api/me/burns` (signed in) lists one wallet's own burns with transaction links. The public page is `/burns`.

## What is not built

- Automatic trading. An ordinary wallet cannot give a server a spending cap, so alerts link to the token on Pons and the user acts from their own wallet. See SPEC.md section 10.
- Browser push and Telegram alerts. Alerts show in the app and can be posted to a webhook.
- Post-graduation trading data. Training and testing use the bonding-curve phase only.
