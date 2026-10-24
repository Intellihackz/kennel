# Kennel: backend spec

Status: draft for the owner. Written 2026-10-23 from the product rules decided in conversation. Anything marked **Decision** needs an answer before it is built.

## 1. What is being built

A user connects a wallet, creates an agent with just a name, and trains it on tokens. Each token costs 100,000 of the platform token. Five tokens is the minimum before the agent can be used. The agent then takes a held-out test. If it passes, its private room opens: alerts with reasons, and optional capped auto-trade.

Rules that are not up for debate (already decided):

- Agents are private. There is no directory, no leaderboard, no public page. No tamper-evident log.
- Only the creator can add tokens, change settings or turn trading on.
- Five tokens is the minimum to unlock use. It is never described as the amount needed to train. Any number can be added.
- Flat price per token, no bundles or tiers.
- A token that is too thin (under 300 trades and under 24 hours old, unless graduated) is refused before any payment.
- An agent is created with a name only. There is no prediction picker.
- No claims about returns, accuracy or profit anywhere.

## 2. Architecture

```
Robinhood Chain RPC
      |
  [indexer]  ->  [store: Postgres]  <-  [api: Hono, TypeScript]  <-  web app
      |                 |                        |
      |           [feature builder]        [payments watcher]
      |                 |                        |
      |           [trainer: Python worker]  <----+  (job queue)
      |                 |
      |           [model registry: object storage + db rows]
      |                 |
      +-----> [live scorer] -> [alert engine] -> [notifiers: web push, Telegram, webhook]
                                      |
                              [trade executor]  (phase 3, see section 9)
```

- **API and web server:** Node 22, Hono, TypeScript. Reuses the stack from earlier projects.
- **Trainer:** a small Python worker (LightGBM, scikit-learn). It consumes jobs from a queue (Postgres `jobs` table is enough to start). Python is used only here.
- **Store:** Postgres. Raw trades are the largest table.
- **Model files:** ONNX, kept in object storage, loaded by the live scorer with `onnxruntime-node`, so scoring stays in the Node process.
- **One region, one API instance** to begin with. The indexer is the only thing that must not run twice.

## 3. Chain data (the indexer)

Facts about Pons v2 on Robinhood Chain (chain id 4663), taken from its docs and from earlier work:

- Factory emits `TokenLaunched(token, curve, deployer, pairToken, launchConfigId, graduationThreshold)`.
- Each token has a bonding curve that emits `CurveBuy(buyer, recipient, quoteIn, tokensOut, fee, tax)` and `CurveSell(seller, recipient, tokensIn, quoteOut, fee, tax)`. `tax` includes the snipe tax on buys.
- The curve exposes `getReserves()`, `realQuoteReserve()`, `graduationThreshold()`, `graduated()`, `feeBps()`. Fee is about 1% per trade. Graduation is at about 4.2 ETH of real quote reserve.
- After graduation trading moves to a standard pool. Trades there need a second indexer path (Swap events on the pool). **Decision:** v1 trains only on the curve phase, and treats graduation as an outcome, not as trading data.
- ERC-20 `Transfer` events give holders and concentration.

What to store:

| Table | Columns (main ones) |
|---|---|
| `tokens` | address, curve, deployer, name, symbol, launched_block, launched_at, graduated_at, supply |
| `trades` | token, block, ts, tx, log_index, side, wallet, quote_wei, tokens, fee, tax |
| `transfers` | token, block, ts, from, to, amount (only holder-relevant) |
| `snapshots` | token, ts, quote_reserve, token_reserve, real_reserve (sampled, for features) |

Indexer rules:

- Start from the factory's first block, backfill in block ranges of at most 2,000, then follow the head every 2 to 3 seconds.
- Store `(block, log_index)` as the unique key so re-reading a range is harmless. Keep the last 20 blocks as unconfirmed and re-check them for reorgs.
- Use a dedicated RPC provider, not the public endpoint, once volume grows. Expect rate limits on `eth_getLogs`.
- Everything the indexer reads is public chain data. Nothing about users is stored here.

