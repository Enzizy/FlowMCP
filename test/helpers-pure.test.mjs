import assert from "node:assert/strict";
import { test } from "node:test";
import { scratchEnv } from "./helpers.mjs";

scratchEnv();
const { matchScenes, newestNanoBanana } = await import("../dist/flow.js");
const { alignText } = await import("../dist/captions.js");
const { TECHNIQUES, techniqueById } = await import("../dist/techniques.js");
const { targetSize, reframeFilter, reframedName } = await import("../dist/reframe.js");

test("matchScenes pairs agent tiles with their scenes in any finish order", () => {
  const scenes = ["A red fox sitting in fresh snow at dawn", "A lighthouse on a cliff during a storm", "A bowl of ramen with steam rising"];
  const prompts = [
    "Steaming bowl of ramen, rising steam, cinematic food photography",
    "A majestic red fox sitting in fresh powder snow at dawn, soft light",
    "Dramatic lighthouse perched on a cliff in a violent storm, crashing waves",
  ];
  assert.deepEqual(matchScenes(scenes, prompts), [[1], [2], [0]]);
});

test("matchScenes leaves a scene empty when no tile is a real match", () => {
  const out = matchScenes(["A red fox sitting in fresh snow"], ["A city skyline at night with neon signs"]);
  assert.deepEqual(out, [[]]);
});

test("newestNanoBanana picks the highest version that is not Lite", () => {
  assert.equal(newestNanoBanana(["Nano Banana Pro", "Nano Banana 2 Lite", "Nano Banana 2.1"]), 2);
  assert.equal(newestNanoBanana(["Nano Banana 2.1", "Nano Banana 2.10", "Nano Banana 3 Lite"]), 1);
  assert.equal(newestNanoBanana(["Imagen 4", "Nano Banana Pro"]), -1);
});

test("alignText keeps timings of matching words and spreads corrected ones", () => {
  const timed = [
    { text: "Hello", start: 0, end: 0.4 },
    { text: "flo", start: 0.5, end: 0.8 },
    { text: "world", start: 0.9, end: 1.3 },
  ];
  const out = alignText(timed, "Hello Flow world");
  assert.equal(out.length, 3);
  assert.equal(out[0].start, 0);
  assert.equal(out[2].start, 0.9);
  assert.equal(out[1].text, "Flow");
  assert.ok(out[1].start >= 0.4 && out[1].end <= 0.9);
});

test("technique ids are unique and every one resolves", () => {
  const ids = TECHNIQUES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(techniqueById(id)?.phrase.length > 10, id);
});

test("targetSize keeps the long side and stays even", () => {
  assert.deepEqual(targetSize(1280, 720, "9:16"), { width: 720, height: 1280 });
  assert.deepEqual(targetSize(1920, 1080, "1:1"), { width: 1920, height: 1920 });
  assert.deepEqual(targetSize(1280, 720, "4:5"), { width: 1024, height: 1280 });
  assert.deepEqual(targetSize(720, 1280, "16:9"), { width: 1280, height: 720 });
  const odd = targetSize(1001, 563, "9:16");
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
});

test("reframeFilter builds one graph per fill and clamps focus", () => {
  assert.match(reframeFilter("crop", 720, 1280, 0), /crop=720:1280:\(iw-720\)\*0:/);
  assert.match(reframeFilter("crop", 720, 1280, 250), /\*1:/);
  assert.match(reframeFilter("fit", 720, 1280), /pad=720:1280/);
  const blur = reframeFilter("blur", 720, 1280);
  assert.match(blur, /boxblur=18:2/);
  assert.match(blur, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
  for (const g of [blur, reframeFilter("crop", 720, 1280), reframeFilter("fit", 720, 1280)]) assert.match(g, /\[v\]$/);
});

test("reframedName tags the shape and never reuses a name", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "reframe-name-"));
  const first = reframedName(dir, "/x/My film.mp4", "9:16");
  assert.equal(first, join(dir, "My_film-9x16.mp4"));
  writeFileSync(first, "");
  assert.equal(reframedName(dir, "/x/My film.mp4", "9:16"), join(dir, "My_film-9x16-2.mp4"));
});
