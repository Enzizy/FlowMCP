import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hasFfmpeg, makeClip, probeSize, scratchEnv } from "./helpers.mjs";

// Starts the real server over stdio on a spare port with scratch folders, as an app would, and only calls tools that
// never open Chrome or Flow.
const { root, home, films } = scratchEnv();
const PORT = String(18000 + Math.floor(Math.random() * 1000));
let client;

before(async () => {
  const now = new Date().toISOString();
  mkdirSync(home, { recursive: true });
  // A job that was mid-run when an earlier process died: the new owner must report it, not re-run it.
  writeFileSync(
    join(home, "jobs.json"),
    JSON.stringify([{ id: "dead0001", status: "running", params: { prompt: "a fox", type: "video", max_credits: 25, output_dir: join(films, "Old"), file_stem: "scene-01" }, files: [], attempts: 1, createdAt: now }]),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { ...process.env, FLOW_MCP_PORT: PORT, FLOW_MCP_HOME: home, FLOW_MCP_OUTPUT: films },
    stderr: "ignore",
  });
  client = new Client({ name: "flow-mcp-test", version: "1.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  rmSync(root, { recursive: true, force: true });
});

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const body = JSON.parse(res.content[0].text);
  return { body, isError: Boolean(res.isError) };
};

test("every tool is listed with a description and annotations", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["flow_status", "flow_generate", "flow_wait", "flow_reframe", "flow_frame", "flow_films", "flow_usage", "flow_jobs", "flow_doctor", "flow_captions"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  for (const t of tools) {
    assert.ok(t.description?.length > 40, `${t.name} needs a real description`);
    assert.ok(t.annotations, `${t.name} has no annotations`);
  }
  assert.ok(!names.includes("flow_set_key"), "the AI Studio key must never be settable by the assistant");
});

test("the server reports the package version", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(client.getServerVersion().version, pkg.version);
});

test("resources and prompts are offered", async () => {
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  for (const u of ["flow://playbook", "flow://techniques", "flow://jobs", "flow://usage", "flow://films"]) assert.ok(uris.includes(u), `missing ${u}`);
  const playbook = await client.readResource({ uri: "flow://playbook" });
  assert.ok(JSON.parse(playbook.contents[0].text).workflow.length > 5);

  const { prompts } = await client.listPrompts();
  const names = prompts.map((p) => p.name);
  for (const n of ["short_film", "storyboard", "vertical_reel", "caption_video", "recover"]) assert.ok(names.includes(n), `missing prompt ${n}`);
  const film = await client.getPrompt({ name: "short_film", arguments: { idea: "a lamplighter at dusk" } });
  assert.match(film.messages[0].content.text, /lamplighter/);
  assert.match(film.messages[0].content.text, /wait for my OK/);
});

test("a job that was running before the restart comes back as interrupted, and flow_retry leaves it alone", async () => {
  const { body } = await call("flow_jobs");
  const dead = body.jobs.find((j) => j.id === "dead0001");
  assert.equal(dead.status, "failed");
  assert.match(dead.error, /^Interrupted:/);
  const retry = await call("flow_retry");
  assert.equal(retry.isError, true, "a bare retry must not re-run interrupted (possibly charged) work");
});

test("flow_usage sets and clears a daily budget", async () => {
  let { body } = await call("flow_usage", { set_daily_budget: 40 });
  assert.equal(body.today.daily_budget, 40);
  assert.equal(body.today.left, 40);
  assert.equal(body.daily.length, 7);
  ({ body } = await call("flow_usage", { set_daily_budget: null }));
  assert.equal(body.today.daily_budget, null);
});

test("a paid job over the daily budget is refused before Flow is touched", async () => {
  await call("flow_usage", { set_daily_budget: 0 });
  try {
    const queued = await call("flow_generate", { project: "Budget", scenes: [{ prompt: "A paper boat drifting across a pond", type: "video", duration: 4, resolution: "360p" }] });
    assert.equal(queued.isError, false, JSON.stringify(queued.body));
    const id = queued.body.jobs[0].id;
    const { body } = await call("flow_wait", { job_ids: [id], timeout_seconds: 20 });
    assert.equal(body.finished, true);
    assert.equal(body.jobs[0].status, "failed");
    assert.match(body.jobs[0].error, /Daily credit budget reached.*Nothing was spent/);
  } finally {
    await call("flow_usage", { set_daily_budget: null });
  }
});

test("flow_doctor checks the setup without touching Flow", async () => {
  const { body } = await call("flow_doctor");
  const names = body.checks.map((c) => c.name);
  for (const n of ["Node.js", "Google Chrome", "FFmpeg", "whisper.cpp", "Films folder"]) assert.ok(names.includes(n), `missing check ${n}`);
  assert.ok(body.checks.every((c) => ["ok", "warn", "fail"].includes(c.level)));
  assert.ok(!JSON.stringify(body).match(/AIza|AQ\.[\w-]{20}/), "the key itself must never be shown");
});

test("flow_reframe, flow_frame and flow_films work on a real clip", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const dir = join(films, "Reel");
  mkdirSync(dir, { recursive: true });
  const clip = makeClip(join(dir, "final.mp4"));

  const preview = await call("flow_reframe", { video: clip, preview: true });
  assert.equal(preview.isError, false, JSON.stringify(preview.body));
  assert.ok(existsSync(preview.body.preview));
  assert.deepEqual({ width: preview.body.width, height: preview.body.height }, { width: 360, height: 640 });

  for (const fill of ["blur", "crop", "fit"]) {
    const { body, isError } = await call("flow_reframe", { video: clip, fill, focus: 30 });
    assert.equal(isError, false, JSON.stringify(body));
    assert.deepEqual(probeSize(body.output), { width: 360, height: 640 });
    assert.equal(body.credits, 0);
  }

  const square = await call("flow_reframe", { video: clip, aspect: "1:1" });
  assert.deepEqual(probeSize(square.body.output), { width: 640, height: 640 });

  for (const at of ["first", "last", 1.2]) {
    const { body, isError } = await call("flow_frame", { video: clip, at, format: at === "last" ? "png" : "jpg" });
    assert.equal(isError, false, JSON.stringify(body));
    assert.ok(existsSync(body.output), body.output);
  }

  const { body } = await call("flow_films");
  const reel = body.projects.find((p) => p.name === "Reel");
  assert.ok(reel.files.some((f) => f.name === "final-9x16.mp4"));
  assert.ok(reel.files.some((f) => f.name === "final-1x1.mp4"));

  const res = await client.readResource({ uri: "flow://films/Reel" });
  assert.ok(JSON.parse(res.contents[0].text).files.length >= 5);
});

test("a missing file gives a plain error", async () => {
  const { body, isError } = await call("flow_frame", { video: join(films, "nope.mp4") });
  assert.equal(isError, true);
  assert.match(body.error, /no video at/);
});