## 4. Token eligibility (checked before payment)

`GET /api/tokens/check?address=0x...` returns `{ ok, reason?, trades, ageHours, graduated }`.

A token is accepted when it has at least 300 trades and at least 24 hours since launch, or it has graduated. The check reads the indexed tables, not the RPC, so it is fast and cannot be gamed by timing. A refused token is never charged. If the indexer has not finished syncing the token, the answer is "not ready yet", also without charge.

## 5. Training

### 5.1 One objective for every agent

With no prediction picker, every agent learns the same thing, and what differs between agents is **which tokens it learned from**. The objective:

> At a given moment in a token's life, will buying now produce a net return of at least +X% (after the curve fee and any snipe tax) at some point within the next H hours?

- Defaults: X = 20, H = 3. **Decision:** confirm or change these. They set what "a good moment" means for everyone.
- The label is computed from real prices on the curve, including fees, so it cannot look better than the fee-adjusted reality.

### 5.2 Samples

For each token the agent is trained on, take one sample every minute for its first 24 hours on the curve (and until graduation if sooner). Each sample has features known at that moment only.

Features (all computed from the indexed tables, strictly from the past):

- age, number of trades, trades per minute over 1, 5 and 30 minutes
- distinct buyers, new buyers per minute, buy/sell ratio, net quote flow
- curve progress (`real / threshold`), price change over 5, 30 and 120 minutes
- size of the largest 1 and 5 buyers as a share of supply, holder count, top-10 concentration
- share of buys that paid snipe tax, deployer holdings, deployer sells
- time of day (UTC)

### 5.3 Training procedure

- Gradient-boosted trees (LightGBM), shallow (depth 4), 200 trees, early stopping on a validation slice. Small on purpose: there is little data and many tokens are short-lived.
- Split **by time inside each token** (first 70% train, next 15% validation). The last 15% of each token is not used for testing here: testing is on other tokens (section 6).
- Weight samples so each token counts equally, otherwise one busy token dominates.
- Class imbalance is expected (most moments are not good ones). Use balanced class weights and report precision at the alert threshold, not accuracy.
- The run is deterministic given its inputs (fixed seed, pinned library versions), so a repeat run gives the same file.
- Output: `model.onnx`, `meta.json` (token list, feature list, X, H, library versions, data window, training time), and a calibration table.

### 5.4 Incremental runs

Each added token **retrains from scratch** on the agent's full token set. This keeps results reproducible and avoids drift from stacking updates. At the expected sizes (5 to 50 tokens, tens of thousands of samples) a run takes seconds to a minute on one CPU core.

### 5.5 Selection bias (important)

A user who only adds tokens that went up teaches the agent that everything goes up. That is a real property of "learn from the tokens I chose", not a bug. The held-out test in section 6 is what exposes it: the test pool is sampled by the platform, not chosen by the user. The report must show the share of the agent's tokens that reached the outcome, so this is visible.

## 6. The held-out test

Runs on demand once an agent has at least five tokens (or automatically after each training run, **Decision**).

- **Pool:** tokens the platform samples at random from eligible tokens that are not in the agent's training set and launched after the agent's earliest token. Fixed size, 30 tokens by default.
- **Metric:** at the agent's alert threshold, compare the agent's alerts with two baselines:
  1. *Base rate:* alerting at random at the same frequency.
  2. *Simple rule:* alert when the 5-minute buy count is in the top quintile.
- **Pass:** the agent's precision beats both baselines by a margin (default 1.2x), **and** its alerts cover at least 5 distinct held-out tokens (so it is not one lucky token), **and** the lower bound of a bootstrap confidence interval is above the baseline.
- **Report (shown only to the owner):** number of held-out tokens, alerts fired, precision versus both baselines, the fee-adjusted average return of its alerts, worst single alert, an overfit warning when the validation score is far above the test score.
- A failed test keeps the room locked. Adding tokens and testing again is always allowed. Every test draws a fresh pool, so repeating it until it passes is a real risk. **Decision:** limit tests to a few per day, or use a fixed pool per agent version.

