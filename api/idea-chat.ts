// api/idea-chat.ts  ->  POST /api/idea-chat
//
// The Captured-stage "scope check" assistant. Helps the user answer one question —
// "do we have the scope right?" — BEFORE an idea goes to design, then sharpens the
// idea's boundaries from that conversation. It deliberately does NOT work through the
// idea's open questions or resolve implementation details: that is design's job, and
// doing it here would blur the two stages.
// Same browser-open posture as design-chat (no cron secret).
//
// Two modes:
//   { mode:'chat',    idea, messages } -> { ok, text }
//       Pressure-test scope: one idea or several? too big / too thin? in-vs-out boundary?
//       overlap with something already built? Stays out of "how to build it".
//   { mode:'rewrite', idea, messages } -> { ok, idea:{ reasoning, aiNative } }
//       Sharpen the Description + in/out boundary from the scope decisions. Does NOT
//       form or touch open questions — those are created at the design step.
//
// Grounded: pulls the matching project context so the assistant reasons within the
// product's REAL constraints (e.g. tenant-only auth, static HTML) rather than guessing.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { projectByName, DEFAULT_MODEL } from "../lib/pipeline-common.js";
export const maxDuration = 60;

const MODEL = DEFAULT_MODEL; // sonnet — good for conversational reasoning + a structured rewrite

async function callClaude(system: string, messages: { role: string; content: string }[], maxTokens: number): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
}

function ideaBlock(idea: any): string {
  return [
    `Title: ${idea?.title || "(untitled)"}`,
    `Description: ${idea?.reasoning || "(none)"}`,
    `AI-native approach: ${idea?.aiNative || "(none)"}`,
    `Open questions:\n${idea?.openQuestions || "(none recorded)"}`,
  ].join("\n");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { mode, idea, messages } = body || {};
    if (!idea) return res.status(400).json({ ok: false, error: "missing idea" });

    const project = projectByName(idea.product);
    const projectNote = project
      ? `This idea targets "${project.name}". Answer within these REAL constraints — never propose an answer that assumes a capability the product doesn't have:\n${project.context}`
      : `Answer within realistic, conservative product constraints; do not assume infrastructure that may not exist.`;

    const convo = (Array.isArray(messages) ? messages : []).filter(
      (m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    );

    if (mode === "rewrite") {
      const system =
`You are sharpening an idea's SCOPE before it goes to design, using the scope decisions the
user reached in the conversation below. Your job is to make the idea's boundaries crisp.
Design questions are NOT formed here — they are created at the design step once scope is
locked — so do not produce or answer any.

${projectNote}

CURRENT IDEA:
${ideaBlock(idea)}

Return ONLY a JSON object, no prose, no markdown fences:
{
  "reasoning": "the Description as it should now READ — a clean, standalone statement of what this idea IS and its in/out boundary, written as if it were the idea from the start. Describe ONLY the current idea. Do NOT narrate the change or reference the conversation: no 'scope narrowed', no 'this is NOT a footer', no 'we decided against X', no 'originally this was…'. State the in-scope work plainly and the out-of-scope boundary plainly, without framing it as things that were removed. Downstream (design) reads this as the spec, so it must stand on its own with no history baked in.",
  "aiNative": "the AI-native approach note, updated only if a scope decision changed it; otherwise return it unchanged"
}`;
      const msgs = [...convo];
      if (msgs.length === 0 || msgs[msgs.length - 1].role !== "user") {
        msgs.push({ role: "user", content: "Sharpen the scope now from our discussion, as the JSON object specified." });
      }
      const text = await callClaude(system, msgs, 2000);
      let parsed: any;
      try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")); }
      catch { return res.status(200).json({ ok: false, error: "could not parse the rewrite — try again" }); }
      return res.status(200).json({
        ok: true,
        idea: {
          reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : (idea.reasoning || ""),
          aiNative: typeof parsed.aiNative === "string" ? parsed.aiNative : (idea.aiNative || ""),
        },
      });
    }

    // default: chat
    const system =
`You are a sharp product partner doing a SCOPE review of an idea BEFORE it goes to design.
The only question you are helping answer is: "do we have the scope right?" Pressure-test the
idea's boundaries:
- Is this ONE coherent change, or several things bundled together that should be split?
- Is it too big (and should be cut down) or too thin to be worth building on its own?
- Is the in/out boundary crisp — what is explicitly included, and what is explicitly NOT?
- Is it solving the real problem, or a symptom of it?
- Does it look like it overlaps with something likely already built? If so, flag it.

Keep replies short — a few sentences. Offer a clear recommendation, but defer to the user's call.

OPENING: when you start the conversation, do NOT greet generically — lead with the 2-3 sharpest
SCOPE questions THIS specific idea raises (e.g. which surfaces/pages it covers, what's explicitly
in vs out, whether it's one change or several, whether it's solving the real problem or a symptom).
Be concrete to this idea, naming its actual specifics — not a generic checklist.

Do NOT work through the idea's open questions, and do NOT raise DESIGN or LOOKUP questions — how to
build it, which control to use, whether to persist state, where a selector lives, whether some
element already exists. Those are answered later (design forms them, or the build agent reads the
file). You only ask SCOPE questions: what are we building and what are its boundaries.
If the user drifts into "how should it work," say that's design's job and steer back to scope.
When the scope feels settled, tell the user to hit "Rewrite idea from chat" and then run design.

${projectNote}

CURRENT IDEA:
${ideaBlock(idea)}`;
    const msgs = convo.length ? convo : [{ role: "user", content: "Let's start — is the scope of this idea right?" }];
    const text = await callClaude(system, msgs, 1200);
    return res.status(200).json({ ok: true, text });
  } catch (err: any) {
    console.error("[idea-chat] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
