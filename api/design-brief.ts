/**
 * api/design-brief.ts  ->  GET/POST /api/design-brief
 * Promotes top-priority "Captured" ideas (and re-does any "Designing" rows the watcher
 * sent back with feedback) into a Design Brief + Build Sequence, then moves them to "In Review".
 *
 * Input-aware: if the Captured idea ALREADY carries a Design Brief / Build Sequence
 * (e.g. a fully-baked idea added through intake), design-brief switches from "generate
 * from scratch" to "refine + verify + preserve" — it builds on the submitted spec rather
 * than overwriting it. Both modes run a functional-slice + scope/brand-lock check.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import {
  projectByName, AI_NATIVE_DIRECTIVE, Project, cronAuthorized,
  getSheets, readQueue, updateCells, QueueRow, DEFAULT_MODEL,
} from "../lib/pipeline-common.js";
export const maxDuration = 300;

const MODEL = DEFAULT_MODEL;        // "claude-opus-4-8" is worth it here - the brief shapes the build
const MAX_NEW_PER_RUN = 1;
const PRIORITY_THRESHOLD = 60;

const anthropic = new Anthropic();
const sheets = getSheets();

interface Brief { designBrief: string; buildSequence: string; }

// The review every brief must pass, in either mode. Surfaced in the brief text for now;
// dependency-card generation is a separate follow-on.
const SLICE_AND_SCOPE_CHECK = `BEFORE finalizing, run these checks and reflect them in the DESIGN BRIEF:
- FUNCTIONAL SLICE: State plainly whether this ships as an independently usable capability or as
  foundation that depends on something not yet built. If it depends on unbuilt work to function,
  name that dependency explicitly and label this brief "ships as foundation (blocked by: <dep>)".
  Do not silently scope a feature down to a non-working half.
- SCOPE / BRAND LOCKS: If the idea carries scope decisions or forbids a product/brand/codename,
  verify the brief and build sequence honor them. Flag any violation explicitly rather than
  passing it through.`;

async function generate(project: Project, row: QueueRow): Promise<Brief | null> {
  const feedback = row.get("Review Feedback");
  const isRedo = row.get("Stage") === "Designing" && !!feedback;

  // Refine mode when the idea already carries a brief or build sequence.
  const submittedBrief = (row.get("Design Brief") || "").trim();
  const submittedSequence = (row.get("Build Sequence") || "").trim();
  const isRefine = !!(submittedBrief || submittedSequence);

  const brandGuidance =
    project.kind === "product"
      ? "Apply the product's own brand if it has one; otherwise keep it clean, modern, and trustworthy for professional buyers. Do not use NewWay Digital's brand - this is the product, not NewWay."
      : "Use the CLIENT's branding. If unknown, use neutral, professional styling. Never impose NewWay Digital's brand on client-facing work.";

  const deployGuidance =
    project.deploy === "design-only"
      ? "Deploy policy is DESIGN-ONLY: the build sequence is a spec a human developer will execute against the client's own infrastructure. Write it as clear hand-off steps, not instructions for an autonomous agent."
      : "The build sequence will drive an autonomous Claude Code session that builds to preview/staging first. Write concrete, ordered, executable steps.";

  // The task framing forks on mode; everything else (model, parse, shape) stays identical.
  const task = isRefine
    ? `You are REFINING a submitted spec, not writing one from scratch. The author has already
provided a Design Brief and/or Build Sequence below. PRESERVE their intent, structure, and
specifics. Do NOT rewrite it into something different, do NOT thin it down, do NOT reorder for
taste. Only: tighten genuinely unclear wording, fill clear gaps, ensure it follows this project's
conventions, and run the checks below. If the submitted spec is already sound, return it
essentially unchanged. Output the refined Design Brief and Build Sequence.

SUBMITTED DESIGN BRIEF:
${submittedBrief || "(none provided — derive a brief consistent with the submitted build sequence)"}

SUBMITTED BUILD SEQUENCE:
${submittedSequence || "(none provided — derive one consistent with the submitted brief)"}`
    : `Produce two things for the idea below, generating them from the idea's substance:

1. DESIGN BRIEF - ready for Claude Design. Center it on the AI-NATIVE INTERACTION: the primary
   surface should be conversational/agentic, not a form-and-dashboard, consistent with the idea's
   AI-Native Approach. Cover: the user and job-to-be-done; the core AI-native interaction and what
   makes it feel intelligent; key surfaces; the primary end-to-end flow; what data/state is shown;
   styling direction. ${brandGuidance}

2. BUILD SEQUENCE - ordered steps. Build the AI/agent core FIRST, then scaffolding (storage, auth,
   integrations, deploy). Call out any conventional-code fallback and why. ${deployGuidance}`;

  const system = `You are a senior product designer + tech lead for this project.

${project.context}

${AI_NATIVE_DIRECTIVE}

${task}

${isRefine ? `Conventions to enforce while refining: ${brandGuidance} ${deployGuidance}` : ""}

${SLICE_AND_SCOPE_CHECK}

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