The test shows the agent is better than simple rules on unseen tokens, nothing more. The UI and the copy must say that and no more.

## 7. Payments (the platform token)

> **Decided 2026-10-24: payments are burned, Kennel collects nothing.** The text below describes the earlier treasury design. What was built: the user sends the tokens to the dead address, the server verifies that Transfer, and a failure on our side is repaid with a credit (a burn cannot be returned). See DEPLOY.md.

- The user sends `100,000 x n` tokens from their wallet to a treasury address, one ERC-20 transfer per training run, with the agent id and token address in a signed order (see below).
- Flow: (1) `POST /api/agents/:id/train {token}` creates an **order** with a nonce and an expiry, returns the amount and the transfer details. (2) The user sends the transfer. (3) The payments watcher sees the `Transfer` log, matches it to the order by sender, amount and a memo (an order id appended through a deposit-address-per-order, or a signed message verified with the transfer), marks it paid, and queues the training job. (4) If the job fails for a reason that is ours, the order is refunded to the sender automatically.
- Orders are idempotent: the same transfer can only settle one order.
- Eligibility is re-checked when the order is created and again when payment settles.
- **Decision:** are the tokens burned or kept? Until decided, the UI says "paid".
- **Decision:** the price is a fixed number of platform tokens (100,000). If the token price moves, the real cost moves too. Either accept that, or price in a dollar amount and show the token amount live. Fixed is simpler and matches what was decided.

## 8. Accounts, privacy and security

- **Sign-in:** sign a one-time message with the wallet (SIWE style: nonce, domain, expiry). The server verifies it and issues a session token (HMAC, 7 days). No passwords, no email required.
- **Ownership:** every agent row has `owner` (lowercase address). Every read and write checks the session address equals `owner`. There are no endpoints that list or search agents across owners.
- **IDs:** agent ids are random, 16 bytes. Even so, access control relies on ownership checks, not on secrecy of the id.
- **Privacy:** no analytics on agent contents. Do not log token lists, alerts or reports. Keep the minimum: the owner, the token set, the model, the alerts.
- **Rate limits:** per session and per IP on sign-in, token checks, order creation and test runs.
- **Deletion:** the owner can delete an agent and everything derived from it.
- **Trust statement for users:** the operator can technically read the data. Say so in the product's privacy text.

## 9. Alerts and the room

- The live scorer runs every new trade (or every minute per active token) through each active agent's model for tokens in their first 24 hours on the curve.
- **Scale note:** scoring cost is (agents x live tokens). With hundreds of agents and a few hundred live tokens this is fine on one machine. Beyond that, batch by model.
- An alert carries: token, probability, the three features that pushed it most (from tree contributions), and the time. Alerts are deduplicated per token and per agent for a cooldown (default 30 minutes).
- Channels: browser push first, then Telegram bot, then webhook. **Decision:** which first. Browser push needs no third party.
- The journal keeps every scored decision that fired, with its reasons, for the owner only.
- Alerts are not advice and say "confidence" only as the model's own calibrated probability, shown with its calibration.

## 10. Auto-trade (the part that needs a decision)

The site currently says auto-trade "spends only from your own wallet, inside the caps you set". **A normal wallet cannot grant a server a spending cap.** An EOA either signs each transaction or hands over its key. So the sentence is only true with one of these designs:

| Option | How | Cost | Custody |
|---|---|---|---|
| A. Alert plus one-click trade | The alert contains a prefilled buy on the curve. The user signs it. | Small | None. Not "auto" |
| B. Agent wallet | The user funds a separate wallet that the server controls. Caps enforced by the server. | Medium | The server holds a key for a small balance. The user can withdraw at any time |
| C. Smart account with a session key | The user uses an ERC-4337 account that grants a scoped, revocable key to the agent. Caps enforced on chain. | Large, and depends on Robinhood Chain's account-abstraction support | None. This matches the copy |

