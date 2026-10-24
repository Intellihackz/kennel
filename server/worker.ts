// One job, run in a worker thread: train an agent on its tokens, or run its held-out test.
import { workerData } from "node:worker_threads";
import { openDb } from "./db.ts";
import { runTest } from "./ml/evaluate.ts";
import { CFG } from "./config.ts";
import { trainAgent, TrainingDataError, type AgentModel } from "./ml/train.ts";

const { jobId, dbPath } = workerData as { jobId: number; dbPath: string };
const db = openDb(dbPath);
const now = () => Math.floor(Date.now() / 1000);
const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as { id: number; kind: string; agent_id: string; payload: string };
const payload = JSON.parse(job.payload || "{}") as { orderId?: string };

function finish(status: "done" | "failed", error?: string) {
  db.prepare("UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error ?? null, now(), jobId);
}

try {
  if (job.kind === "train") {
    const tokens = (db.prepare("SELECT token FROM agent_tokens WHERE agent_id = ? ORDER BY added_at").all(job.agent_id) as { token: string }[]).map((r) => r.token);
    const settle = (patch: { clearModel?: boolean; model?: AgentModel }) => {
      db.exec("BEGIN");
      if (patch.model) db.prepare("UPDATE agents SET model = ?, model_version = model_version + 1 WHERE id = ?").run(JSON.stringify(patch.model), job.agent_id);
      else if (patch.clearModel) db.prepare("UPDATE agents SET model = NULL WHERE id = ?").run(job.agent_id);
      if (payload.orderId) db.prepare("UPDATE orders SET status = 'done', error = NULL WHERE id = ?").run(payload.orderId);
      db.exec("COMMIT");
    };
    if (tokens.length < CFG.minTokens) {
      // below the minimum there is no model yet: the token is simply stored, and the work happens when the fifth arrives
      settle({});
      finish("done");
    } else {
      try {
        settle({ model: trainAgent(db, tokens) });
        finish("done");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        const msg = String((e as Error).message ?? e).slice(0, 400);
        if (e instanceof TrainingDataError) {
          // the tokens stay (they are valid and paid for), the agent just has no usable model yet, and the user is told why
          settle({ clearModel: true });
          finish("failed", msg);
        } else {
          // our own fault: this token does not count. A burn cannot be returned, so the owner gets a credit for their next token
          if (payload.orderId) {
            const o = db.prepare("SELECT token, owner, tx_hash FROM orders WHERE id = ?").get(payload.orderId) as { token: string; owner: string; tx_hash: string | null } | undefined;
            if (o) {
              db.exec("BEGIN");
              db.prepare("DELETE FROM agent_tokens WHERE agent_id = ? AND token = ?").run(job.agent_id, o.token);
              db.prepare("UPDATE orders SET status = 'credit_issued', error = ? WHERE id = ?").run(msg, payload.orderId);
              if (o.tx_hash) db.prepare("INSERT INTO credits (owner, reason, created_at) VALUES (?,?,?)").run(o.owner, msg, now()); // only a real burn earns one
              db.exec("COMMIT");
            }
          }
          finish("failed", msg);
        }
      }
    }
  } else if (job.kind === "test") {
    const a = db.prepare("SELECT model, model_version, settings FROM agents WHERE id = ?").get(job.agent_id) as { model: string | null; model_version: number; settings: string };
    if (!a.model) throw new Error("This agent has no model to test yet.");
    const settings = JSON.parse(a.settings || "{}") as { sensitivity?: "low" | "normal" | "high" };
    const report = runTest(db, job.agent_id, JSON.parse(a.model) as AgentModel, a.model_version, settings.sensitivity ?? "normal");
    db.prepare("INSERT INTO tests (agent_id, model_version, created_at, passed, report) VALUES (?,?,?,?,?)").run(job.agent_id, a.model_version, now(), report.passed ? 1 : 0, JSON.stringify(report));
    finish("done");
  } else finish("failed", `unknown job kind ${job.kind}`);
} catch (e) {
  finish("failed", String((e as Error).message ?? e).slice(0, 400));
}
process.exit(0);
