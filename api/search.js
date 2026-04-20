import { send } from './_lib.js';

const CACHE = new Map();
const TTL = 60 * 60 * 1000;

export default async function handler(req, res) {
  const u = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const q = (u.searchParams.get('q') || '').trim();
  const limit = Math.min(Number(u.searchParams.get('limit') || 4), 8);
  if (!q) return send(res, 400, { error: 'q 필수' });

  const key = `search|${q}|${limit}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) return send(res, 200, { items: hit.items, cached: true });

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return send(res, 500, { error: 'NAVER API 키 미설정' });

  try {
    // 네이버 블로그 + 카페 동시 검색
    const [blogRes, cafeRes] = await Promise.all([
      fetch(`https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(q)}&display=${limit}&sort=sim`, {
        headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
      }),
      fetch(`https://openapi.naver.com/v1/search/cafearticle.json?query=${encodeURIComponent(q)}&display=${limit}&sort=sim`, {
        headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
      })
    ]);

    const blogData = blogRes.ok ? await blogRes.json() : { items: [] };
    const cafeData = cafeRes.ok ? await cafeRes.json() : { items: [] };

    const items = [];
    const seen = new Set();

    // 블로그 + 카페 결과 합쳐서 번갈아 배치
    const blogs = (blogData.items || []).map(it => ({
      type: 'blog',
      title: stripHtml(it.title),
      desc: stripHtml(it.description).slice(0, 80),
      url: it.link,
      source: it.bloggername || '블로그'
    }));
    const cafes = (cafeData.items || []).map(it => ({
      type: 'cafe',
      title: stripHtml(it.title),
      desc: stripHtml(it.description).slice(0, 80),
      url: it.link,
      source: it.cafename || '카페'
    }));

    // 번갈아 넣기 (블로그 → 카페 → 블로그 → ...)
    const maxLen = Math.max(blogs.length, cafes.length);
    for (let i = 0; i < maxLen && items.length < limit; i++) {
      if (i < blogs.length && !seen.has(blogs[i].url)) {
        seen.add(blogs[i].url);
        items.push(blogs[i]);
      }
      if (i < cafes.length && items.length < limit && !seen.has(cafes[i].url)) {
        seen.add(cafes[i].url);
        items.push(cafes[i]);
      }
    }

    CACHE.set(key, { at: Date.now(), items });
    return send(res, 200, { items });
  } catch (err) {
    return send(res, 502, { error: String(err) });
  }
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
