// The app. Everything here is real: your agents, their tokens, training, the held-out test and the alerts come from the Kennel API,
// and you are signed in with your wallet. Layout: a rail of your agents, a workspace (the stage, then Train / Test / Room),
// and an inspector with the unlock checklist.
import { useCallback, useEffect, useRef, useState } from "react";
import { Bar } from "../Frame";
import { startWorkshop, type WorkshopHandle } from "../motion/workshop";
import { sceneMarkup } from "../motion/scene";
import { api, ApiError, type AgentView, type AlertView, type AskResult, type Config, type Eligibility, type LiveToken, type MyBurns, type Order, type TestReport } from "./api";
import { toast } from "./toast";
import { activeProvider, connect, disconnect, ensureChain, initWallets, shortAddr, useWallet } from "./wallet";

const SCENE = sceneMarkup();
type Tab = "train" | "test" | "room";

const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${Math.round(x * 100)}%`);
const age = (h: number) => (h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const ago = (t: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  return s < 90 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
};
const errText = (e: unknown) => (e instanceof ApiError ? e.message : ((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? "Something went wrong.").split("\n")[0]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LABEL: Record<AgentView["status"], string> = {
  empty: "Empty", collecting: "Collecting tokens", training: "Training", ready_to_test: "Ready to test", testing: "Testing", locked: "Locked", ready: "Ready",
};
const label = (a: AgentView) => (a.status === "collecting" ? `${a.trainedCount} ${a.trainedCount === 1 ? "token" : "tokens"}` : LABEL[a.status]);

/** Where the workshop is for this agent: crates in, parts fitted, lit, tested, room closed. */
const stageP = (a: AgentView) => (a.status === "ready" ? 1 : a.status === "testing" ? 0.84 : a.trainedCount >= a.minTokens ? 0.775 : 0.08 + a.trainedCount * 0.125);

export default function AppPage() {
  const { account } = useWallet();
  useEffect(initWallets, []);
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Bar here="app" />
      <main id="main" className="app">
        {account ? <Workspace key={account} account={account} /> : <SignIn />}
      </main>
    </>
  );
}

function SignIn() {
  const ref = useRef<HTMLDivElement>(null);
  const { wallets, busy, error } = useWallet();
  useEffect(() => startWorkshop(ref.current!, { fixed: 0 }), []);
  useEffect(() => {
    if (error) toast(error);
  }, [error]);
  return (
    <section className="gate">
      <div className="gate-bg" ref={ref} aria-hidden="true">
        <svg className="scene" dangerouslySetInnerHTML={{ __html: SCENE }} />
        <div className="vignette" />
      </div>
      <div className="gate-card">
        <h1>Open your workshop.</h1>
        <p>Connect a wallet to see your agents. They are private to that wallet, and nobody else can open them.</p>
        <div className="wlist">
          {wallets.map((w) => (
            <button key={w.id} className="wopt" disabled={!!busy} onClick={() => connect(w.id)}>
              {w.icon ? <img src={w.icon} width={24} height={24} alt="" /> : <span className="wi" aria-hidden="true" />}
              <span>{w.name}</span>
              {busy === w.id && <em>Check your wallet…</em>}
            </button>
          ))}
        </div>
        {wallets.length === 0 && <p className="muted small">No browser wallet found yet. Install one such as MetaMask or Rabby, then reload this page.</p>}
        <p className="note">You sign one message to prove the wallet is yours. It costs no gas and cannot move funds.</p>
      </div>
    </section>
  );
}

function Workspace({ account }: { account: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [open, setOpen] = useState("");
  const [making, setMaking] = useState(false);
  const [view, setView] = useState<"agents" | "burns">("agents");

  const refresh = useCallback(async () => {
    try {
      setAgents(await api.agents());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) disconnect();
      else toast(errText(e));
    }
  }, []);
  useEffect(() => {
    api.config().then(setConfig).catch((e) => toast(errText(e)));
    void refresh();
  }, [refresh]);
  // poll faster while something is training or being tested
  const busy = agents?.some((a) => a.status === "training" || a.status === "testing" || a.orders.some((o) => o.status === "training" || o.status === "paid"));
  useEffect(() => {
    const t = setInterval(refresh, busy ? 2000 : 15000);
    return () => clearInterval(t);
  }, [refresh, busy]);
  useEffect(() => {
    if (agents && agents.length && !agents.some((a) => a.id === open)) setOpen(agents[0].id);
  }, [agents, open]);

  const agent = agents?.find((a) => a.id === open);
  // the make form shows when asked for, or when there is nothing else to show (derived, never set by an effect)
  const showing = view === "agents" && !making && agent;

  return (
    <div className="shell">
      <aside className="rail" aria-label="Your agents">
        <div className="who">
          <span className="lab">Wallet</span>
          <b>{shortAddr(account)}</b>
          <button className="u small quiet" onClick={disconnect}>Disconnect</button>
        </div>
        <p className="lab">Your agents</p>
        <ul className="alist">
          {agents?.map((a) => (
            <li key={a.id}>
              <button className={"arow" + (showing && a.id === open ? " is-on" : "")} onClick={() => (setOpen(a.id), setMaking(false), setView("agents"))}>
                <b>{a.name}</b>
                <span>{label(a)}</span>
              </button>
            </li>
          ))}
        </ul>
        <button className="btn ghost sm" onClick={() => (setMaking(true), setView("agents"))}><span>New agent</span></button>
        <button className={"arow burn-link" + (view === "burns" ? " is-on" : "")} onClick={() => setView("burns")}><b>Your burns</b><span>What you have burned, and the fees</span></button>
        <p className="muted small lock-note">Agents are private to this wallet. There is no directory.</p>
      </aside>

      <section className="work">
        {config && !config.indexerReady && <p className="note" role="status">Kennel is still catching up with the chain, so checking and adding tokens will work again in a minute or two.</p>}
        {view === "burns" ? <MyBurnsView config={config} /> : agents === null ? <p className="muted">Loading your agents…</p> : showing ? <AgentPanel key={agent.id} agent={agent} config={config} account={account} refresh={refresh} onDeleted={() => (setOpen(""), void refresh())} /> : (
          <MakeAgent first={agents.length === 0} onMade={(a) => (setOpen(a.id), setMaking(false), void refresh())} />
        )}
      </section>

      <aside className="insp" aria-label="Unlock checklist">
        {view === "agents" && showing && config ? <Inspector agent={agent} config={config} /> : config ? <Rules config={config} /> : null}
      </aside>
    </div>
  );
}

function Rules({ config }: { config: Config }) {
  return (
    <div className="card">
      <p className="lab">How it works</p>
      <ol className="checks plain">
        <li><b>Add tokens</b><span>{fmt(config.pricePerToken)} platform tokens are burned for each. At least {config.minTokens} to unlock the test, as many as you like.</span></li>
        <li><b>Each token is checked first</b><span>At least {config.minTrades} trades, a day old, and {config.minActiveMinutes} minutes of steady trading. Refused before anything is burned.</span></li>
        <li><b>Test, then your room</b><span>The agent is scored on tokens it never saw. Pass, and its alerts start.</span></li>
      </ol>
      {config.mockPayments && <p className="note">Development mode: tokens are added without burning anything.</p>}
    </div>
  );
}

function Inspector({ agent, config }: { agent: AgentView; config: Config }) {
  const n = agent.trainedCount;
  const t = agent.test;
  const steps = [
    { done: n >= agent.minTokens, title: `${agent.minTokens} or more tokens`, note: n >= agent.minTokens ? `${n} trained. Add as many as you like.` : `${n} of ${agent.minTokens}. ${agent.minTokens - n} more to unlock the test.` },
    { done: n > 0, title: "Each has enough history", note: n > 0 ? "Checked before every burn." : "Checked before you burn." },
    { done: !!t?.passed, bad: !!t && !t.passed, title: "Passes the held-out test", note: t ? (t.passed ? `Reliably better than random alerts on ${t.poolSize} tokens it never saw.` : "It did not pass. Add tokens and test again.") : n >= agent.minTokens ? "Ready to run." : `Available at ${agent.minTokens} tokens.` },
  ];
  return (
    <>
      <div className="card">
        <p className="lab">To unlock</p>
        <ol className="checks">
          {steps.map((s) => (
            <li key={s.title} className={s.done ? "done" : s.bad ? "bad" : ""}>
              <i aria-hidden="true">{s.done ? "✓" : s.bad ? "×" : ""}</i>
              <div><b>{s.title}</b><span>{s.note}</span></div>
            </li>
          ))}
        </ol>
      </div>
      <div className="card">
        <p className="lab">Burned for this agent</p>
        <b className="big-b">{fmt(n * config.pricePerToken)}</b>
        <span className="muted small">{n} {n === 1 ? "token" : "tokens"} at {fmt(config.pricePerToken)} each</span>
        {config.mockPayments && <span className="note">Development mode: nothing was really burned.</span>}
        <a className="u small" href="/burns">Fees and burns</a>
      </div>
      {agent.model && (
        <div className="card">
          <p className="lab">What it learned from</p>
          <span className="muted small">{fmt(agent.model.samples)} moments from {agent.model.tokensUsed} tokens. It looks for moments where buying would have returned at least {Math.round(agent.model.objective.x * 100)}% within {agent.model.objective.hours} hours after fees and tax. {pct(agent.model.positiveRate)} of its moments did.</span>
        </div>
      )}
    </>
  );
}

function MakeAgent({ onMade, first }: { onMade: (a: AgentView) => void; first: boolean }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="panel make"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        try {
          onMade(await api.create(name.trim()));
        } catch (err) {
          toast(errText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1>{first ? "Make your first agent." : "Make an agent."}</h1>
      <p className="muted">Give it a name. It starts empty and private. Then train it on tokens, as many as you like.</p>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Name your agent" required />
      </label>
      <button className="btn" disabled={!name.trim() || busy}><span>{busy ? "Creating…" : "Create the agent"}</span></button>
    </form>
  );
}

/** The workshop as a figure: it moves as tokens are added and tested, so training can be watched. */
function Stage({ agent }: { agent: AgentView }) {
  const ref = useRef<HTMLDivElement>(null);
  const h = useRef<WorkshopHandle | null>(null);
  const p = stageP(agent);
  useEffect(() => {
    h.current = startWorkshop(ref.current!, { fixed: p, view: { lx: 4.4, zoom: 1.22, oy: 0.07 } });
    return () => h.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => h.current?.set(p), [p]);
  const n = agent.trainedCount;
  const cap =
    agent.status === "ready" ? "In its room. Alerts will arrive here." :
    agent.status === "locked" ? "Did not pass. Add tokens and test again." :
    agent.status === "testing" ? "Being tested on tokens it never saw…" :
    agent.status === "training" ? "Training…" :
    agent.status === "ready_to_test" ? "Unlocked for testing." :
    n === 0 ? "Empty. Add a token to start." : `${n} ${n === 1 ? "token" : "tokens"} in. ${agent.minTokens - n} more to unlock.`;
  return (
    <div className="stage-card" ref={ref}>
      <svg className="scene" aria-hidden="true" dangerouslySetInnerHTML={{ __html: SCENE }} />
      <p className="stage-cap" aria-live="polite">{cap}</p>
    </div>
  );
}

function AgentPanel({ agent, config, account, refresh, onDeleted }: { agent: AgentView; config: Config | null; account: string; refresh: () => Promise<void>; onDeleted: () => void }) {
  const [tab, setTab] = useState<Tab>("train");
  const ready = agent.status === "ready";
  useEffect(() => {
    if (agent.lastError) toast(`The last training run stopped: ${agent.lastError}`);
  }, [agent.lastError]);
  const creditOrders = agent.orders.filter((o) => o.status === "credit_issued").map((o) => o.id).join(",");
  useEffect(() => {
    if (creditOrders) toast("A token could not be added because of a problem on our side. Your burn is kept as a credit for your next token.");
  }, [creditOrders]);
  return (
    <div className="agent">
      <header className="a-head">
        <div>
          <p className="lab">Private to this wallet</p>
          <h1>{agent.name}</h1>
        </div>
        <span className={"state" + (ready ? " ok" : "")}>{LABEL[agent.status]}</span>
      </header>
      <Stage agent={agent} />
      <div className="tabs" role="tablist">
        {(["train", "test", "room"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "train" ? "Train" : t === "test" ? "Test" : "Room"}
            {t === "room" && !ready && <i className="lk" aria-label="locked" />}
          </button>
        ))}
      </div>
      {tab === "train" && config && <Train agent={agent} config={config} account={account} refresh={refresh} />}
      {tab === "test" && <TestTab agent={agent} refresh={refresh} />}
      {tab === "room" && <RoomTab agent={agent} refresh={refresh} onDeleted={onDeleted} />}
    </div>
  );
}

// ---------------------------------------------------------------- train
function Train({ agent, config, account, refresh }: { agent: AgentView; config: Config; account: string; refresh: () => Promise<void> }) {
  const [input, setInput] = useState("");
  const [checked, setChecked] = useState<Eligibility | null>(null);
  const [credits, setCredits] = useState(0);
  const [step, setStep] = useState("");
  useEffect(() => {
    api.credits().then(setCredits).catch(() => {});
  }, [agent.trainedCount]);
  const busy = !!step;
  const n = agent.trainedCount;

  const check = async () => {
    setChecked(null);
    const ca = input.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) return toast("That is not a contract address. It starts with 0x and has 40 more characters.");
    if (agent.tokens.some((t) => t.token === ca.toLowerCase())) return toast("This agent has already learned from that token.");
    setStep("Checking the token…");
    try {
      setChecked(await api.check(ca));
    } catch (e) {
      toast(errText(e));
    } finally {
      setStep("");
    }
  };

  const pay = async (order: Order) => {
    if (order.mock || order.credit) return api.claim(order.id); // development mode, or a credit from a run that failed on our side
    if (!order.platformToken) throw new Error("Payments are not set up yet.");
    setStep("Confirm the burn in your wallet…");
    await ensureChain();
    const { encodeFunctionData, parseAbi } = await import("viem");
    const data = encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 value) returns (bool)"]), functionName: "transfer", args: [order.burnAddress as `0x${string}`, BigInt(order.amount)] });
    const txHash = (await activeProvider().request({ method: "eth_sendTransaction", params: [{ from: account, to: order.platformToken, data }] })) as string;
    setStep("Waiting for the chain to confirm the burn…");
    for (let i = 0; i < 30; i++) {
      try {
        return await api.claim(order.id, txHash);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 402 && /not on the chain yet/i.test(e.message))) throw e;
        await sleep(2000);
      }
    }
    throw new Error(`The burn was sent but is not confirmed yet. Your transaction: ${txHash}`);
  };

  const train = async () => {
    if (!checked?.ok || !checked.token) return;
    try {
      setStep("Starting…");
      const order = await api.order(agent.id, checked.token);
      await pay(order);
      setChecked(null);
      setInput("");
      await refresh();
    } catch (e) {
      toast(errText(e));
    } finally {
      setStep("");
    }
  };

  const rows = Math.max(config.minTokens, agent.tokens.length);
  return (
    <>
      <div className="panel">
        <h2>Add a token</h2>
        <p className="muted small">
          {fmt(config.pricePerToken)} platform tokens are burned per token, however many you add. We check the token first and refuse it before anything is burned if it is too thin. <a className="u" href="/burns">Fees and burns</a>
        </p>
        {credits > 0 && !config.mockPayments && <p className="note">You have {credits} {credits === 1 ? "credit" : "credits"} from a run that failed on our side. It pays for your next token, so nothing will be burned.</p>}
        <div className="addr">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Paste the token's contract address, 0x…" spellCheck={false} aria-label="Token contract address" onKeyDown={(e) => e.key === "Enter" && !busy && check()} disabled={busy} />
          <button className="btn sm" onClick={check} disabled={busy || !input.trim()}><span>Check it</span></button>
        </div>
        {step && <p className="muted small" role="status">{step}</p>}
        {checked && (
          <div className={"check" + (checked.ok ? "" : " bad")} role="status">
            <p className="tk-name"><b>{checked.name || "Unnamed token"}</b> <span className="muted">{checked.symbol ? `$${checked.symbol}` : ""}</span></p>
            <dl>
              <div><dt>Trades</dt><dd>{fmt(checked.trades)}</dd></div>
              <div><dt>Age</dt><dd>{age(checked.ageHours)}</dd></div>
              <div><dt>Steady trading</dt><dd>{checked.activeMinutes} min</dd></div>
              <div><dt>Graduated</dt><dd>{checked.graduated ? "Yes" : "No"}</dd></div>
            </dl>
            {checked.ok ? (
              <button className="btn" disabled={busy} onClick={train}><span>{busy ? "Working…" : credits > 0 && !config.mockPayments ? "Train on this token, use a credit" : `Train on this token, burn ${fmt(config.pricePerToken)}`}</span></button>
            ) : (
              <p>{checked.reason} Nothing was burned.</p>
            )}
          </div>
        )}
        {config.mockPayments && <p className="note">Development mode: adding a token does not burn anything yet.</p>}
      </div>

      <div className="panel">
        <h2>Trained on</h2>
        <table className="trained">
          <thead>
            <tr><th scope="col">#</th><th scope="col">Token</th><th scope="col">Trades</th><th scope="col">Age</th></tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => {
              const t = agent.tokens[i];
              return t ? (
                <tr key={t.token}>
                  <th scope="row">{i + 1}</th>
                  <td>{t.symbol ? `$${t.symbol}` : `${t.token.slice(0, 6)}…${t.token.slice(-4)}`}{t.state === "training" && <em className="pill"> training</em>}</td>
                  <td>{fmt(t.trades)}</td>
                  <td>{t.graduated ? "graduated" : age(t.ageHours)}</td>
                </tr>
              ) : (
                <tr key={`e${i}`} className="empty">
                  <th scope="row">{i + 1}</th>
                  <td colSpan={3}>{i === 0 ? "Nothing yet" : "Empty"}</td>
                </tr>
              );
            })}
            <tr className="more">
              <th scope="row">+</th>
              <td colSpan={3}>{n >= config.minTokens ? "Add as many more as you like." : `Unlocks the test at ${config.minTokens}. You can add more after that.`}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- test
function Meter({ label, value, tone }: { label: string; value: number | null; tone?: "agent" | "muted" }) {
  return (
    <div className="meter-row">
      <span>{label}</span>
      <div className="bar-track"><i className={tone === "agent" ? "agent" : ""} style={{ width: `${Math.round((value ?? 0) * 100)}%` }} /></div>
      <b>{pct(value)}</b>
    </div>
  );
}

function Report({ t }: { t: TestReport }) {
  return (
    <div className={"verdict " + (t.passed ? "pass" : "fail")} role="status">
      <b>{t.passed ? "Passed. Your room is open." : "Not yet. The agent stays locked."}</b>
      {t.reasons.map((r) => <span key={r}>{r}</span>)}
      <div className="rep">
        <p className="lab">How often an alert was right</p>
        <Meter label="Your agent" value={t.precision} tone="agent" />
        <Meter label="Random alerts" value={t.baseRate} />
        <Meter label="Simple rule: busy right now" value={t.rulePrecision} />
        <p className="muted small">
          Right means the token went up at least {Math.round(t.objective.x * 100)}% within {t.objective.hours} hours, after fees and tax. Tested on {t.poolSize} tokens it never saw: {t.alerts} alerts from {t.tokensWithAlerts} tokens, at {t.sensitivity} sensitivity.
          {t.ciLow !== null && ` Across different samples of tokens its hit rate stayed above ${pct(t.ciLow)}.`}
        </p>
        {t.meanReturn !== null && <p className="muted small">The average alert returned {Math.round(t.meanReturn * 100)}% over the window, after costs. The worst returned {Math.round((t.worstReturn ?? 0) * 100)}%. Past results do not predict future ones.</p>}
        {t.notes.map((x) => <p key={x} className="muted small">{x}</p>)}
      </div>
    </div>
  );
}

function TestTab({ agent, refresh }: { agent: AgentView; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const n = agent.trainedCount;
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.test(agent.id);
      if (!r.queued) toast(r.reason ?? "", "info");
      await refresh();
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const testing = agent.status === "testing";
  return (
    <div className="panel">
      <h2>Held-out test</h2>
      <p className="muted small">The agent is scored on tokens it never saw, picked by Kennel, and compared with random alerts and with a simple rule. It has to be reliably better than random alerts to open its room.</p>
      {n < agent.minTokens ? (
        <p className="muted">The test opens at {agent.minTokens} tokens. This agent has {n}.</p>
      ) : (
        <button className="btn" onClick={run} disabled={busy || testing || agent.status === "training"}>
          <span>{testing ? "Testing…" : agent.test ? "Test again" : "Run the test"}</span>
        </button>
      )}
      {agent.test && <Report t={agent.test} />}
    </div>
  );
}


// ---------------------------------------------------------------- ask
type Msg = { id: number; from: "you" | "agent"; at: number; token?: string; res?: AskResult; pending?: boolean; failed?: boolean };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The answer, written as the agent would say it. */
function Answer({ res, agent }: { res: AskResult; agent: AgentView }) {
  if (!res.ok)
    return (
      <>
        {res.name && <p><b>{res.name}</b> <span className="muted">{res.symbol ? `$${res.symbol}` : ""}</span></p>}
        <p>{res.reason}</p>
      </>
    );
  const above = res.verdict === "above";
  return (
    <>
      <p>
        <b>{res.name || "That token"}</b> <span className="muted">{res.symbol ? `$${res.symbol}` : ""}</span>
        <span className="muted small"> launched {res.ageMinutes < 90 ? `${res.ageMinutes} min` : res.ageMinutes < 2880 ? `${Math.round(res.ageMinutes / 60)} h` : `${Math.round(res.ageMinutes / 1440)} days`} ago, {fmt(res.trades)} trades, last one {res.lastTradeSecondsAgo < 90 ? "just now" : res.lastTradeSecondsAgo < 5400 ? `${Math.round(res.lastTradeSecondsAgo / 60)} min ago` : res.lastTradeSecondsAgo < 172800 ? `${Math.round(res.lastTradeSecondsAgo / 3600)} h ago` : `${Math.round(res.lastTradeSecondsAgo / 86400)} days ago`}.</span>
      </p>
      <div className="rep">
        <Meter label="My chance" value={res.probability} tone="agent" />
        <Meter label={`I speak up above (${res.sensitivity})`} value={res.threshold} />
      </div>
      {res.notes.map((n) => <p key={n} className="scope-note small">{n}</p>)}
      <p><b>{res.scope === "outside" ? "I would not raise an alert for a token like this, so read my number as a rough guess." : above ? "That is above my alert threshold. I would speak up about this one right now." : "That is below my alert threshold. I would stay quiet about this one right now."}</b></p>
      {res.up.length > 0 && <p className="small"><span className="muted">Pushing me up: </span>{res.up.map((r) => `${r.label}: ${r.value}`).join(" · ")}</p>}
      {res.down.length > 0 && <p className="small"><span className="muted">Pulling me down: </span>{res.down.map((r) => `${r.label}: ${r.value}`).join(" · ")}</p>}
      {res.up.length === 0 && res.down.length === 0 && <p className="small muted">No single signal stood out.</p>}
      <p className="muted small">My chance is my own estimate that buying now returns at least {Math.round((agent.model?.objective.x ?? 0.2) * 100)}% within {agent.model?.objective.hours ?? 3} hours after costs. It is not a promise, and I can be wrong.</p>
      <a className="u small" href={`https://ponsfamily.com/launchpad/${res.token}`} target="_blank" rel="noreferrer">Open on Pons</a>
    </>
  );
}

