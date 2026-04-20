import { send } from './_lib.js';

const CACHE = new Map();
const TTL = 60 * 60 * 1000;

export default async function handler(req, res) {
  const u = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const q = (u.searchParams.get('q') || '').trim();
  const limit = Math.min(Number(u.searchParams.get('limit') || 4), 8);
  if (!q) return send(res, 400, { error: 'q 필수' });

  const key = `shorts|${q}|${limit}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) return send(res, 200, { items: hit.items, cached: true });

  try {
    // YouTube Shorts 검색 (shorts 필터)
    const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' #shorts')}&hl=ko&gl=KR`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
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

  // reelItemRenderer (Shorts 전용)
  const reelRe = /"reelItemRenderer":\s*\{"videoId":"([A-Za-z0-9_-]{11})"[^]*?"text":"([^"]*?)"/g;
  let m;
  while ((m = reelRe.exec(html)) && out.length < limit) {
    const [, id, title] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: decodeHtml(title), type: 'short' });
  }

  // fallback: shorts URL 패턴에서 videoId 추출
  if (out.length < limit) {
    const shortRe = /"videoId":"([A-Za-z0-9_-]{11})"[^]*?"title":\{"runs":\[\{"text":"([^"]+)"[^]*?"lengthText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+)"/g;
    while ((m = shortRe.exec(html)) && out.length < limit) {
      const [, id, title, duration] = m;
      if (seen.has(id)) continue;
      // Shorts는 보통 60초 이하
      const seconds = parseDuration(duration);
      if (seconds > 0 && seconds <= 60) {
        seen.add(id);
        out.push({ id, title: decodeHtml(title), type: 'short' });
      }
    }
  }

  // fallback 2: 일반 videoId 중 짧은 것
  if (out.length < limit) {
    const re2 = /"videoId":"([A-Za-z0-9_-]{11})"[^]*?"title":\{"runs":\[\{"text":"([^"]+)"/g;
    while ((m = re2.exec(html)) && out.length < limit) {
      const [, id, title] = m;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: decodeHtml(title), type: 'short' });
    }
  }

  return out;
}

function parseDuration(label) {
  // "1분", "45초", "1분 30초" 등
  const minMatch = label.match(/(\d+)\s*분/);
  const secMatch = label.match(/(\d+)\s*초/);
  let total = 0;
  if (minMatch) total += Number(minMatch[1]) * 60;
  if (secMatch) total += Number(secMatch[1]);
  return total;
}

function decodeHtml(s) {
  return String(s || '').replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
