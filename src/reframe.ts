import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { probe } from "./assemble.js";
import { FFMPEG_HINT } from "./platform.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";

export type Aspect = "9:16" | "1:1" | "4:5" | "16:9";
export type Fill = "blur" | "crop" | "fit";

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

// The output keeps the source's long side, so a 720p clip becomes 720x1280 rather than being blown up to 1080x1920.
export function targetSize(width: number, height: number, aspect: Aspect): { width: number; height: number } {
  const [aw, ah] = aspect.split(":").map(Number);
  const long = Math.max(width, height);
  if (aw === ah) return { width: even(long), height: even(long) };
  return aw < ah ? { width: even((long * aw) / ah), height: even(long) } : { width: even(long), height: even((long * ah) / aw) };
}

// One filter graph per way of filling the new frame. `focus` (0-100) is where the crop sits across the picture: 50 is
// the middle, 0 the left edge (or the top, when a tall video is cropped to a wide one).
export function reframeFilter(fill: Fill, w: number, h: number, focus = 50): string {
  const f = Math.min(100, Math.max(0, focus)) / 100;
  const cover = `scale=${w}:${h}:force_original_aspect_ratio=increase`;
  const crop = `crop=${w}:${h}:(iw-${w})*${f}:(ih-${h})*${f}`;
  if (fill === "crop") return `[0:v]${cover},${crop},setsar=1[v]`;
  if (fill === "fit") return `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v]`;
  // Blurred fill: the whole picture in the middle, a blurred and slightly darkened enlargement of it behind. Nothing is
  // cut off, and the bands above and below are a calm place for captions.
  // boxblur refuses a radius above a quarter of the smaller side (its chroma planes are half size), so stay well under.
  const radius = Math.max(2, Math.round(Math.min(w, h) / 40));
  return `[0:v]split[a][b];[a]${cover},crop=${w}:${h},boxblur=${radius}:2,eq=brightness=-0.06[bg];[b]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`;
}

export function reframedName(dir: string, video: string, aspect: Aspect): string {
  const stem = basename(video, extname(video)).replace(/[^\w.-]+/g, "_");
  const tag = aspect.replace(":", "x");
  for (let i = 1; ; i++) {
    const out = join(dir, `${stem}-${tag}${i > 1 ? `-${i}` : ""}.mp4`);
    if (!existsSync(out)) return out;
  }
}

const ffmpeg = async (args: string[], what: string) => {
  await run(FFMPEG, args, { maxBuffer: 16 * 1024 * 1024 }).catch((err: NodeJS.ErrnoException & { stderr?: string }) => {
    if (err.code === "ENOENT") throw new Error(`${what} needs ffmpeg, which isn't installed (${FFMPEG_HINT}).`);
    const last = String(err.stderr ?? err.message).trim().split("\n").slice(-3).join(" ");
    throw new Error(`${what} failed: ${last}`);
  });
};

export interface ReframeOptions {
  aspect: Aspect;
  fill: Fill;
  focus?: number;
  preview?: boolean;
}

// Turns a finished film into another shape (a wide film into a 9:16 reel, say) without regenerating anything in Flow.
// With `preview` only one frame from the middle is made, so the look can be checked before the whole film is encoded.
export async function reframe(video: string, opts: ReframeOptions, output: string) {
  if (!existsSync(video)) throw new Error(`There's no video at ${video}.`);
  const info = await probe(video);
  const size = targetSize(info.width, info.height, opts.aspect);
  const graph = reframeFilter(opts.fill, size.width, size.height, opts.focus);
  mkdirSync(dirname(output), { recursive: true });
  if (opts.preview) {
    const still = output.replace(/\.mp4$/i, "-preview.jpg");
    await ffmpeg(["-y", "-ss", String(info.duration / 2), "-i", video, "-filter_complex", graph, "-map", "[v]", "-frames:v", "1", "-q:v", "3", still], "The reframe preview");
    return { preview: still, width: size.width, height: size.height, source: { width: info.width, height: info.height } };
  }
  const audio = info.hasAudio ? ["-map", "0:a", "-c:a", "copy"] : [];
  await ffmpeg(
    ["-y", "-i", video, "-filter_complex", graph, "-map", "[v]", ...audio, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output],
    "Reframing",
  );
  return { output, width: size.width, height: size.height, duration: info.duration, source: { width: info.width, height: info.height }, credits: 0 };
}

// Saves one frame of a video as a still: for a thumbnail, a first or last frame to hand to flow_generate, or a check.
export async function extractFrame(video: string, at: number | "first" | "last", output: string) {
  if (!existsSync(video)) throw new Error(`There's no video at ${video}.`);
  const info = await probe(video);
  mkdirSync(dirname(output), { recursive: true });
  const seek = at === "first" ? ["-ss", "0"] : at === "last" ? ["-sseof", "-0.2"] : ["-ss", String(Math.min(Math.max(0, at), Math.max(0, info.duration - 0.05)))];
  const quality = /\.png$/i.test(output) ? [] : ["-q:v", "2"];
  await ffmpeg(["-y", ...seek, "-i", video, "-update", "1", "-frames:v", "1", ...quality, output], "Saving the frame");
  if (!existsSync(output)) throw new Error(`ffmpeg wrote no frame at ${at}s; the video is ${info.duration.toFixed(2)} s long.`);
  return { output, width: info.width, height: info.height, at, duration: info.duration };
}