function Ask({ agent }: { agent: AgentView }) {
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [live, setLive] = useState<LiveToken[]>([]);
  const next = useRef(1);
  const thread = useRef<HTMLDivElement>(null);
  const busy = msgs.some((m) => m.pending);

  useEffect(() => {
    api.liveTokens().then(setLive).catch(() => {});
  }, []);
  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const send = async (raw: string) => {
    const ca = raw.trim();
    if (busy) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(ca)) return toast("That is not a contract address. It starts with 0x and has 40 more characters.");
    setInput("");
    const reply = next.current + 1;
    setMsgs((m) => [...m, { id: next.current, from: "you", at: Date.now(), token: ca }, { id: reply, from: "agent", at: Date.now(), pending: true }]);
    next.current += 2;
    try {
      const res = await api.ask(agent.id, ca);
      setMsgs((m) => m.map((x) => (x.id === reply ? { ...x, pending: false, res, at: Date.now() } : x)));
    } catch (e) {
      toast(errText(e));
      setMsgs((m) => m.map((x) => (x.id === reply ? { ...x, pending: false, failed: true } : x)));
    }
  };

  return (
    <div className="panel chat">
      <div className="chat-head">
        <h2>Ask your agent</h2>
        {msgs.length > 0 && <button className="u small quiet" onClick={() => setMsgs([])}>Clear the conversation</button>}
      </div>
      <div className="thread" ref={thread} role="log" aria-live="polite" aria-label={`Conversation with ${agent.name}`}>
        <div className="msg agent">
          <i className="av" aria-hidden="true" />
          <div className="bubble">
            <p>Hi, I am {agent.name}. Paste the contract address of any token on Pons and I will tell you what I see right now.</p>
            <p className="muted small">I read best on tokens in their first day that are trading. Older or quieter ones I will still read, and I will say how far to trust it. Nothing you ask me is saved.</p>
          </div>
        </div>
        {msgs.map((m) =>
          m.from === "you" ? (
            <div key={m.id} className="msg you">
              <div className="bubble"><code>{short(m.token!)}</code></div>
            </div>
          ) : (
            <div key={m.id} className="msg agent">
              <i className="av" aria-hidden="true" />
              <div className="bubble">
                {m.pending ? <span className="typing" aria-label="Reading the token"><i /><i /><i /></span> : m.failed ? <p>I could not read that one. Try again in a moment.</p> : m.res ? <Answer res={m.res} agent={agent} /> : null}
              </div>
            </div>
          ),
        )}
      </div>
      {live.length > 0 && (
        <div className="chips" aria-label="Tokens trading right now">
          <span className="muted small">Trading right now:</span>
          {live.map((t) => (
            <button key={t.address} className="chip" disabled={busy} onClick={() => send(t.address)} title={`${t.name || t.address}, ${t.recentTrades} trades in the last 5 minutes`}>
              {t.symbol ? `$${t.symbol}` : short(t.address)}
            </button>
          ))}
        </div>
      )}
      <form className="composer" onSubmit={(e) => (e.preventDefault(), send(input))}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Paste a token's contract address, 0x…" spellCheck={false} aria-label="Token to ask about" disabled={busy} />
        <button className="btn sm" disabled={busy || !input.trim()} aria-label="Send"><span>Send</span></button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- room
function RoomTab({ agent, refresh, onDeleted }: { agent: AgentView; refresh: () => Promise<void>; onDeleted: () => void }) {
  const ready = agent.status === "ready";
  const [alerts, setAlerts] = useState<AlertView[] | null>(null);
  const [hook, setHook] = useState(agent.settings.webhookUrl ?? "");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const load = () => api.alerts(agent.id).then(setAlerts).catch(() => {});
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [agent.id, ready]);

  const save = async (patch: Parameters<typeof api.settings>[1]) => {
    try {
      await api.settings(agent.id, patch);
      toast("Saved.", "info");
      await refresh();
    } catch (e) {
      toast(errText(e));
    }
  };

  if (!ready)
    return (
      <div className="panel locked">
        <h2>The room is locked.</h2>
        <p className="muted">Alerts live here once the agent has passed its test. Nothing is sent before that.</p>
      </div>
    );
  return (
    <>
      <Ask agent={agent} />
      <div className="panel">
        <h2>Alerts</h2>
        <p className="muted small">They arrive here with the reasoning attached. Each links to the token on Pons, and you decide from your own wallet.</p>
        {alerts === null ? <p className="muted small">Loading…</p> : alerts.length === 0 ? <p className="muted">No alerts yet. The agent watches every token in its first day and speaks up only when a moment looks like the ones it learned from.</p> : (
          <ul className="alerts">
            {alerts.map((a) => (
              <li key={a.id}>
                <b>{a.symbol ? `$${a.symbol}` : `${a.token.slice(0, 6)}…${a.token.slice(-4)}`} <em className="pill">{pct(a.probability)} chance</em> <span className="muted small">{ago(a.at)}</span></b>
                <span>{a.reasons.length ? a.reasons.map((r) => `${r.label}: ${r.value}`).join(" · ") : "No single reason stood out."}</span>
                <a className="u small" href={`https://ponsfamily.com/launchpad/${a.token}`} target="_blank" rel="noreferrer">Open on Pons</a>
                {a.webhook && <span className="muted small"> · webhook {a.webhook}</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">The chance is the agent's own estimate that buying then returned at least {Math.round((agent.model?.objective.x ?? 0.2) * 100)}% within {agent.model?.objective.hours ?? 3} hours after costs. It is not a promise.</p>
      </div>
      <div className="panel">
        <h2>Settings</h2>
        <label className="field">
          <span>Sensitivity</span>
          <select value={agent.settings.sensitivity} onChange={(e) => save({ sensitivity: e.target.value as "low" | "normal" | "high" })}>
            <option value="low">Low: fewer alerts, only the strongest</option>
            <option value="normal">Normal</option>
            <option value="high">High: more alerts, more of them wrong</option>
          </select>
        </label>
        <label className="field">
          <span>Webhook (optional): we post each alert to this https link</span>
          <div className="addr">
            <input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://…" spellCheck={false} />
            <button className="btn sm" onClick={() => save({ webhookUrl: hook })}><span>Save</span></button>
          </div>
        </label>
        <p className="muted small">Kennel never holds your funds and never trades for you. Changing the sensitivity lets you run the test once more at that setting.</p>
      </div>
      <div className="panel">
        <h2>Delete this agent</h2>
        <p className="muted small">Removes the agent, its model, its tests and its alerts. Payment records are kept.</p>
        {confirm ? (
          <button className="btn ghost sm" onClick={async () => (await api.remove(agent.id), onDeleted())}><span>Yes, delete it for good</span></button>
        ) : (
          <button className="btn ghost sm" onClick={() => setConfirm(true)}><span>Delete the agent</span></button>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- your burns
function MyBurnsView({ config }: { config: Config | null }) {
  const [data, setData] = useState<MyBurns | null>(null);
  useEffect(() => {
    api.myBurns().then(setData).catch((e) => toast(errText(e)));
  }, []);
  return (
    <div className="agent">
      <header className="a-head">
        <div>
          <p className="lab">Only you can see this</p>
          <h1>Your burns</h1>
        </div>
      </header>
      <div className="panel">
        <h2>What you have burned</h2>
        <p className="muted small">
          Every token you add burns {config ? fmt(config.pricePerToken) : "100,000"} platform tokens. Kennel collects none of it and charges no other fee. See <a className="u" href="/burns">the public page</a> for the totals and how to check them on the chain.
        </p>
        {data === null ? <p className="muted small">Loading…</p> : (
          <>
            <b className="big-b">{fmt(data.total)}</b>
            <span className="muted small">burned by this wallet{data.credits > 0 ? `, and ${data.credits} ${data.credits === 1 ? "credit" : "credits"} waiting for your next token` : ""}</span>
          </>
        )}
      </div>
      <div className="panel">
        <h2>History</h2>
        {data && data.burns.length === 0 ? <p className="muted">Nothing burned yet.{config?.mockPayments ? " Development mode adds tokens without burning." : ""}</p> : (
          <table className="trained">
            <thead><tr><th scope="col">When</th><th scope="col">Token</th><th scope="col">Burned</th><th scope="col">Proof</th></tr></thead>
            <tbody>
              {data?.burns.map((b) => (
                <tr key={b.id}>
                  <td>{ago(b.at)}</td>
                  <td>{b.symbol ? `$${b.symbol}` : `${b.token.slice(0, 6)}…${b.token.slice(-4)}`}{b.status === "credit_issued" && <em className="pill"> became a credit</em>}{b.status === "credit" && <em className="pill"> paid with a credit</em>}</td>
                  <td>{fmt(b.amount)}</td>
                  <td>{b.txHash ? <a className="u" href={`https://robin.etherscan.io/tx/${b.txHash}`} target="_blank" rel="noreferrer">Transaction</a> : <span className="muted">credit</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
