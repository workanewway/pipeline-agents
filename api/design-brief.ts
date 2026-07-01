/**
 * api/design-brief.ts  ->  GET/POST /api/design-brief
 * Promotes top-priority "Captured" ideas (and re-does any "Designing" rows the watcher
 * sent back with feedback) into a Design Brief + Build Sequence, then moves them to "Designing"
 * (the spec is ready to review/resolve in resolve.html; the human approves from there).
 *
 * Input-aware: if the Captured idea ALREADY carries a Design Brief / Build Sequence
 * (e.g. a fully-baked idea added through intake), design-brief switches from "generate
 * from scratch" to "refine + verify + preserve" — it builds on the submitted spec rather
 * than overwriting it. Both modes run a functional-slice + scope/brand-lock check.
 *
 * Auth: the BULK sweep (no id) is cron-only. A TARGETED call (?id= / body.id) is an
 * explicit per-card action from the Foundry UI and is allowed without the cron secret,
 * consistent with the other browser endpoints (idea, design-chat). It designs exactly
 * that one row and bypasses the priority threshold.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import {
  projectByName, AI_NATIVE_DIRECTIVE, Project, cronAuthorized,
  getSheets, readQueue, updateCells, QueueRow, DEFAULT_MODEL,
  getRepoManifest, isGithubRepo, lintIdea,
} from "../lib/pipeline-common.js";
export const maxDuration = 300;

const MODEL = DEFAULT_MODEL;        // "claude-opus-4-8" is worth it here - the brief shapes the build
const MAX_NEW_PER_RUN = 1;
const PRIORITY_THRESHOLD = 60;

const anthropic = new Anthropic();
const sheets = getSheets();

interface Brief { designBrief: string; buildSequence: string; openQuestions: string; }

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
      ? "This product has NO brand name — never invent or render one (no codename, no made-up name like 'FreightVet') anywhere in the brief, labels, placeholders, or copy. Keep it clean, modern, and trustworthy for professional buyers, using only the neutral styling described in the project context. Never use NewWay Digital's brand, and never surface a tenant/client name in the UI."
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
essentially unchanged. Output the refined Design Brief and Build Sequence, plus — as OPEN QUESTIONS
— only genuine DECISION forks that need the human's judgment (more than one acceptable answer the
codebase can't settle). Do NOT surface LOOKUP questions answerable by reading the repo (which file,
which selector, is there a variant); fold those into the build sequence as inspect-and-handle steps
instead. Do not re-open or expand scope. An empty string is correct if the only unknowns are lookups.

SUBMITTED DESIGN BRIEF:
${submittedBrief || "(none provided — derive a brief consistent with the submitted build sequence)"}

SUBMITTED BUILD SEQUENCE:
${submittedSequence || "(none provided — derive one consistent with the submitted brief)"}`
    : `Produce three things for the idea below, generating them from the idea's substance:

1. DESIGN BRIEF - ready for Claude Design. Center it on the AI-NATIVE INTERACTION: the primary
   surface should be conversational/agentic, not a form-and-dashboard, consistent with the idea's
   AI-Native Approach. Cover: the user and job-to-be-done; the core AI-native interaction and what
   makes it feel intelligent; key surfaces; the primary end-to-end flow; what data/state is shown;
   styling direction. ${brandGuidance}

2. BUILD SEQUENCE - ordered steps. Build the AI/agent core FIRST, then scaffolding (storage, auth,
   integrations, deploy). Call out any conventional-code fallback and why. ${deployGuidance}

3. OPEN QUESTIONS - surface ONLY decision questions, never lookup questions. The difference:

   - A DECISION question has more than one acceptable answer that the codebase CANNOT settle —
     it needs the human's scope, taste, or judgment (e.g. "delete these, or replace them with a
     contextual version?", "cap the height or let it grow unbounded?", "which of two UX behaviors
     at this edge?"). These are the ONLY things that belong in OPEN QUESTIONS.

   - A LOOKUP question has a single correct answer that is discoverable by simply reading the
     repository ("is it a hardcoded array or a separate JS file?", "does this container also wrap
     other elements?", "is there a mobile/responsive variant?", "where is the click handler
     defined?"). The build agent reads the real files and WILL answer these by construction.
     NEVER put a lookup in OPEN QUESTIONS — asking the human to hand-resolve something the build
     step observes for free is pure friction.

   Instead, fold every lookup INTO THE BUILD SEQUENCE as a conditional "inspect-and-handle" step,
   so the build agent resolves it against the actual code. Example: not "Open question: does the
   chip container wrap other elements?" but "Build step: inspect the chip container — if it wraps
   only chips, remove it; if it also holds other dock elements, remove only the chip children."

   Form decision questions strictly from the locked scope. Do NOT question whether the feature
   should exist, and do NOT propose a larger or different scope. If there are no genuine decision
   questions — which is common for a well-scoped change — return an empty string. An empty string
   is the correct, expected answer when the only unknowns are lookups.`;

  // Ground design in the ACTUAL files it's about to target, not just the hand-written
  // context. Reads `staging` (design's real build base). This is what lets design resolve
  // existence questions itself and catch false premises a stage earlier. Soft-fails.
  const manifest = isGithubRepo(project.repo) ? await getRepoManifest(project.repo, "staging") : "";

  const system = `You are a senior product designer + tech lead for this project.

${project.context}
${manifest ? `\n${manifest}\nUse this to ground the build sequence in files that actually exist. If the idea's premise contradicts what's here (e.g. it targets an element that isn't present, or asks for something already done), say so in the brief rather than inventing steps. Still fold within-file unknowns into the sequence as inspect-and-handle steps — the manifest lists files, not their full contents.\n` : ""}
${AI_NATIVE_DIRECTIVE}

${task}

${isRefine ? `Conventions to enforce while refining: ${brandGuidance} ${deployGuidance}` : ""}

${SLICE_AND_SCOPE_CHECK}

${isRedo ? `THIS IS A REVISION. Wayne sent it back with this feedback:
"${feedback}"
Address it directly and note in the brief how this version responds.` : ""}

Output ONLY a JSON object, no prose, no fences:
{ "designBrief": string, "buildSequence": string, "openQuestions": string }`;

  const user = `Idea: ${row.get("Title")}
Reasoning (scope): ${row.get("Reasoning")}
AI-Native Approach: ${row.get("AI-Native Approach")}
Existing open questions (may be empty — form them if so): ${row.get("Open Questions")}`;

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
    if (parsed.designBrief && parsed.buildSequence) {
      return {
        designBrief: parsed.designBrief,
        buildSequence: parsed.buildSequence,
        openQuestions: typeof parsed.openQuestions === "string" ? parsed.openQuestions : "",
      };
    }
    return null;
  } catch {
    console.error(`[${row.get("Idea ID")}] could not parse brief JSON. Raw:\n`, text);
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const now = new Date().toISOString();

  // Targeted design: ?id=IDEA-XXXX (or body.id) designs exactly that idea, bypassing
  // the priority threshold — used by the Foundry's per-card "Run design on this idea".
  const targetId = (req.query.id || (req.body && (req.body as any).id) || "").toString().trim();

  // Bulk sweeps stay cron-only; targeted single-idea calls are an explicit UI action
  // and are allowed through (same open posture as idea/design-chat).
  if (!targetId && !cronAuthorized(req.headers.authorization)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const { rows } = await readQueue(sheets);

    let targets: QueueRow[];
    if (targetId) {
      const row = rows.find((r) => r.get("Idea ID") === targetId);
      targets = row ? [row] : [];
    } else {
      const redos = rows.filter((r) => r.get("Stage") === "Designing" && r.get("Review Feedback"));
      const fresh = rows
        .filter((r) => r.get("Stage") === "Captured" && Number(r.get("Priority Score")) >= PRIORITY_THRESHOLD)
        .sort((a, b) => Number(b.get("Priority Score")) - Number(a.get("Priority Score")))
        .slice(0, MAX_NEW_PER_RUN);
      targets = [...redos, ...fresh];
    }

    // A targeted id that matched nothing is a clear 404 rather than a silent no-op.
    if (targetId && targets.length === 0) {
      return res.status(404).json({ ok: false, error: `no idea ${targetId}` });
    }

    const designed: string[] = [];

    for (const row of targets) {
      const project = projectByName(row.get("Product"));
      if (!project) continue;
      const brief = await generate(project, row);
      if (!brief) continue;
      // Deterministic consistency lint on the produced spec — flags name leakage, stale
      // narration, dead stage vocab. Non-blocking: it only writes the Lint column.
      const lint = lintIdea({
        title: row.get("Title"),
        description: row.get("Reasoning"),
        aiNative: row.get("AI-Native Approach"),
        brief: brief.designBrief,
        sequence: brief.buildSequence,
      });
      await updateCells(sheets, row.rowNum, {
        "Design Brief": brief.designBrief,
        "Build Sequence": brief.buildSequence,
        "Open Questions": brief.openQuestions,
        Stage: "Designing",
        Lint: lint,
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
