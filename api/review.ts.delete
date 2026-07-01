import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';

// Sets the human Review decision on one idea — exactly what the sheet dropdown does.
// It writes Review (+ optional Review Feedback, + Decided At) and nothing else.
// It does NOT fire the watcher, write Review Log, or bump Revisions — those stay the
// watcher's job. The watcher picks up the new Review on its next run (cron 13:45 UTC)
// or when you invoke /api/watcher manually.
export const maxDuration = 30;

const TAB = 'Queue';
const ALLOWED = ['Pending', 'Approved', 'Declined', 'Revise Design', 'Revise Research', 'Hold'];

const norm = (s: string) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// 0-based column index -> A1 letter (0->A, 14->O, 26->AA, 27->AB).
function colLetter(i: number): string {
  let s = '';
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST.' });
    return;
  }

  // This endpoint can pass the build gate, so it is ALWAYS gated and fails closed.
  const gate = process.env.BOARD_KEY;
  if (!gate) {
    res.status(403).json({ ok: false, error: 'Review actions are locked. Set BOARD_KEY in Vercel to enable them.' });
    return;
  }
  if (req.query.key !== gate) {
    res.status(401).json({ ok: false, error: 'Unauthorized.' });
    return;
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const id = String(body.id || '').trim();
  const review = String(body.review || '').trim();
  const feedback = body.feedback != null ? String(body.feedback) : '';
  if (!id) { res.status(400).json({ ok: false, error: 'Missing idea id.' }); return; }
  if (ALLOWED.indexOf(review) < 0) { res.status(400).json({ ok: false, error: `Invalid review value "${review}".` }); return; }

  try {
    const credsRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const sheetId = process.env.SHEET_ID;
    if (!credsRaw || !sheetId) {
      res.status(500).json({ ok: false, error: 'Missing GOOGLE_SERVICE_ACCOUNT_KEY or SHEET_ID.' });
      return;
    }

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(credsRaw),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // Resolve column positions by header name (drift-proof).
    const head = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!A1:AB1` });
    const headers = (head.data.values && head.data.values[0]) || [];
    const idx: Record<string, number> = {};
    headers.forEach((h: any, i: number) => { idx[norm(h)] = i; });

    const cReview = idx['review'];
    const cFeedback = idx['review_feedback'];
    const cDecided = idx['decided_at'];
    const cId = idx['idea_id'] ?? 0;
    if (cReview == null) {
      res.status(500).json({ ok: false, error: 'No "Review" column found in the sheet.' });
      return;
    }

    // Find the idea's row by ID.
    const idLetter = colLetter(cId);
    const col = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!${idLetter}2:${idLetter}100000` });
    const ids = (col.data.values || []).map((r) => (r[0] ?? '').toString().trim());
    const found = ids.findIndex((v) => v === id);
    if (found < 0) { res.status(404).json({ ok: false, error: `Idea ${id} not found.` }); return; }
    const rowNum = found + 2;

    const data: { range: string; values: string[][] }[] = [
      { range: `${TAB}!${colLetter(cReview)}${rowNum}`, values: [[review]] },
    ];
    if (cFeedback != null && feedback) data.push({ range: `${TAB}!${colLetter(cFeedback)}${rowNum}`, values: [[feedback]] });
    if (cDecided != null) data.push({ range: `${TAB}!${colLetter(cDecided)}${rowNum}`, values: [[new Date().toISOString()]] });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: 'RAW', data },
    });

    res.status(200).json({ ok: true, id, review });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed to write the decision.' });
  }
}
