/**
 * api/design-chat.ts  ->  POST /api/design-chat
 * ---------------------------------------------------------------------------
 * Backs the working-view's conversation. Given an idea's brief + the running
 * thread, calls Claude so you can WALK THROUGH the open questions instead of
 * answering them blind in a spreadsheet cell. Stateless: the page sends the
 * whole thread each turn (same pattern as the Claude-in-artifacts examples).
 *
 * Two modes:
 *   mode "chat"    -> normal turn; Claude answers as a design collaborator.
 *   mode "rewrite" -> Claude regenerates the Build Sequence incorporating the
 *                     whole conversation, returns ONLY the new sequence text.
 *                     (Deliberate, reviewable step — the spec never mutates
 *                     silently mid-chat.)
 * ---------------------------------------------------------------------------
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL } from "../lib/pipeline-common.js";

export const maxDuration = 60;

const anthropic = new Anthropic();

interface Body {
  mode: "chat" | "rewrite";
  idea: {
    ideaId: string; title: string; product: string;
    reasoning: string; aiNative: string; openQuestions: string;
    designBrief: string; buildSequence: string;
  };
  messages: { role: "user" | "assistant"; content: string }[];
}

function systemFor(idea: Body["idea"], mode: Body["mode"]): string {
  const base = `You are a senior product designer + tech lead helping Wayne resolve the open
questions on ONE idea before it goes to an autonomous build. Be direct, surface real tradeoffs,
push back when a choice has a downside, and don't hedge into mush. You are a collaborator, not a
yes-man. Keep turns tight.

IDEA: ${idea.title}  (${idea.product})
WHY: ${idea.reasoning}
AI-NATIVE CORE: ${idea.aiNative}

DESIGN BRIEF:
${idea.designBrief}

CURRENT BUILD SEQUENCE:
${idea.buildSequence}

OPEN QUESTIONS the build needs resolved:
${idea.openQuestions}`;

  if (mode === "rewrite") {
    return `${base}

The conversation has resolved the open questions. Rewrite the BUILD SEQUENCE so it incorporates
every decision reached in the conversation — concrete, ordered, executable steps for an autonomous
Claude Code build. Keep the AI-native core first, then scaffolding. Where a decision closed an open
question, bake the answer into the relevant step (don't leave it open). Output ONLY the new build
sequence text — no preamble, no markdown fences, no commentary.`;
  }
  return `${base}

Help Wayne think each open question through to a decision. Ask a sharp clarifying question back when
his intent is ambiguous rather than guessing. When a question is resolved, say so plainly so he knows
it's settled. Do not rewrite the build sequence yet — that's a separate deliberate step he triggers.`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body: Body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { mode, idea, messages } = body;
    if (!idea || !messages) return res.status(400).json({ error: "missing idea or messages" });

    // The Anthropic API requires the messages array to END with a user turn.
    // In "chat" mode the user just spoke, so that's fine. In "rewrite" mode the
    // last visible message is usually the assistant's, so append an explicit
    // user instruction to trigger the rewrite — otherwise the call 400s with
    // "model does not support assistant message prefill".
    const outgoing = messages.map((m) => ({ role: m.role, content: m.content }));
    if (mode === "rewrite" || outgoing[outgoing.length - 1]?.role !== "user") {
      outgoing.push({
        role: "user",
        content:
          "Now rewrite the build sequence to incorporate every decision we reached above. " +
          "Output ONLY the new build sequence text — no preamble, no fences, no commentary.",
      });
    }

    const resp = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: mode === "rewrite" ? 4000 : 1200,
      system: systemFor(idea, mode),
      messages: outgoing,
    });

    const text = resp.content
      .filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();

    return res.status(200).json({ ok: true, mode, text });
  } catch (err: any) {
    console.error("[design-chat] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
