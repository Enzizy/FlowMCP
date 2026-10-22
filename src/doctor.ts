#!/usr/bin/env node
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, statfsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { captionSetup } from "./captions.js";
import { CDP_PORT, cdpUp, chromeExecutable, HOME_DIR, PROFILE_DIR } from "./chrome.js";
import { geminiKey } from "./gemini.js";
import { FFMPEG_HINT } from "./platform.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FLOW_MCP_FFPROBE ?? "ffprobe";
const OUTPUT_ROOT_DEFAULT = process.env.FLOW_MCP_OUTPUT;

export type CheckLevel = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
  fix?: string;
  needed_for: string;
}

const version = async (bin: string) =>
  run(bin, ["-version"]).then(
    ({ stdout }) => stdout.split("\n")[0].trim(),
    () => undefined,
  );

// Everything flow-mcp leans on, checked without opening Chrome or touching Flow, so it is safe to run at any time.
// A "fail" stops the core features; a "warn" only stops an optional one.
export async function runChecks(outputRoot: string, port: number): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const major = Number(process.versions.node.split(".")[0]);
  add({ name: "Node.js", needed_for: "everything", level: major >= 22 ? "ok" : "fail", detail: `v${process.versions.node}`, fix: major >= 22 ? undefined : "Install Node.js 22 or newer." });

  try {
    add({ name: "Google Chrome", needed_for: "driving Flow", level: "ok", detail: chromeExecutable() });
  } catch (err) {
    add({ name: "Google Chrome", needed_for: "driving Flow", level: "fail", detail: "not found", fix: err instanceof Error ? err.message : String(err) });
  }

  const signedInOnce = existsSync(PROFILE_DIR) && readdirSync(PROFILE_DIR).length > 0;
  add({
    name: "Flow Chrome profile",
    needed_for: "driving Flow",
    level: signedInOnce ? "ok" : "fail",
    detail: signedInOnce ? PROFILE_DIR : "no profile yet",
    fix: signedInOnce ? undefined : "Run `npm run login`, sign in to Google by hand and open a Flow project.",
  });

  const cdp = await cdpUp();
  add({
    name: "Flow Chrome window",
    needed_for: "driving Flow",
    level: cdp ? "ok" : "warn",
    detail: cdp ? `open, debugging port ${CDP_PORT}` : "not running",
    fix: cdp ? undefined : "It opens by itself on the first Flow call; `npm run login` opens it by hand. Call flow_status to check sign-in and credits.",
  });

  const ffmpeg = await version(FFMPEG);
  const ffprobe = await version(FFPROBE);
  add({
    name: "FFmpeg",
    needed_for: "chaining shots, assembling, reframing, frames, narration with computer voices",
    level: ffmpeg && ffprobe ? "ok" : "warn",
    detail: ffmpeg ?? "not found",
    fix: ffmpeg && ffprobe ? undefined : FFMPEG_HINT,
  });

  const captions = await captionSetup().catch(() => undefined);
  add({
    name: "whisper.cpp",
    needed_for: "captions and transcripts",
    level: captions?.whisper ? "ok" : "warn",
    detail: captions?.whisper ? `models: ${Object.entries(captions.models).filter(([, v]) => v).map(([k]) => k).join(", ") || "none yet (download on first use)"}` : "whisper-cli not found",
    fix: captions?.whisper ? undefined : captions?.whisper_hint,
  });

  const key = Boolean(geminiKey());
  add({
    name: "Google AI Studio key",
    needed_for: "narration in Google's voices",
    level: key ? "ok" : "warn",
    detail: key ? "set (not shown)" : "not set",
    fix: key ? undefined : "Paste it in Flow Studio -> Voice, or set GEMINI_API_KEY. Never paste it into a chat.",
  });

  try {
    mkdirSync(outputRoot, { recursive: true });
    accessSync(outputRoot, constants.W_OK);
    const fs = statfsSync(outputRoot);
    const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
    add({
      name: "Films folder",
      needed_for: "saving everything",
      level: freeGb < 2 ? "warn" : "ok",
      detail: `${outputRoot} (${freeGb.toFixed(1)} GB free)`,
      fix: freeGb < 2 ? "Less than 2 GB free: clips and speech models need room." : undefined,
    });
  } catch (err) {
    add({ name: "Films folder", needed_for: "saving everything", level: "fail", detail: `${outputRoot} is not writable`, fix: err instanceof Error ? err.message : String(err) });
  }

  const panel = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }).then(
    (r) => r.json() as Promise<{ name?: string }>,
    () => null,
  );
  add({
    name: "Flow Studio port",
    needed_for: "the control panel, and sharing one queue between apps",
    level: panel && panel.name !== "flow-mcp" ? "warn" : "ok",
    detail: panel?.name === "flow-mcp" ? `served by flow-mcp at http://127.0.0.1:${port}` : panel ? `port ${port} is used by another program` : `port ${port} is free`,
    fix: panel && panel.name !== "flow-mcp" ? "Set FLOW_MCP_PORT to a free port." : undefined,
  });

  return { ok: checks.every((c) => c.level !== "fail"), checks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const port = Number(process.env.FLOW_MCP_PORT ?? 8787);
  const { ok, checks } = await runChecks(OUTPUT_ROOT_DEFAULT ?? join(homedir(), "flow-mcp-out"), port);
  const mark = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
  for (const c of checks) {
    console.log(`${mark[c.level]}  ${c.name}: ${c.detail}`);
    if (c.fix) console.log(`      -> ${c.fix}`);
  }
  console.log(`\nflow-mcp home: ${HOME_DIR}`);
  console.log(ok ? "Ready." : "Fix the FAIL lines above first.");
  process.exit(ok ? 0 : 1);
}
