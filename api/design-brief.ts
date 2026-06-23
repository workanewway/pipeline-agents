/**
 * api/design-brief.ts  ->  GET/POST /api/design-brief
 * Promotes top-priority "Captured" ideas (and re-does any "Designing" rows the watcher
 * sent back with feedback) into a Design Brief + Build Sequence, then moves them to "In Review".
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import {
  projectByName, AI_NATIVE_DIRECTIVE, Project, cronAuthorized,
  getSheets, readQueue, updateCells, QueueRow, DEFAULT_MODEL,
} from "../lib/pipeline-common.js";

const MODEL = DEFAULT_MODEL;        // "claude-opus-4-8" is worth it here - the brief shapes the build
const MAX_NEW_PER_RUN = 2;
const PRIORITY_THRESHOLD = 60;

const anthropic = new Anthropic();
const sheets = getSheets();

interface Brief { designBrief: string; buildSequence: string; }

async function generate(project: Project, row: QueueRow): Promise<Brief | null> {
  const feedback = row.get("Review Feedback");
  const isRedo = row.get("Stage") === "Designing" && !!feedback;

  const brandGuidance =
    project.kind === "product"
      ? "Apply the product's own brand if it has one; otherwise keep it clean, modern, and trustworthy for professional buyers. Do not use NewWay Digital's brand - this is the product, not NewWay."
      : "Use the CLIENT's branding. If unknown, use neutral, professional styling. Never impose NewWay Digital's brand on client-facing work.";

  const deployGuidance =
    project.deploy === "design-only"
      ? "Deploy policy is DESIGN-ONLY: the build sequence is a spec a human developer will execute against the client's own infrastructure. Write it as clear hand-off steps, not instructions for an autonomous agent."
      : "The build sequence will drive an autonomous Claude Code session that builds to preview/staging first. Write concrete, ordered, executable steps.";

  const system = `You are a senior product designer + tech lead for this project.

${project.context}

${AI_NATIVE_DIRECTIVE}

Produce two things for the idea below:

1. DESIGN BRIEF - ready for Claude Design. Center it on the AI-NATIVE INTERACTION: the primary
   surface should be conversational/agentic, not a form-and-dashboard, consistent with the idea's
   AI-Native Approach. Cover: the user and job-to-be-done; the core AI-native interaction and what
   makes it feel intelligent; key surfaces; the primary end-to-end flow; what data/state is shown;
   styling direction. ${brandGuidance}

2. BUILD SEQUENCE - ordered steps. Build the AI/agent core FIRST, then scaffolding (storage, auth,
   integrations, deploy). Call out any conventional-code fallback and why. ${deployGuidance}

${isRedo ? `THIS IS A REVISION. Wayne sent it back with this feedback:
"${feedback}"
Address it directly and note in the brief how this version responds.` : ""}

Output ONLY a JSON object, no prose, no fences:
{ "designBrief": string, "buildSequence": string }`;

  const user = `Idea: ${row.get("Title")}
Reasoning: ${row.get("Reasoning")}
AI-Native Approach: ${row.get("AI-Native Approach")}
Open Questions: ${row.get("Open Questions")}`;

  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = resp.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .replace(/```json|```/g, "")
    .trim();

  try {
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json);
    if (parsed.designBrief && parsed.buildSequence) return parsed as Brief;
    return null;
  } catch {
    console.error(`[${row.get("Idea ID")}] could not parse brief JSON. Raw:\n`, text);
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!cronAuthorized(req.headers.authorization)) return res.status(401).json({ error: "unauthorized" });

  const now = new Date().toISOString();
  try {
    const { rows } = await readQueue(sheets);

    const redos = rows.filter((r) => r.get("Stage") === "Designing" && r.get("Review Feedback"));
    const fresh = rows
      .filter((r) => r.get("Stage") === "Captured" && Number(r.get("Priority Score")) >= PRIORITY_THRESHOLD)
      .sort((a, b) => Number(b.get("Priority Score")) - Number(a.get("Priority Score")))
      .slice(0, MAX_NEW_PER_RUN);

    const targets = [...redos, ...fresh];
    const designed: string[] = [];

    for (const row of targets) {
      const project = projectByName(row.get("Product"));
      if (!project) continue;
      const brief = await generate(project, row);
      if (!brief) continue;
      await updateCells(sheets, row.rowNum, {
        "Design Brief": brief.designBrief,
        "Build Sequence": brief.buildSequence,
        Stage: "In Review",
        "Updated At": now,
      });
      designed.push(row.get("Idea ID"));
    }

    return res.status(200).json({ ok: true, designed, count: designed.length });
  } catch (err: any) {
    console.error("[design-brief] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
