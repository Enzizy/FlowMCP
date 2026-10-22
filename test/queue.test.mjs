import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratchEnv, until } from "./helpers.mjs";

const { home } = scratchEnv();
const { JobQueue, localDay, readLedger, spentOn, jobKind } = await import("../dist/queue.js");

const params = (over = {}) => ({ prompt: "a fox", type: "video", max_credits: 25, output_dir: "/films/Test", file_stem: "scene-01", ...over });

test("a finished paid job is journalled and its credits go into the ledger", async () => {
  const journal = join(home, "q1.json");
  const ledger = join(home, "q1.jsonl");
  const q = new JobQueue(async (job) => {
    job.credits = 7;
    return ["/films/Test/scene-01.mp4"];
  });
  q.persist(journal, ledger);
  const job = q.add(params());
  assert.ok(await until(() => q.get(job.id).status === "done"));
  const saved = JSON.parse(readFileSync(journal, "utf8"));
  assert.equal(saved[0].status, "done");
  assert.deepEqual(saved[0].files, ["/films/Test/scene-01.mp4"]);
  const entries = readLedger(ledger);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].credits, 7);
  assert.equal(entries[0].kind, "video");
  assert.equal(spentOn(entries, localDay(new Date().toISOString())), 7);
});

test("a failed job is not charged in the ledger", async () => {
  const ledger = join(home, "q2.jsonl");
  const q = new JobQueue(async (job) => {
    job.credits = 12;
    throw new Error("Flow reported the generation failed");
  });
  q.persist(join(home, "q2.json"), ledger);
  const job = q.add(params());
  assert.ok(await until(() => q.get(job.id).status === "failed"));
  assert.equal(existsSync(ledger), false);
});

test("after a restart, a running job is interrupted and a queued one is set aside, never re-run", async () => {
  const journal = join(home, "q3.json");
  const now = new Date().toISOString();
  writeFileSync(
    journal,
    JSON.stringify([
      { id: "run1", status: "running", params: params(), files: [], attempts: 1, createdAt: now, progress: "40%" },
      { id: "wait1", status: "queued", params: params({ file_stem: "scene-02" }), files: [], attempts: 0, createdAt: now },
      { id: "done1", status: "done", params: params({ file_stem: "scene-03" }), files: ["x.mp4"], attempts: 1, createdAt: now, finishedAt: now },
    ]),
  );
  let ran = 0;
  const q = new JobQueue(async () => {
    ran++;
    return [];
  });
  q.persist(journal, join(home, "q3.jsonl"));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ran, 0, "nothing restored may run by itself");
  assert.equal(q.get("run1").status, "failed");
  assert.match(q.get("run1").error, /^Interrupted:/);
  assert.equal(q.get("run1").progress, undefined);
  assert.equal(q.get("wait1").status, "cancelled");
  assert.match(q.get("wait1").note, /flow_retry/);
  assert.equal(q.get("done1").status, "done");

  q.retry("wait1");
  assert.ok(await until(() => q.get("wait1").status === "done"));
  assert.equal(ran, 1);
  assert.equal(q.get("wait1").note, undefined);
});

test("an unreadable journal is moved aside instead of crashing", () => {
  const journal = join(home, "q4.json");
  writeFileSync(journal, "{not json");
  const q = new JobQueue(async () => []);
  q.persist(journal, join(home, "q4.jsonl"));
  assert.equal(q.list().length, 0);
  assert.equal(existsSync(journal), false);
});

test("the ledger skips broken lines and sums by local day", () => {
  const ledger = join(home, "q5.jsonl");
  const today = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  writeFileSync(ledger, [JSON.stringify({ at: today, credits: 10 }), "garbage", JSON.stringify({ at: today, credits: 5 }), JSON.stringify({ at: old, credits: 100 })].join("\n") + "\n");
  const entries = readLedger(ledger);
  assert.equal(entries.length, 3);
  assert.equal(spentOn(entries, localDay(today)), 15);
  assert.equal(spentOn(entries, localDay(old)), 100);
});

test("jobKind names every kind of job", () => {
  assert.equal(jobKind(params()), "video");
  assert.equal(jobKind(params({ type: "image" })), "image");
  assert.equal(jobKind(params({ edit_asset: "x" })), "edit");
  assert.equal(jobKind(params({ continue_from: "x" })), "continue");
  assert.equal(jobKind(params({ agent_scenes: ["a"] })), "agent");
});