**Recommendation:** ship phases 1 and 2 with option A (alerts and one-click trade), say "trade from your wallet with one click", and only describe "auto-trade" when B or C exists. Option B must be described honestly as a separate wallet that Kennel controls. **Decision:** which option and when. The site copy for the room and the app's auto-trade panel depends on it.

Whatever the option: per-trade and daily caps, a kill switch, and slippage limits are enforced in the executor, and any trade failing a rule is dropped and logged.

## 11. API (all authenticated except the first two)

| Method and path | Purpose |
|---|---|
| `GET /api/auth/challenge`, `POST /api/auth/verify` | wallet sign-in |
| `GET /api/tokens/check?address=` | eligibility, no session needed (public data only) |
| `GET /api/agents` | the caller's agents |
| `POST /api/agents {name}` | create |
| `GET /api/agents/:id` | detail: tokens, status, latest report |
| `POST /api/agents/:id/train {token}` | create a payment order |
| `GET /api/orders/:id` | order and payment status |
| `POST /api/agents/:id/test` | start a held-out test |
| `GET /api/agents/:id/alerts` | the journal |
| `PUT /api/agents/:id/settings` | thresholds, channels, trade caps |
| `DELETE /api/agents/:id` | delete |

Every route except the first two checks `session.address == agent.owner`.

## 12. Infrastructure and cost (rough)

- One VM or a single container host: API, indexer, payments watcher, live scorer, and Postgres. The trainer worker on the same host to begin with.
- A paid RPC plan once backfill is done. Backfill is a one-off.
- Storage: trades are small rows. Expect a few GB in the first months.
- Training and scoring are CPU only. No GPUs.
- Monitoring: indexer lag (head minus last indexed block), queue depth, failed jobs, failed payments.

## 13. Build order

1. **Indexer and eligibility** (about 3 days): backfill, follow the head, the `tokens`, `trades` tables, the check endpoint.
2. **Sign-in and agents** (about 2 days): wallet sign-in, agent CRUD, ownership checks. Replace the app's preview data with the API.
3. **Orders and payments** (about 3 days): orders, the transfer watcher, refunds. Needs the platform token address.
4. **Trainer and test** (about 5 days): features, labels, LightGBM job, ONNX export, the held-out pool and report.
5. **Live scorer and alerts** (about 3 days): scoring loop, dedupe, browser push, the journal.
6. **Trading** (size depends on the option chosen in section 10).

Order matters: 1 before 4 (no data, no training), and 2 and 3 can overlap with 1.

## 14. Open decisions, in the order they block work

1. The platform token's name and contract address (blocks phase 3).
2. Burned or kept (changes copy and the payment design).
3. The single objective: X = 20 percent, H = 3 hours, or something else (blocks phase 4).
4. Curve phase only, or also post-graduation trading data.
5. The auto-trade option (A, B or C) and the matching copy.
6. Test limits: how many held-out tests per agent per day.
7. Which alert channel comes first.

## 15. Copy that depends on this spec

- "Spends only from your own wallet, inside the caps you set": true only with option C. See section 10.
- "Beat a plain baseline": true as defined in section 6. Keep it that literal.
- "Checked before every payment": true once section 4 exists.
- "Nobody sees your agent but you": true for the public. The operator can technically read it, and the privacy text must say so.


---

# What was built (2026-10-24), and what was measured

The backend in `server/` implements sections 3 to 9 and 11. Differences from the plan above, and why:

