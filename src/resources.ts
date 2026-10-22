import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Core } from "./core.js";
import { PLAYBOOK } from "./playbook.js";
import { TECHNIQUES } from "./techniques.js";

type Films = { root: string; projects: { name: string; dir: string; files: { name: string; path: string; kind: string }[] }[] };

const asJson = (uri: URL | string, data: unknown) => ({
  contents: [{ uri: String(uri), mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
});

// Read-only context an app can attach without calling a tool. None of these touch Flow or the Chrome window: anything
// that needs the page (assets, characters, credits) stays a tool, so reading a resource can never interrupt a job.
export function registerResources(server: McpServer, core: Core) {
  server.registerResource(
    "playbook",
    "flow://playbook",
    { title: "Flow prompt playbook", description: "How to plan scenes Flow can run: workflow, models and prices, prompt order and rules, continuity tools.", mimeType: "application/json" },
    (uri) => asJson(uri, PLAYBOOK),
  );

  server.registerResource(
    "techniques",
    "flow://techniques",
    { title: "Film technique presets", description: "Every camera, product, transition and image preset, with the exact phrase it adds to a prompt.", mimeType: "application/json" },
    (uri) => asJson(uri, TECHNIQUES),
  );

  server.registerResource(
    "jobs",
    "flow://jobs",
    { title: "Flow job history", description: "The 50 newest jobs with status, files, credits and errors, kept across restarts.", mimeType: "application/json" },
    async (uri) => asJson(uri, await core.jobs({ limit: 50 })),
  );

  server.registerResource(
    "usage",
    "flow://usage",
    { title: "Credit spending", description: "Credits spent per day, project and kind of job over the last 30 days, and the daily budget.", mimeType: "application/json" },
    async (uri) => asJson(uri, await core.usage({ days: 30 })),
  );

  server.registerResource(
    "films",
    "flow://films",
    { title: "Saved films", description: "Every project folder on this computer with its clips, stills and narrations.", mimeType: "application/json" },
    async (uri) => asJson(uri, await core.outputs()),
  );

  const films = async () => (await core.outputs()) as Films;
  server.registerResource(
    "film-project",
    new ResourceTemplate("flow://films/{project}", {
      list: async () => ({
        resources: (await films()).projects.map((p) => ({ uri: `flow://films/${encodeURIComponent(p.name)}`, name: p.name, description: `${p.files.length} files in ${p.dir}`, mimeType: "application/json" })),
      }),
      complete: { project: async (value) => (await films()).projects.map((p) => p.name).filter((n) => n.toLowerCase().startsWith(value.toLowerCase())) },
    }),
    { title: "One project's files", description: "The clips, stills and narrations saved for one project.", mimeType: "application/json" },
    async (uri, { project }) => {
      const name = decodeURIComponent(String(project));
      const found = (await films()).projects.find((p) => p.name === name);
      if (!found) throw new Error(`No saved project named "${name}". flow://films lists them.`);
      return asJson(uri, found);
    },
  );
}
