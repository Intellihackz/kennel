// Training and testing are CPU work, so each runs in its own worker thread and never blocks the API. One job at a time.
import { Worker } from "node:worker_threads";
import { CFG } from "./config.ts";
import type { Db } from "./db.ts";

export type JobKind = "train" | "test";

export function enqueue(db: Db, kind: JobKind, agentId: string, payload: object = {}): number {
  const r = db.prepare("INSERT INTO jobs (kind, agent_id, payload, status, created_at) VALUES (?,?,?,?,?)").run(kind, agentId, JSON.stringify(payload), "queued", Math.floor(Date.now() / 1000));
  return Number(r.lastInsertRowid);
}

export class JobRunner {
  private running = false;
  private stopped = false;
  constructor(private db: Db, private dbPath = CFG.dbPath) {}

  start() {
    // anything left running by a previous process was interrupted: queue it again
    this.db.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").run();
    const tick = () => {
      if (this.stopped) return;
      void this.next().finally(() => setTimeout(tick, 700));
    };
    tick();
  }
  stop() {
    this.stopped = true;
  }

  private async next() {
    if (this.running) return;
    const job = this.db.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    if (!job) return;
    this.running = true;
    this.db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), job.id);
    try {
      await new Promise<void>((resolve, reject) => {
        const w = new Worker(new URL("./worker.ts", import.meta.url), { execArgv: ["--import", "tsx"], workerData: { jobId: job.id, dbPath: this.dbPath } });
        w.once("error", reject);
        w.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited with code ${code}`))));
      });
    } catch (e) {
      // the worker records its own failures; this covers a crash before it could
      this.db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'").run(String((e as Error).message).slice(0, 300), Math.floor(Date.now() / 1000), job.id);
    } finally {
      this.running = false;
    }
  }
}
