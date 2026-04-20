// 사용자 피드백 수집 엔드포인트 (Vercel Serverless Function)
// Vercel KV가 설정되어 있으면 KV에 저장, 없으면 /tmp 에 JSON 파일로 append
import fs from 'node:fs';
import path from 'node:path';
import { readJson, send } from './_lib.js';

export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };

// Vercel의 서버리스 환경에서는 /tmp만 쓰기 가능. 로컬은 process.cwd()
const FEEDBACK_FILE = process.env.VERCEL
  ? path.join('/tmp', 'feedback.log.json')
  : path.join(process.cwd(), 'feedback.log.json');

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  let payload;
  try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid json' }); }

  const rating = Number(payload.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return send(res, 400, { error: 'rating(1~5) 필요' });
  }
  const entry = {
    at: new Date().toISOString(),
    rating,
    comment: typeof payload.comment === 'string' ? payload.comment.slice(0, 2000) : '',
    state: payload.state && typeof payload.state === 'object' ? payload.state : null,
    ua: req.headers['user-agent'] || ''
  };

  // 1) Vercel KV가 있으면 KV 사용
  const kvUrl = process.env.KV_REST_API_URL;
  const kvTok = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvTok) {
    try {
      const key = `feedback:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const r = await fetch(`${kvUrl}/set/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${kvTok}`, 'content-type': 'application/json' },
        body: JSON.stringify(entry)
      });
      if (r.ok) return send(res, 200, { ok: true, storage: 'kv' });
    } catch (e) {
      // fallthrough to file
    }
  }

  // 2) 파일 append (로컬 또는 /tmp)
  try {
    let arr = [];
    try {
      const txt = fs.readFileSync(FEEDBACK_FILE, 'utf8');
      arr = JSON.parse(txt);
      if (!Array.isArray(arr)) arr = [];
    } catch {}
    arr.push(entry);
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(arr, null, 2));
    return send(res, 200, { ok: true, storage: 'file' });
  } catch (err) {
    return send(res, 500, { ok: false, error: String(err) });
  }
}
