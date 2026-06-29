// api/research-config.ts  ->  /api/research-config
//
// Backs the per-project research on/off switch on the Foundry board.
//   GET                          -> { ok, projects: [{ name, enabled }] }
//        every known project with its current flag (default false / off)
//   POST { project, enabled }    -> flips one project's research toggle
//
// State lives in the spreadsheet's "Config" tab (see pipeline-common), so the board
// can flip it with no code deploy and research.ts reads it on its next run.
// Browser-open posture (no cron secret), like the other board endpoints.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PROJECTS, getSheets, readResearchEnabled, setResearchEnabled } from "../lib/pipeline-common.js";
export const maxDuration = 30;

const sheets = getSheets();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "GET") {
      const enabled = await readResearchEnabled(sheets);
      const projects = PROJECTS.map((p) => ({ name: p.name, enabled: enabled.get(p.name) === true }));
      return res.status(200).json({ ok: true, projects });
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const project = String(body?.project || "").trim();
      const enabled = body?.enabled === true || /^(true|yes|on|1)$/i.test(String(body?.enabled || ""));
      if (!project) return res.status(400).json({ ok: false, error: "missing project" });
      if (!PROJECTS.some((p) => p.name === project)) {
        return res.status(404).json({ ok: false, error: `unknown project: ${project}` });
      }
      await setResearchEnabled(sheets, project, enabled);
      return res.status(200).json({ ok: true, project, enabled });
    }

    return res.status(405).json({ ok: false, error: "GET or POST only" });
  } catch (err: any) {
    console.error("[research-config] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