| Plan | Built | Why |
|---|---|---|
| Postgres | SQLite (Node's built-in `node:sqlite`, WAL mode) | One file, no service to run, plenty for this volume. Move to Postgres if more than one process is ever needed |
| LightGBM in a Python worker, ONNX | Gradient-boosted trees written in TypeScript (`server/ml/gbdt.ts`), model as JSON, training in a Node worker thread | One runtime, nothing native to install, deterministic, and fast enough (about 0.15 s for five tokens) |
| Payments watcher | The user sends the transaction hash and the server verifies the Transfer (`POST /api/orders/:id/claim`) | Simpler and safe: the hash is unique and tied to the sender. Orders needing a refund are flagged, not returned automatically |
| Samples every minute | The same, but only at moments with trading in the last 5 minutes | Alerts only ever fire on live trades |
| (not in the plan) | A token must also have traded steadily for 60 minutes in its first day | A quarter of tokens with 300+ trades traded in one short burst and gave too little to learn from. Without this rule, users would pay and then watch training fail. Set by `minActiveMinutes` |

## Facts about the chain that shaped the design (found by probing it)

- A log query returns at most 10,000 logs. Without an address filter it may span 30,000 blocks, with an OR of two event types and an address 100,000, with one event type and an address millions. The indexer splits ranges and queries one event type at a time.
- `blockTimestamp` on logs is always 0. Block times are sampled every 20,000 blocks and interpolated (about 10 seconds of error).
- About 2,000 tokens launch per day and about 90,000 trades happen per day. Roughly 60 launches per day end up with 300 or more trades.
- The RPC is not an archive node, so contract creation blocks cannot be found by code lookup.
- Verified: for the three busiest tokens in a day, the indexed trade counts match a direct RPC query exactly.

## Measured results (four days of real data, 113 usable tokens)

Agents trained on random sets of older tokens and tested on a fixed pool of 30 later tokens, 16 trials per size:

| Tokens learned from | Reliably better than random alerts | Mean hit rate of its alerts | Random alerts | Simple rule ("busy right now") |
|---|---|---|---|---|
| 5 | 5 of 16 | 36% | 25% | 46% |
| 10 | 10 of 16 (8 of 16 after dropping time of day) | 38% to 42% | 25% | 45% |
| 20 | 14 of 16 (13 after) | 42% | 24% | 47% |
| 40 | 14 of 16 (15 after) | 42% to 44% | 23% | 46% |
| 60 | 16 of 16 | 50% | 23% | 48% |

What this means:

1. Agents learn a real signal: with 20 or more tokens, most are reliably better than random alerts.
2. They rarely beat the plain rule "alert when the last 5 minutes are unusually busy" by any margin, even at 60 tokens. That rule is strong because activity tends to continue on a bonding curve.
3. So the pass gate matters. The default is "reliably better than random alerts" (`TEST_GATE=chance`). With `TEST_GATE=rule`, passing also needs to beat the simple rule by `TEST_MARGIN`, and almost nothing passes. The report always shows the comparison with the rule, whichever gate is used.
4. More tokens help: the pass rate and the hit rate both rise with the number of tokens. Five tokens is enough to take the test, but not often enough to pass it. The site now says so.

Limits of these numbers: four days of data, one chain regime, one objective (+20% net within 3 hours), and the designer chose features after looking at an earlier version of this data. Treat them as evidence the pipeline works, not as a promise about returns.

## Asking about older or quieter tokens (measured 2026-10-24)

"Ask your agent" answers for any token, but an agent only practised on moments in a token's first 24 hours with trading in the last 5 minutes. To know how far to trust it elsewhere, agents trained on 20 tokens were scored on 50 tokens they never saw, 8 trials, at their alert threshold:

| Kind of moment | Random chance | Agent's hit rate | Reading |
|---|---|---|---|
| First day, trading (what it learned) | 26% | 48% | clear skill (1.8x) |
| Day 2 to 3, trading | 10% | 9% | no skill (0.84x) |
| Day 2 to 3, quiet (no trade in 5 minutes) | 2% | 2% | nothing to read, and it says low |

So the answer carries a plain note for those cases and never says "I would speak up" (the live scorer does not alert on such tokens). A graduated token, or one with no trades at all, is still refused, because there is nothing on the curve to read.

## Still open

1. Platform token name and address (payments need the address). Burned: decided.
2. The objective (+20% within 3 hours) and the pass gate (`chance` or `rule`).
3. Automatic trading (section 10). Not built: alerts link to the token on Pons.
4. Browser push and Telegram alerts. Webhook only.
5. Post-graduation trading data.
6. Credits for failures on our side are issued automatically, and used on the next token. Nothing else needs returning, because refused tokens are never burned.
