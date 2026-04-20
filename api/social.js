import { send } from './_lib.js';

const CACHE = new Map();
const TTL = 60 * 60 * 1000;

export default async function handler(req, res) {
  const u = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const q = (u.searchParams.get('q') || '').trim();
  const limit = Math.min(Number(u.searchParams.get('limit') || 3), 6);
  if (!q) return send(res, 400, { error: 'q 필수' });

  const key = `social|${q}|${limit}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) return send(res, 200, { items: hit.items, cached: true });

  const apiKey = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!apiKey || !cx) return send(res, 200, { items: [], error: 'CSE 키 미설정' });

  try {
    // 인스타 + 틱톡 동시 검색
    const [instaRes, tiktokRes] = await Promise.all([
      fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(q + ' 후기')}&siteSearch=instagram.com&siteSearchFilter=i&num=${limit}&hl=ko`, { signal: AbortSignal.timeout(8000) }),
      fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(q + ' 후기')}&siteSearch=tiktok.com&siteSearchFilter=i&num=${limit}&hl=ko`, { signal: AbortSignal.timeout(8000) })
    ]);

    const instaData = instaRes.ok ? await instaRes.json() : { items: [] };
    const tiktokData = tiktokRes.ok ? await tiktokRes.json() : { items: [] };

    const items = [];
    const seen = new Set();

    const instas = (instaData.items || []).map(it => ({
      type: 'instagram',
      title: cleanTitle(it.title),
      desc: (it.snippet || '').slice(0, 80),
      url: it.link,
      thumbnail: it.pagemap?.cse_thumbnail?.[0]?.src || it.pagemap?.metatags?.[0]?.['og:image'] || ''
    }));

    const tiktoks = (tiktokData.items || []).map(it => ({
      type: 'tiktok',
      title: cleanTitle(it.title),
      desc: (it.snippet || '').slice(0, 80),
      url: it.link,
      thumbnail: it.pagemap?.cse_thumbnail?.[0]?.src || it.pagemap?.metatags?.[0]?.['og:image'] || ''
    }));

    // 번갈아 배치
    const maxLen = Math.max(instas.length, tiktoks.length);
    for (let i = 0; i < maxLen && items.length < limit; i++) {
      if (i < instas.length && !seen.has(instas[i].url)) {
        seen.add(instas[i].url);
        items.push(instas[i]);
      }
      if (i < tiktoks.length && items.length < limit && !seen.has(tiktoks[i].url)) {
        seen.add(tiktoks[i].url);
        items.push(tiktoks[i]);
      }
    }

    CACHE.set(key, { at: Date.now(), items });
    return send(res, 200, { items });
  } catch (err) {
    return send(res, 200, { items: [], error: String(err) });
  }
}

function cleanTitle(s) {
  return String(s || '').replace(/ - Instagram$/, '').replace(/ \| TikTok$/, '').replace(/on Instagram:.*/, '').trim();
}
