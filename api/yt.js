import { send } from './_lib.js';

const CACHE = new Map();
const TTL = 60 * 60 * 1000;

export default async function handler(req, res) {
  const u = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const q = (u.searchParams.get('q') || '').trim();
  const limit = Math.min(Number(u.searchParams.get('limit') || 4), 8);
  if (!q) return send(res, 400, { error: 'q 필수' });
  const key = q + '|' + limit;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) return send(res, 200, { items: hit.items, cached: true });
  try {
    const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=ko&gl=KR`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.7'
      }
    });
    const html = await r.text();
    const items = extractYtItems(html, limit);
    CACHE.set(key, { at: Date.now(), items });
    return send(res, 200, { items });
  } catch (err) {
    return send(res, 502, { error: String(err) });
  }
}

function extractYtItems(html, limit) {
  const seen = new Set();
  const out = [];
  const re = /"videoRenderer":\s*\{"videoId":"([A-Za-z0-9_-]{11})"[^]*?"title":\{"runs":\[\{"text":"([^"]+)"[^]*?"ownerText":\{"runs":\[\{"text":"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const [, id, title, channel] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: decodeHtml(title), channel: decodeHtml(channel) });
  }
  if (out.length === 0) {
    const re2 = /"videoId":"([A-Za-z0-9_-]{11})"/g;
    let m2;
    while ((m2 = re2.exec(html)) && out.length < limit) {
      const id = m2[1];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: '', channel: '' });
    }
  }
  return out;
}

function decodeHtml(s) {
  return String(s || '').replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
