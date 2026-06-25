import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';

// Read-only. Lists every row in the Pipeline Queue for the Kanban board.
// Reads the header row and maps by column NAME, so it survives column drift
// (27 vs 28 cols) and any future reordering. No writes, no Anthropic calls.
export const maxDuration = 30;

const TAB = 'Queue';
const RANGE = `${TAB}!A1:AB100000`;

// Normalize a header cell to a stable key.
const norm = (s: string) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Header name (normalized) -> the field name the board expects.
const FIELD_MAP: Record<string, string> = {
  idea_id: 'id',
  title: 'title',
  stage: 'stage',
  source: 'source',
  product: 'product',
  priority_score: 'priority',
  priority_rationale: 'priorityRationale',
  reasoning: 'reasoning',
  open_questions: 'openQuestions',
  build_sequence: 'buildSequence',
  review: 'review',
  review_feedback: 'reviewFeedback',
  revisions: 'revisions',
  build_status: 'buildStatus',
  test_results: 'testResults',
  preview_url: 'previewUrl',
  prod_url: 'prodUrl',
  pr_commit: 'prCommit',
  blocked_reason: 'blockedReason',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Optional soft gate: if BOARD_KEY is set in Vercel, require ?key= to match.
  // If BOARD_KEY is unset, the route is open (matches current resolve.html).
  const gate = process.env.BOARD_KEY;
  if (gate && req.query.key !== gate) {
    res.status(401).json({ ok: false, error: 'Unauthorized. Append ?key=… to the URL.' });
    return;
  }

  try {
    const credsRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const sheetId = process.env.SHEET_ID;
    if (!credsRaw || !sheetId) {
      res.status(500).json({ ok: false, error: 'Missing GOOGLE_SERVICE_ACCOUNT_KEY or SHEET_ID.' });
      return;
    }

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(credsRaw),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: RANGE });
    const rows = resp.data.values || [];
    if (rows.length === 0) {
      res.status(200).json({ ok: true, ideas: [], updatedAt: new Date().toISOString() });
      return;
    }

    // Build column index -> field name from the header row.
    const header = rows[0].map((h) => FIELD_MAP[norm(h)] || null);

    const ideas: Record<string, string>[] = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const obj: Record<string, string> = {};
      let hasId = false;
      for (let c = 0; c < header.length; c++) {
        const field = header[c];
        if (!field) continue;
        const val = (row[c] ?? '').toString().trim();
        obj[field] = val;
        if (field === 'id' && val) hasId = true;
      }
      // Skip fully blank rows; an idea must at least have an ID.
      if (hasId) {
        // Report only whether a Build Sequence exists — don't ship the full text.
        obj.hasBuildSequence = obj.buildSequence ? '1' : '';
        delete obj.buildSequence;
        ideas.push(obj);
      }
    }

    res.status(200).json({ ok: true, ideas, updatedAt: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed to read the queue.' });
  }
}
