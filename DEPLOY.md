# Deploying Kennel

Kennel is **one service with one disk**: the website, the API, the chain indexer, the training and test worker, and the live alert scorer all run in one Node process, and the only state is one SQLite file. That shapes the hosting: it needs a **persistent volume** and exactly **one instance** (the indexer and the job runner must never run twice). Serverless hosts (Vercel, Netlify functions) will not work.

## Railway, step by step

1. **Put the repo on Railway.** New Project, Deploy from GitHub repo, pick `Intellihackz/kennel`. If it is not listed, give Railway's GitHub app access to that private repo. Railway reads `railway.json` and builds the `Dockerfile` (Node 24).
2. **Add a volume** to the service and mount it at `/data`. This is where the database lives. Without it, every deploy starts from nothing.
3. **Set the variables** on the service (Variables tab):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `SESSION_SECRET` | a long random string. Make one with `openssl rand -hex 32` |
   | `DB_PATH` | `/data/kennel.db` |
   | `TRUST_PROXY` | `1` |
   | `CLIENT_IP_HEADER` | `x-forwarded-for` (see the note below) |
   | `SITE_URL` | your public address, like `https://kennel.xyz` (optional, see "Page metadata") |
   | `X_HANDLE` | your X account without the @ (optional) |
   | `RPC_URL` | optional: a paid Robinhood Chain RPC. The public one works but is rate limited |

   Do not set `PORT`: Railway sets it. Leave `PLATFORM_TOKEN` empty until the token exists (see below).
4. **Keep it to one replica.** `railway.json` already says so. Do not scale it up.
5. **Give it an address.** Settings, Networking: generate a domain, or add your own domain (point a CNAME at the target Railway shows). Then set `SITE_URL` to that `https://` address and redeploy, so every page's head gets the right canonical link and share card.
6. **Deploy.** Every push to `main` redeploys. A deploy restarts the process, so there is a short gap (a volume can only be attached to one running instance). Training or testing that was running is queued again automatically.

**Memory:** 1 GB is comfortable. **First start:** the web server is up in seconds, but the indexer reads about three days of Pons launches and trades first (`BACKFILL_DAYS`, default 3), which takes a few minutes. The app says it is catching up and refuses token checks until it has.

**A note on `CLIENT_IP_HEADER`.** The rate limits need the visitor's real address. Railway puts it in `X-Forwarded-For`. If you ever see every visitor sharing one limit, check what your proxy sends and set this to match.

### Check that it worked

1. `https://your-address/health` answers `{"ok":true}`.
2. `https://your-address/api/status` shows `"indexer":{"ready":true,...}` once the first catch-up is done. Watch the service logs meanwhile: lines like `[indexer] trades up to block ...` are the backfill.
3. Open `/app`, connect a wallet, and make an agent.
4. View the page source of `/`: you should see the canonical link, the Open Graph tags and the JSON-LD. Paste the address into a link-preview checker (X's card validator, or any "open graph debugger") to see the share card.

### Page metadata

`SITE_URL` and `X_HANDLE` are read when the site is built, and the build runs on Railway, so set them in the variables and redeploy. With `SITE_URL` set, every page gets a canonical link, an `og:url` and absolute share-image links, and a `sitemap.xml` is written. Without it those are left out on purpose, because a wrong address is worse than none. `/app` and the 404 page are marked noindex. Titles and descriptions live in `src/data/meta.ts`.

### What lives where, and backups

- **Can be rebuilt from the chain:** the indexed launches and trades (the biggest part of the file). If the volume is lost, the indexer fills it again.
- **Cannot be rebuilt:** agents, trained models, tests, alerts, orders, burn records and credits. That is what to protect. Use Railway's volume backups if your plan has them, and consider a regular copy of the file (`sqlite3 kennel.db ".backup copy.db"` is safe while it runs).
- The file grows by roughly 25 to 40 MB per day of indexed trades. Start with a 3 to 5 GB volume.

## When the platform token exists

1. Set `PLATFORM_TOKEN` to its contract address on Railway and redeploy. Until then, production refuses to start orders (nothing can be burned, so nothing is added).
2. Try one token end to end with a small amount first: add a token in the app, confirm the burn in your wallet, and check that the token appears and `/burns` shows the burn.
3. `GET /api/burns` and the public `/burns` page then start showing real totals.

## Other hosts

- **Fly.io:** `fly.toml` is included. Create the app and a volume called `kennel_data`, set `SESSION_SECRET` with `fly secrets set`, and deploy. It uses `CLIENT_IP_HEADER=fly-client-ip`.
- **Any server with Docker:** `docker build --build-arg SITE_URL=https://your-address -t kennel .`, then run it with a volume for `DB_PATH`, port `8788`, and the variables above.

## Running it on your own machine

```bash
cp .env.example .env     # then edit it
npm install
npm run build            # builds the site
npm run server           # API, indexer and site on http://localhost:8788
```

For hot reload run `npm run server` in one terminal and `npm run dev` in another (the site on :3140 proxies `/api` to :8788). Without `PLATFORM_TOKEN` and outside production, development mode adds tokens without burning anything.

**How this was checked.** The Dockerfile itself has not been built on a machine here. Its two stages were reproduced by hand from exactly the files git ships: a clean install and build, then a production-only install that runs the server, with the full API test suite passing against it. If Railway's first build fails, its build log will say why.

## Payments are burned

Set `PLATFORM_TOKEN` (the ERC-20 address). There is no treasury: Kennel collects nothing. The app asks the user's wallet to send `PRICE_PER_TOKEN` tokens to the dead address (`0x000000000000000000000000000000000000dEaD`), then sends the transaction hash to `POST /api/orders/:id/claim`. The server reads that transaction from the chain, checks that it is a Transfer of that token, from that user, to the dead address, for at least the price, and refuses a hash that has already paid for an order.

A burn cannot be returned. So when a run fails because of a problem on our side (or a verified burn turns out to be for a token that can no longer be used), the user gets a **credit** (table `credits`): their next token is added without a new burn. Credits are used by sending a claim with no transaction hash. Failures caused by the tokens themselves (for example none of them ever moved) keep the tokens and tell the user why. Nothing is burned for a token that the checks refuse.

Two pages show the burns. `GET /api/burns` (public) gives totals and the last 14 days, with no wallet and no token named. `GET /api/me/burns` (signed in) lists one wallet's own burns with transaction links. The public page is `/burns`.

## What is not built

- Automatic trading. An ordinary wallet cannot give a server a spending cap, so alerts link to the token on Pons and the user acts from their own wallet. See SPEC.md section 10.
- Browser push and Telegram alerts. Alerts show in the app and can be posted to a webhook.
- Post-graduation trading data. Training and testing use the bonding-curve phase only.
