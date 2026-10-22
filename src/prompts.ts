import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const say = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

// Ready-made workflows an app can offer as slash commands. Each one spells out the order of tools and the points where
// the user must be asked, so the free steps are always done before anything is spent.
export function registerPrompts(server: McpServer) {
  server.registerPrompt(
    "short_film",
    {
      title: "Make a short film",
      description: "From an idea to a finished, narrated film: characters, free key frames, paid shots under a credit cap, narration, the cut.",
      argsSchema: {
        idea: z.string().describe("What the film is about."),
        shots: z.string().optional().describe("How many shots (default 3)."),
        style: z.string().optional().describe("Look, e.g. 'flat cartoon', 'photoreal golden hour'."),
        aspect: z.string().optional().describe("16:9 or 9:16 (default 16:9)."),
        max_credits_per_shot: z.string().optional().describe("Cap per shot (default 15)."),
      },
    },
    ({ idea, shots, style, aspect, max_credits_per_shot }) =>
      say(
        [
          `Make a short film with flow-mcp. Idea: ${idea}`,
          `Shots: ${shots ?? "3"}. Style: ${style ?? "your choice, stated up front"}. Aspect: ${aspect ?? "16:9"}. Cap: ${max_credits_per_shot ?? "15"} credits per shot.`,
          "",
          "1. flow_status. If it reports a problem, tell me and stop.",
          "2. Write a one-line logline and a numbered shot list (one continuous action with a beginning and an end per shot, one camera move each). Show it to me.",
          "3. If a character recurs, create it with flow_character (free) and reference it as asset:<name> in every shot.",
          "4. Draw one free key frame per shot with flow_generate (type image), using reference_previous so they stay on-model. Show me the stills and adjust until I approve.",
          "5. Tell me the expected credit total, and wait for my OK.",
          "6. Generate the shots in ONE flow_generate call, with first_frame set to each approved still and max_credits set to the cap. flow_wait until finished.",
          "7. Write narration timed to the film, record it with flow_narrate, and cut it all with flow_assemble (clip_volume around 0.25 under narration).",
          "8. Give me the path of the finished film, and offer captions (flow_captions) and a vertical version (flow_reframe).",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "storyboard",
    {
      title: "Storyboard in free stills",
      description: "A set of on-model key frames for a scene or ad, made only with free images.",
      argsSchema: {
        brief: z.string().describe("What to storyboard."),
        frames: z.string().optional().describe("How many frames (default 6)."),
        aspect: z.string().optional().describe("16:9, 9:16, 1:1, 4:3 or 3:4 (default 16:9)."),
      },
    },
    ({ brief, frames, aspect }) =>
      say(
        [
          `Storyboard this with flow-mcp, using free images only (0 credits): ${brief}`,
          `Frames: ${frames ?? "6"}. Aspect: ${aspect ?? "16:9"}.`,
          "",
          "Call flow_status first. Write the frame list and show it to me. Then make the frames in one flow_generate call (type image), with reference_previous on every frame after the first so characters, palette and light stay the same. For a large set where exact wording matters less, flow_agent_images is faster. Show me the files when they are done. Spend no credits.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "vertical_reel",
    {
      title: "Wide film to vertical reel",
      description: "Turn a finished 16:9 film into a captioned 9:16 Reel / Short / TikTok, locally and free.",
      argsSchema: {
        video: z.string().optional().describe("Path of the film. Default: ask me, or pick from flow_films."),
        fill: z.string().optional().describe("blur, crop or fit (default blur)."),
        captions: z.string().optional().describe("yes or no (default yes)."),
      },
    },
    ({ video, fill, captions }) =>
      say(
        [
          `Make a vertical 9:16 version of ${video ?? "one of my films (list them with flow_films and ask me which)"} with flow-mcp. Everything here is local and free.`,
          "",
          `1. flow_reframe with aspect 9:16, fill ${fill ?? "blur"}, preview: true. Show me the preview still and adjust (fill, focus) until I like it.`,
          "2. flow_reframe again without preview to make the video.",
          captions === "no"
            ? "3. Give me the path."
            : "3. flow_transcribe the new video, show me the words with likely mishearings fixed, and wait for my OK. Then flow_captions once with the agreed text, style bold, positioned in the lower blurred band (position about 80). Give me the path.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "caption_video",
    {
      title: "Caption a video",
      description: "Spoken-word captions, checked with you before the video is made.",
      argsSchema: {
        video: z.string().describe("Path of the video."),
        language: z.string().optional().describe("Spoken language code, e.g. en, es, ja (default: detect)."),
        style: z.string().optional().describe("bold, highlight, reveal, clean or boxed (default bold)."),
      },
    },
    ({ video, language, style }) =>
      say(
        `Caption ${video} with flow-mcp. First flow_transcribe it${language ? ` (language ${language})` : ""}, show me the words with any likely mishearings fixed (names especially), and wait for my OK. Then call flow_captions once with the agreed words as text, style ${style ?? "bold"}${language ? `, language ${language}` : ""}. Give me the path of the captioned video and its .srt.`,
      ),
  );

  server.registerPrompt(
    "recover",
    {
      title: "Recover after a crash or timeout",
      description: "Find out what really happened to paid work before anything is run again.",
      argsSchema: {},
    },
    () =>
      say(
        "Something went wrong with flow-mcp and I don't want to pay twice. Call flow_jobs and look for jobs that failed or were Interrupted. For each, check flow_assets for a clip that matches it, and use flow_download (free) for any that exist. Only suggest re-running a job whose result is truly missing from Flow, and tell me what that would cost before doing it.",
      ),
  );
}
