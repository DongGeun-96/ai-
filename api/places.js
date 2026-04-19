import { send, stripTags } from './_lib.js';

const CACHE = new Map();
const TTL = 30 * 60 * 1000;

export default async function handler(req, res) {
  const u = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const region = (u.searchParams.get('region') || '').trim();
  const area = (u.searchParams.get('area') || '성형외과').trim();
  const limit = Math.min(Number(u.searchParams.get('limit') || 8), 12);
  if (!region) return send(res, 400, { error: 'region 필수' });
  const key = region + '|' + area + '|' + limit;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) return send(res, 200, { items: hit.items, cached: true });

  const NID = process.env.NAVER_CLIENT_ID;
  const NSEC = process.env.NAVER_CLIENT_SECRET;
  try {
    if (NID && NSEC) {
      const q = `${region} ${area}`;
      const r = await fetch(`https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(q)}&display=${limit}&sort=random`, {
        headers: { 'X-Naver-Client-Id': NID, 'X-Naver-Client-Secret': NSEC }
      });
      if (r.ok) {
        const j = await r.json();
        const items = (j.items || []).map((p) => ({
          name: stripTags(p.title),
          address: p.roadAddress || p.address || '',
          tel: p.telephone || '',
          category: p.category || '',
          link: p.link || ''
        })).filter((p) => p.name);
        CACHE.set(key, { at: Date.now(), items });
        return send(res, 200, { items, source: 'naver_openapi' });
      }
    }
    // 폴백: 공개 검색 페이지 HTML 파싱 (이름만)
    const q2 = `${region} ${area}`;
    const r2 = await fetch(`https://search.naver.com/search.naver?query=${encodeURIComponent(q2)}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'accept-language': 'ko-KR,ko;q=0.9'
      }
    });
    const html = await r2.text();
    const re = /"name":"([^"]{1,60}(?:성형|성형외과)[^"]{0,25})"/g;
    const seen = new Set();
    const items = [];
    let m;
    while ((m = re.exec(html)) && items.length < limit) {
      const name = m[1].trim();
      if (seen.has(name)) continue;
      seen.add(name);
      items.push({ name, address: '', tel: '', category: '성형외과', link: `https://search.naver.com/search.naver?query=${encodeURIComponent(name)}` });
    }
    CACHE.set(key, { at: Date.now(), items });
    return send(res, 200, { items, source: 'naver_search_html' });
  } catch (err) {
    return send(res, 502, { error: String(err) });
  }
}
