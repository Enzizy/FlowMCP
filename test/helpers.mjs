import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test runs against scratch folders so the real ~/.flow-mcp (token, journal, Chrome profile) is never touched.
// Call this before importing anything from dist/: those modules read their paths from the environment on load.
export function scratchEnv() {
  const root = mkdtempSync(join(tmpdir(), "flow-mcp-test-"));
  process.env.FLOW_MCP_HOME = join(root, "home");
  process.env.FLOW_MCP_OUTPUT = join(root, "films");
  process.env.FLOW_MCP_PAUSE_MIN_S = "0";
  process.env.FLOW_MCP_PAUSE_MAX_S = "0";
  delete process.env.FLOW_MCP_DAILY_CREDITS;
  return { root, home: process.env.FLOW_MCP_HOME, films: process.env.FLOW_MCP_OUTPUT };
}

export const hasFfmpeg = (() => {
  try {
    execFileSync(process.env.FLOW_MCP_FFMPEG ?? "ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// A short synthetic clip with a tone, so reframing and frame grabs can be checked without any real footage.
export function makeClip(file, { width = 640, height = 360, seconds = 2, audio = true } = {}) {
  const args = ["-y", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=24:duration=${seconds}`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", ...(audio ? ["-c:a", "aac", "-shortest"] : []), file);
  execFileSync(process.env.FLOW_MCP_FFMPEG ?? "ffmpeg", args, { stdio: "ignore" });
  return file;
}

export function probeSize(file) {
  const out = execFileSync(process.env.FLOW_MCP_FFPROBE ?? "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" });
  const [width, height] = out.trim().split(",").map(Number);
  return { width, height };
}

export async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}
