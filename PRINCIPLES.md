# PRINCIPLES.md — NewWay Foundry (pipeline)

Judgment doctrine for the Foundry itself — the board, resolve, the watcher,
the endpoints, and the workflows. The target products carry their own
PRINCIPLES.md (e.g. vetting-platform-api's); this file governs how the
FACTORY decides, not what the products it builds decide.

Per-project convention holds: absence of this file in a repo simply means no
doctrine applies there. Shape facts (endpoints, columns, stage names) belong
in code comments and the schema doc, not here.

---

## F1 — The sheet is the state store; edits are legitimate, history is not

The Queue sheet is the single source of pipeline truth. A deliberate manual
cell edit (parking an idea, reverting a misclicked stage) is a first-class
operation, not a hack. But log columns are append-only in spirit: correct
forward with a dated correction line — never rewrite or delete an erroneous
Review Log entry. The record of the mistake is part of the record.

## F2 — Never write a sheet cell value starting with =, +, -, or @

Google Sheets parses it as a formula and the cell (and everything reading it
via the API) becomes #ERROR!. Delimiters and generated text use # or plain
words. This bit the Revise Build preamble once; never again.

## F3 — Promote certifies the branch, not the card

The staging → main merge ships everything on staging. Promotion is therefore
a RELEASE: every Ready-to-Promote card ships together and is marked Live
together with a shared release line; anything on staging that is unverified
(Building/Testing) is named in the manifest as a passenger — verify or hold.
Never model promotion as a per-card act; never promote until everything
currently on staging is tested.

## F4 — The primary operation never fails for a secondary one

A promote that shipped production succeeds even if the staging back-sync
fails; a build that committed succeeds even if a report write hiccups.
Secondary failures surface loudly (a `warning` in the response, a log line
with the manual remedy) — they never mask or abort the primary result, and
they never fail silently.

## F5 — Fail soft, log loud

Every failure path logs (console.error with the upstream status/detail)
BEFORE returning its graceful fallback. A graceful failure without a log
line is undiagnosable — the CONTEXT.md 404 degraded every conversation for
days precisely because getFile failed soft and silent. Degraded beats dead;
logged beats both.

## F6 — Verdicts are human, synchronous, and confirmed against the idea

Stage-changing decisions are made by a person and take effect the moment
they're made (/api/decide) — the watcher fires builds; it never routes human
verdicts. Every consequential verdict confirms through a dialog that echoes
the idea ID + title (the wrong-idea guard); revise verdicts collect their
required feedback IN the dialog — no feedback box parked on a page next to a
forward button. A redo without direction is banned: Revise always requires
feedback.

## F7 — Button grammar: color = consequence, position = direction

- GREEN ships to production. Green appears on exactly one action in the
  whole Foundry: Promote.
- BLUE moves a card forward within the pipeline (Approve, Advance, Add).
- ORANGE spends money / fires an agent (Build now, Run watcher, Run design,
  Send in a model-backed chat).
- GHOST/outline is corrective, backward, or neutral (Revise, Hold, Decline,
  Cancel). RED confirms terminal actions (Decline).
- In any action row, rightmost = forward; corrective sits left of it;
  Cancel leftmost. Verdicts act on the idea, so they live in the header
  beside its ID and title; card quick-actions live in the card footer;
  dialog actions live bottom-right of the dialog.

## F8 — Confirmation weight matches consequence

Three tiers. T1 instant: reversible, free (Hold, opening a chat). T2 confirm
dialog echoing the idea: forward moves and agent fires (Advance, Approve,
Build now, Revise). T3 gated modal: production and irreversible aggregates
(Promote — diff link, per-migration checkboxes, release manifest, trainload
warning). Unsent text in an input adjacent to a forward action blocks the
action until acknowledged.

## F9 — One build per run; the human owns sequencing and the rebuild trigger

The watcher fires ONE build per run (Build Order asc, blanks last) — the
workflow's concurrency group drops stacked dispatches, and a one-person
pipeline should review builds as they land. Targeted fire (Build now)
bypasses order because a human pointing at a card IS the ordering. Failures
may auto-FILE findings, but a human clicks the rebuild: the revision budget
(MAX_REVISIONS) is never spent on the pipeline's own judgment.

## F10 — Claim before fire

Any dispatch-shaped action writes its claim to the sheet BEFORE calling
GitHub (Stage=Building, then dispatch), shrinking the double-fire race to
sub-second. A crash between claim and dispatch leaves a visible stuck row —
the correct trade against a silent overwrite. Loud stuck beats quiet wrong.

## F11 — Revise Build is for drift, not growth

Testing findings route back to a rebuild only when the spec already required
the behavior and the build diverged. Findings that add capability — however
small or discovered-in-testing — become new ideas through intake and the
scope check. The rebuild preamble asserts the original scope locks; feeding
it new scope hands the agent a contradiction. The design brief is never
regenerated by Revise Build: the spec was right; the implementation drifted.

## F12 — Specs instruct inspection, not memory

Build sequences tell the agent to READ the current code and extract exact
literals (comparisons, selectors, status strings) at build time — never to
trust design-time snapshots of a moving branch. Corollary from the false-
green tiles: "match X's behavior" must state the CONDITION X's behavior
hangs on, because the reference example may never exhibit the other branch
(FMCSA is never pending by the time anyone looks).

## F13 — Doctrine lives in the target repo; machinery degrades without it

CONTEXT.md, PRINCIPLES.md, DECISIONS.md travel with each product's code and
are fetched live. Pipeline machinery that consumes them must behave exactly
as before when they're absent — pointing the Foundry at a new project never
breaks anything; dropping doctrine files into that repo is what makes it
smarter. Nothing project-specific lands in the pipeline repo.

## F14 — Links and labels tell the truth

Never ship a URL parameter the target page doesn't read, a CTA label that
implies behavior the platform doesn't perform, or a UI state that contradicts
the data ("done" styling on an unrun check). Match reality; label truthfully;
in demo contexts prefer an explanatory non-navigating affordance over a link
that can't land.

## F15 — Endpoints that spend money are never fully open

Any endpoint that incurs model or paid-API cost per request carries
in-endpoint protection even when credential-free by design: per-IP rate
limiting, a hard payload cap, and hard caps on inputs that size the paid
operation. (The pipeline's own F-side twin of the platform's P17.)

---

## Maintaining this file

- Promote a decision here when it's reusable across features; keep entries
  short, declarative, and testable against a concrete question.
- The UI grammar (F7/F8) is binding on every new board/resolve surface —
  a new control picks its color and position from the grammar, or the
  grammar gets amended deliberately, never ignored.
