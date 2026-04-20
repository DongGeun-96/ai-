import { send } from './_lib.js';

const CACHE = new Map();
const TTL = 60 * 60 * 1000;

export default async function handler(req, res) {
  const u = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const q = (u.searchParams.get('q') || '').trim();
  const limit = Math.min(Number(u.searchParams.get('limit') || 5), 10);
  if (!q) return send(res, 400, { error: 'q 필수' });

  const key = `shorts|${q}|${limit}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) return send(res, 200, { items: hit.items, cached: true });

  try {
    const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' shorts')}&hl=ko&gl=KR`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'accept-language': 'ko-KR,ko;q=0.9,en;q=0.7'
      }
    });
    const html = await r.text();
    const items = extractShorts(html, limit);
    CACHE.set(key, { at: Date.now(), items });
    return send(res, 200, { items });
  } catch (err) {
    return send(res, 502, { error: String(err) });
  }
}

function extractShorts(html, limit) {
  const seen = new Set();
  const out = [];

  // 1순위: shortsLockupViewModel (2024+ YouTube 구조)
  const slvmRe = /"shortsLockupViewModel":\{"entityId":"shorts-shelf-item-([A-Za-z0-9_-]{11})","accessibilityText":"([^"]+)"/g;
  let m;
  while ((m = slvmRe.exec(html)) && out.length < limit) {
    const [, id, accText] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    // accessibilityText: "제목, 조회수 N만회 - Shorts 동영상 재생"
    const title = accText.split(',')[0].trim();
    out.push({ id, title: decodeHtml(title), type: 'short' });
  }

  // 2순위: reelItemRenderer (이전 구조)
  if (out.length < limit) {
    const reelRe = /"reelItemRenderer":\s*\{"videoId":"([A-Za-z0-9_-]{11})"[^]*?"text":"([^"]*?)"/g;
    while ((m = reelRe.exec(html)) && out.length < limit) {
      const [, id, title] = m;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: decodeHtml(title), type: 'short' });
    }
  }

  // 3순위: /shorts/ URL에서 videoId 추출
  if (out.length < limit) {
    const urlRe = /"url":"\/shorts\/([A-Za-z0-9_-]{11})"/g;
    while ((m = urlRe.exec(html)) && out.length < limit) {
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: '', type: 'short' });
    }
  }

  return out;
}

function decodeHtml(s) {
  return String(s || '').replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
