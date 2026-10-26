// The public fees and burns page. Totals only: it says how much has been burned and how to check it on the chain, never who burned what
// or for which token (agents are private).
import { useEffect, useState } from "react";
import { Bar } from "./Frame";
import { api, type Burns as BurnsData } from "./app/api";
import { toast } from "./app/toast";
import { site } from "./data/site";

const fmt = (n: number) => n.toLocaleString("en-US");
const day = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const EXPLORER = "https://solscan.io";

export function Burns() {
  const [d, setD] = useState<BurnsData | null>(null);
  useEffect(() => {
    api.burns().then(setD).catch(() => toast("We could not load the burn totals. Try again in a moment."));
  }, []);
  const max = d ? Math.max(1, ...d.days.map((x) => x.burned)) : 1;
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Bar here="app" />
      <main id="main" className="bpage">
        <header className="b-head">
          <p className="lab">Fees and burns</p>
          <h1>Kennel collects nothing.</h1>
          <p className="lede">Every platform token you pay to train an agent is burned: sent to an address that nobody controls. There is no other fee. This page shows what has been burned and how to check it yourself.</p>
        </header>

        <section className="b-stats" aria-label="Totals">
          <div>
            <span className="lab">Burned through {site.name}</span>
            <b className="b-big">{d ? fmt(d.totalBurned) : "…"}</b>
          </div>
          <div>
            <span className="lab">Last 24 hours</span>
            <b>{d ? fmt(d.last24h) : "…"}</b>
          </div>
          <div>
            <span className="lab">Tokens trained on</span>
            <b>{d ? fmt(d.tokensTrained) : "…"}</b>
          </div>
          <div>
            <span className="lab">Burned per token</span>
            <b>{fmt(d?.perToken ?? site.perToken)}</b>
          </div>
        </section>

        {d && !d.live && <p className="note b-note">Burning opens when the platform token is set. Until then these totals stay at zero.</p>}

        <section className="b-chart">
          <h2>The last 14 days</h2>
          <ol className="bars" aria-label="Platform tokens burned per day">
            {(d?.days ?? Array.from({ length: 14 }, (_, i) => ({ day: `2026-01-${String(i + 1).padStart(2, "0")}`, burned: 0 }))).map((x) => (
              <li key={x.day} title={`${day(x.day)}: ${fmt(x.burned)} burned`}>
                <i style={{ height: `${Math.max(2, Math.round((x.burned / max) * 100))}%` }} />
                <span>{d ? day(x.day).replace(/ \d+$/, "").slice(0, 3) + " " + day(x.day).split(" ")[1] : ""}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="b-grid">
          <div>
            <h2>How a burn works</h2>
            <ol className="steps2">
              <li><b>You send the tokens.</b><span>When you add a token, your wallet burns {fmt(site.perToken)} platform tokens. You sign it, from your own wallet.</span></li>
              <li><b>Nobody can get them back.</b><span>A burn destroys the tokens and lowers the supply. They are out of circulation for good, and that includes from Kennel.</span></li>
              <li><b>We read the chain.</b><span>Kennel looks at that transfer on the chain and checks it, and only then adds your token. The same transfer can never pay twice.</span></li>
            </ol>
          </div>
          <div>
            <h2>What it costs, all of it</h2>
            <table className="ptable cost">
              <tbody>
                <tr><th scope="row">Training one token</th><td>{fmt(site.perToken)} platform tokens, burned</td></tr>
                <tr><th scope="row">Kennel fee</th><td>None. Nothing is collected.</td></tr>
                <tr><th scope="row">Network gas</th><td>Paid by you to the chain for one transfer. Not to Kennel.</td></tr>
                <tr><th scope="row">A token we refuse</th><td>Nothing is burned. Every check happens first.</td></tr>
                <tr><th scope="row">A run that fails on our side</th><td>A burn cannot be undone, so you get a credit for a free token.</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="b-verify">
          <h2>Check it yourself</h2>
          <p className="muted">These totals count only burns made through {site.name}. Anyone can verify them on the chain: the token and its supply are public.</p>
          <dl className="addrs">
            <div>
              <dt>Platform token</dt>
              <dd>{d?.platformToken ? (<><code>{d.platformToken}</code> <a className="u" href={`${EXPLORER}/token/${d.platformToken}`} target="_blank" rel="noreferrer">Supply on Solscan</a></>) : <span className="muted">Not set yet</span>}</dd>
            </div>
          </dl>
        </section>
      </main>
    </>
  );
}
