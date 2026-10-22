import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface SceneParams {
  prompt: string;
  type: "video" | "image";
  max_credits: number;
  duration?: 4 | 6 | 8 | 10;
  resolution?: "360p" | "720p";
  model?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  variants?: number;
  first_frame?: string;
  last_frame?: string;
  reference_images?: string[];
  chain_from?: string;
  reference_from?: string;
  edit_asset?: string;
  agent_scenes?: string[];
  // The scene number each agent scene is saved as. A retry of scenes 7 and 12 keeps scene-07 and scene-12; without it
  // the numbers run on from file_stem.
  agent_numbers?: number[];
  continue_from?: string;
  attach?: string[];
  continue_mode?: "exact" | "likeness";
  retries?: number;
  download_quality?: "original" | "upscaled";
  output_dir: string;
  file_stem: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  params: SceneParams;
  files: string[];
  attempts: number;
  credits?: number;
  progress?: string;
  note?: string;
  error?: string;
  // Scene numbers a batch still could not make after all its own retries; flow_retry redoes just these.
  failed_scenes?: number[];
  createdAt: string;
  finishedAt?: string;
}

export type JobRunner = (job: Job) => Promise<string[]>;

// Flow is driven like a careful person would: one generation at a time, with a
// randomised pause between them.
const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 25) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MCP_PAUSE_MAX_S ?? 70) * 1000;

// How many finished jobs the journal keeps. Unfinished ones are always kept.
const JOURNAL_KEEP = 300;

export interface LedgerEntry {
  at: string;
  job: string;
  credits: number;
  kind: string;
  project: string;
  scene: string;
}

export const jobKind = (p: SceneParams) =>
  p.continue_from ? "continue" : p.agent_scenes ? "agent" : p.edit_asset ? "edit" : p.type;

// The queue used to live only in memory, so a restarted process forgot a job it had been running while Flow carried on
// generating and charging - an empty queue then looked like "nothing ran" and a shot was paid for twice. The journal
// keeps every job on disk. On load, a job that was running is marked interrupted (Flow may well have finished it, so it
// is never re-run by itself) and a job that had not started is set aside as cancelled, for flow_retry to put back.
export class JobQueue {
  private jobs = new Map<string, Job>();
  private working = false;
  private lastFinished = 0;
  pausedReason: string | null = null;
  // Called after every change of state, e.g. to tell MCP clients the job list moved.
  onChange?: (job: Job) => void;

  private journal?: string;
  ledger?: string;

  constructor(private runner: JobRunner) {}

  // Only the process that owns the Flow tab may call this: a client process restoring the journal would mark the
  // owner's running job as interrupted.
  persist(journal: string, ledger: string) {
    this.journal = journal;
    this.ledger = ledger;
    if (existsSync(journal)) this.restore(journal);
  }

  private restore(file: string) {
    let saved: Job[] = [];
    try {
      saved = JSON.parse(readFileSync(file, "utf8")) as Job[];
    } catch {
      renameSync(file, `${file}.unreadable-${Date.now()}`);
      return;
    }
    const now = new Date().toISOString();
    for (const job of saved) {
      if (job.status === "running") {
        job.status = "failed";
        job.finishedAt = now;
        job.error =
          "Interrupted: flow-mcp restarted while this job was running. Flow may still have finished it and charged for it - check flow_assets and use flow_download before running it again.";
      } else if (job.status === "queued") {
        job.status = "cancelled";
        job.finishedAt = now;
        job.note = "Not started before flow-mcp restarted. flow_retry puts it back in the queue.";
      }
      job.progress = undefined;
      this.jobs.set(job.id, job);
    }
    this.save();
  }

  save() {
    if (!this.journal) return;
    const jobs = this.list();
    const finished = jobs.filter((j) => j.finishedAt);
    const drop = new Set(finished.slice(0, Math.max(0, finished.length - JOURNAL_KEEP)).map((j) => j.id));
    for (const id of drop) this.jobs.delete(id);
    mkdirSync(dirname(this.journal), { recursive: true });
    // Write then rename, so a crash mid-write never leaves half a journal behind.
    const tmp = `${this.journal}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list(), null, 1));
    renameSync(tmp, this.journal);
  }

  private changed(job: Job) {
    try {
      this.save();
    } catch (err) {
      process.stderr.write(`flow-mcp: could not save the job journal: ${err instanceof Error ? err.message : err}\n`);
    }
    this.onChange?.(job);
  }

  private record(job: Job) {
    if (!this.ledger || !job.credits || job.credits <= 0) return;
    const entry: LedgerEntry = {
      at: job.finishedAt ?? new Date().toISOString(),
      job: job.id,
      credits: job.credits,
      kind: jobKind(job.params),
      project: job.params.output_dir,
      scene: job.params.file_stem,
    };
    try {
      mkdirSync(dirname(this.ledger), { recursive: true });
      appendFileSync(this.ledger, JSON.stringify(entry) + "\n");
    } catch (err) {
      process.stderr.write(`flow-mcp: could not write the credit ledger: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  add(params: SceneParams): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      status: "queued",
      params,
      files: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.changed(job);
    void this.work();
    return job;
  }

  get busy(): boolean {
    return this.list().some((j) => j.status === "running");
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  // Puts a failed or cancelled job back in line with the same settings and file name.
  retry(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      job.status = "queued";
      job.error = undefined;
      job.note = undefined;
      job.finishedAt = undefined;
      this.changed(job);
      void this.work();
    }
    return job;
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      this.changed(job);
    }
    return job;
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.list().find((j) => j.status === "queued");
        if (!job) return;
        if (this.lastFinished) {
          const pause = PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS);
          const remaining = this.lastFinished + pause - Date.now();
          if (remaining > 0) {
            this.pausedReason = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
            await new Promise((r) => setTimeout(r, remaining));
            this.pausedReason = null;
          }
        }
        if (job.status !== "queued") continue;
        job.status = "running";
        job.attempts++;
        this.changed(job);
        try {
          job.files = await this.runner(job);
          job.status = "done";
          job.error = undefined;
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          // Failed tiles are already retried inside Flow (its own Retry button); only an agent that produced nothing
          // is re-queued here. Timeouts are never retried automatically: they may still have spent credits.
          const retryable = /agent finished without creating/i.test(job.error);
          job.status = retryable && job.attempts <= (job.params.retries ?? 1) ? "queued" : "failed";
        }
        job.finishedAt = new Date().toISOString();
        this.lastFinished = Date.now();
        // Only a finished job is known to have been charged: Flow does not charge for a tile it reports as failed.
        if (job.status === "done") this.record(job);
        this.changed(job);
      }
    } finally {
      this.working = false;
    }
  }
}

export function readLedger(file: string): LedgerEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LedgerEntry];
      } catch {
        return [];
      }
    });
}

// Days are the computer's own calendar days, which is what a person means by "today".
export const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function spentOn(entries: LedgerEntry[], day: string): number {
  return entries.filter((e) => localDay(e.at) === day).reduce((sum, e) => sum + e.credits, 0);
}
