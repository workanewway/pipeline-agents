/**
 * api/design-chat.ts  ->  POST /api/design-chat
 * ---------------------------------------------------------------------------
 * Backs the working-view's conversation. Given an idea's brief + the running
 * thread, calls Claude so you can WALK THROUGH the open questions instead of
 * answering them blind in a spreadsheet cell. Stateless: the page sends the
 * whole thread each turn (same pattern as the Claude-in-artifacts examples).
 *
 * Two modes:
 *   mode "chat"    -> normal turn; Claude answers as a design collaborator. Can READ a file
 *                     from the build-target repo (staging) on demand to ground an
 *                     implementation question — see the read_file tool below.
 *                     ALSO accepts pasted screenshots: the page sends `images` (base64
 *                     dataURLs) that apply to the FINAL user message of this turn only —
 *                     history carries a text marker instead, so payloads stay small.
 *   mode "rewrite" -> Claude regenerates the Build Sequence incorporating the
 *                     whole conversation, returns ONLY the new sequence text.
 *                     (Deliberate, reviewable step — the spec never mutates
 *                     silently mid-chat. NO tools in this mode — the output is the
 *                     raw sequence text and a tool call would corrupt it. No images
 *                     either: any screenshot was discussed in a prior chat turn.)
 * ---------------------------------------------------------------------------
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, projectByName, getFile, isGithubRepo } from "../lib/pipeline-common.js";

export const maxDuration = 60;

const anthropic = new Anthropic();

interface Body {
  mode: "chat" | "rewrite";
  idea: {
    ideaId: string; title: string; product: string;
    reasoning: string; aiNative: string; openQuestions: string;
    designBrief: string; buildSequence: string;
    stage?: string;
    lockedScope?: { in?: string[]; out?: string[]; lockedAt?: string } | null;
  };
  messages: { role: "user" | "assistant"; content: string }[];
  images?: string[];   // base64 dataURLs pasted with THIS turn (frontend downscales first)
}

// ── pasted screenshots ───────────────────────────────────────────────────────
// The page sends images as dataURLs alongside the thread; they belong to the final
// user message of the current turn. Convert to Anthropic image blocks, validating
// type and bounding count/size — anything invalid is silently dropped (fail soft:
// the turn still goes through as text).
const ALLOWED_IMG = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGES_PER_TURN = 4;
const MAX_B64_LEN = 2_000_000; // ~1.5MB decoded per image — frontend downscales well below this

function imageBlocksFrom(images: unknown): any[] {
  if (!Array.isArray(images)) return [];
  const blocks: any[] = [];
  for (const src of images.slice(0, MAX_IMAGES_PER_TURN)) {
    if (typeof src !== "string") continue;
    const m = src.match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
    if (!m) continue;
    const media = m[1].toLowerCase();
    if (!ALLOWED_IMG.has(media) || m[2].length > MAX_B64_LEN) continue;
    blocks.push({ type: "image", source: { type: "base64", media_type: media, data: m[2] } });
  }
  return blocks;
}

// Attach this turn's image blocks to the LAST user message in the outgoing array,
// converting its string content into [image..., text] blocks. If no user turn exists
// (shouldn't happen from the page), append one so the images still land.
function attachImagesToLastUser(convo: any[], images: unknown): void {
  const blocks = imageBlocksFrom(images);
  if (!blocks.length) return;
  for (let i = convo.length - 1; i >= 0; i--) {
    if (convo[i]?.role === "user" && typeof convo[i].content === "string") {
      convo[i] = { role: "user", content: [...blocks, { type: "text", text: convo[i].content || "(see screenshot)" }] };
      return;
    }
  }
  convo.push({ role: "user", content: [...blocks, { type: "text", text: "(see screenshot)" }] });
}

// Design MAY read a file to ground an IMPLEMENTATION question — unlike scope, working out how
// something is built IS design's job. It reads the STAGING branch (the base the build will edit),
// on demand, when a design call hinges on what the current code actually does.
const READ_FILE_TOOL = {
  name: "read_file",
  description:
    "Read the current contents of a source file from the build-target repo (the `staging` branch " +
    "the autonomous build will edit). Use when resolving an open question hinges on what the code " +
    "ACTUALLY does today — e.g. does this handler gate on completion, where does this behavior live, " +
    "which file owns this logic, what shape is this function. Grounds a design decision in reality " +
    "instead of guessing (the apply.ts-vs-lock.ts trap). Paths are repo-relative — NOTE: pages " +
    "live under public/ (e.g. \"public/workspace.html\", \"public/connect.html\") and vetting " +
    "endpoints under the bracket folder (e.g. \"api/vettings/[id]/assess.ts\", " +
    "\"api/vettings/[id]/tms.ts\"); library code is e.g. \"lib/tms.ts\".",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "repo-relative file path" } },
    required: ["path"],
  },
};

function systemFor(idea: Body["idea"], mode: Body["mode"]): string {
  // Locked scope, rendered when present — the machine-locked in/out boundary the scope
  // check recorded before design. The chat treats OUT bullets as binding.
  const ls = idea.lockedScope;
  const scopeBlock = ls && ((ls.in && ls.in.length) || (ls.out && ls.out.length))
    ? `\nLOCKED SCOPE (binding — set at the scope check, machine-diffed later):\n` +
      (ls.in && ls.in.length ? `IN:\n${ls.in.map((b) => `  - ${b}`).join("\n")}\n` : "") +
      (ls.out && ls.out.length ? `OUT:\n${ls.out.map((b) => `  - ${b}`).join("\n")}\n` : "")
    : "";

  // Testing-stage guard: once a build is committed and being verified, the spec's job is
  // done — chat edits at this stage are for implementation DRIFT only. New capability goes
  // through intake as its own idea, where it gets a scope check and a design pass.
  const stage = (idea.stage || "").trim();
  const inTesting = ["Testing", "Building", "Preview Deployed", "Ready to Promote"].indexOf(stage) >= 0;
  const testingGuard = inTesting
    ? `\nTESTING-STAGE GUARD (this idea is at "${stage}" — a build of this spec is already
committed on staging): classify every change the user raises before agreeing to fold it in.
- DRIFT FIX: the spec ALREADY requires it and the build diverged (wrong element, missed
  counter, broken state). Fold these into the spec amendment / Revise Build findings.
- NEW SCOPE: it adds capability, surface, data, or behavior the spec and locked scope never
  included — even if small, useful, and discovered during testing. PUSH BACK on these
  plainly: name it as new scope, do NOT fold it into the spec rewrite, and tell the user to
  route it through intake ("+ New idea" on the board) as its own idea so it gets a scope
  check and design pass. Offer to draft the intake text for them. Discovering something in
  testing does not make it part of this idea.
If a request mixes both, split it explicitly: fold the drift part, route the new-scope part.`
    : "";

  const base = `You are a senior product designer + tech lead helping Wayne resolve the open
questions on ONE idea before it goes to an autonomous build. Be direct, surface real tradeoffs,
push back when a choice has a downside, and don't hedge into mush. You are a collaborator, not a
yes-man. Keep turns tight.

When resolving a question depends on what the current code actually does — which file owns a
behavior, whether a handler already gates on something, the shape of an existing function — use the
read_file tool to CHECK rather than guess. Read from the staging branch (what the build will edit).
Name the file you read in your reply so the reasoning is visible. Don't over-read: one or two
targeted files to settle a specific question, not a tour of the repo.

The user may paste screenshots (e.g. of the staging preview) — read them carefully; what the
screenshot SHOWS is testing evidence and usually the point of the message.

IDEA: ${idea.title}  (${idea.product})
WHY: ${idea.reasoning}
AI-NATIVE CORE: ${idea.aiNative}
${scopeBlock}${testingGuard}
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
question, bake the answer into the relevant step (don't leave it open). EXCLUDE anything the
conversation identified as new scope / out of scope — those route to intake as separate ideas and
must not appear in this sequence. Output ONLY the new build sequence text — no preamble, no
markdown fences, no commentary.`;
  }
  return `${base}

Help Wayne think each open question through to a decision. Ask a sharp clarifying question back when
his intent is ambiguous rather than guessing. When a question is resolved, say so plainly so he knows
it's settled. Do not rewrite the build sequence yet — that's a separate deliberate step he triggers.`;
}

// Agentic chat with the read_file tool (SDK form). Bounded, fails soft. Returns the final text
// plus the list of files read, so the working view can show what was checked (legibility).
async function chatWithFiles(
  system: string,
  messages: { role: "user" | "assistant"; content: any }[],
  repo: string | undefined,
  branch: string,
): Promise<{ text: string; reads: string[] }> {
  const readable = !!repo && isGithubRepo(repo);
  const convo: any[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const reads: string[] = [];
  const MAX_TOOL_TURNS = 4;
  let lastText = "";

  for (let turn = 0; turn <= MAX_TOOL_TURNS; turn++) {
    const offerTools = readable && turn < MAX_TOOL_TURNS; // final pass forces a text answer
    const resp: any = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1200,
      system,
      messages: convo,
      ...(offerTools ? { tools: [READ_FILE_TOOL as any] } : {}),
    });

    lastText = (resp.content || [])
      .filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();

    if (resp.stop_reason !== "tool_use") return { text: lastText, reads };

    convo.push({ role: "assistant", content: resp.content });
    const results: any[] = [];
    for (const tu of (resp.content || []).filter((b: any) => b.type === "tool_use")) {
      let out = "(unsupported tool)";
      if (tu.name === "read_file") {
        const path = String(tu.input?.path || "");
        reads.push(path);
        out = readable ? await getFile(repo!, branch, path) : "(no readable repo for this idea)";
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
    }
    convo.push({ role: "user", content: results });
  }
  return { text: lastText, reads };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body: Body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { mode, idea, messages } = body;
    if (!idea || !messages) return res.status(400).json({ error: "missing idea or messages" });

    // ── rewrite mode: NO tools. Produces the raw build-sequence text; a tool call would corrupt it.
    if (mode === "rewrite") {
      const outgoing = messages.map((m) => ({ role: m.role, content: m.content }));
      // The Anthropic API requires the messages array to END with a user turn. The last visible
      // message in rewrite is usually the assistant's, so append an explicit user instruction.
      if (outgoing[outgoing.length - 1]?.role !== "user") {
        outgoing.push({
          role: "user",
          content:
            "Now rewrite the build sequence to incorporate every decision we reached above. " +
            "Output ONLY the new build sequence text — no preamble, no fences, no commentary.",
        });
      }
      const resp = await anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 4000,
        system: systemFor(idea, mode),
        messages: outgoing,
      });
      const text = resp.content
        .filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      return res.status(200).json({ ok: true, mode, text });
    }

    // ── chat mode: design collaborator, WITH the read_file tool against staging.
    // Pasted screenshots (body.images) attach to the final user message of this turn.
    const project = projectByName(idea.product);
    const outgoing: any[] = messages.map((m) => ({ role: m.role, content: m.content }));
    attachImagesToLastUser(outgoing, body.images);
    const { text, reads } = await chatWithFiles(
      systemFor(idea, "chat"),
      outgoing,
      project?.repo,
      "staging",
    );
    return res.status(200).json({ ok: true, mode: "chat", text, reads });
  } catch (err: any) {
    console.error("[design-chat] failed:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
