// ============================================================
// _rag.js — 고도화 v2
// ============================================================
// 주요 개선점:
// 1. 한글 n-gram 크기 확장 (2-gram + 3-gram)
// 2. 도메인 키워드 부스팅 (수술명 가중치)
// 3. 섹션 제목 매칭 보너스
// 4. 청크 중복 제거
// 5. minScore 동적 조정
// 6. 검색 결과 디버깅 정보 제공
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');

// BM25 파라미터
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// 도메인 키워드 (수술/시술명) — 매칭 시 점수 부스팅
const DOMAIN_KEYWORDS = new Set([
  // 눈
  '쌍꺼풀', '매몰', '절개', '눈매교정', '안검하수', '앞트임', '뒤트임', '밑트임',
  '상안검', '하안검', '눈밑', '이마거상',
  // 코
  '코성형', '콧대', '코끝', '복코', '매부리', '콧볼', '비중격', '비주',
  // 윤곽
  '윤곽', '광대', '사각턱', '앞턱', '턱끝', '이마',
  // 가슴
  '가슴', '확대', '거상', '유두', '보형물',
  // 지방
  '지방흡입', '지방이식', '복부',
  // 피부
  '써마지', '울쎄라', '리쥬란', '쥬베룩', '보톡스', '필러', '스킨부스터',
  // 모발
  '모발이식', '탈모',
  // 일반
  '재수술', '부작용', '회복', '흉터', '붓기', '멍', '마취'
]);

let _index = null;

// --- 토큰화: 한글 2-gram + 3-gram + 영숫자 + 도메인 키워드 ---
function tokenize(text, opts = {}) {
  const { includeDomain = true } = opts;
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^\uAC00-\uD7AF\u3130-\u318Fa-z0-9\s]/g, ' ');

  const out = [];
  const words = cleaned.split(/\s+/).filter(Boolean);

  for (const w of words) {
    // 영숫자 단어
    if (/[a-z0-9]/.test(w) && w.length >= 2) {
      out.push(w);
    }

    // 한글 n-gram
    if (/[\uAC00-\uD7AF]/.test(w)) {
      if (w.length < 2) continue;

      // 도메인 키워드 전체 매칭 (가중치용)
      if (includeDomain && DOMAIN_KEYWORDS.has(w)) {
        out.push(`__DOMAIN__${w}`);
      }

      // 2-gram
      for (let i = 0; i <= w.length - 2; i++) {
        const bi = w.slice(i, i + 2);
        if (/^[\uAC00-\uD7AF]{2}$/.test(bi)) out.push(bi);
      }

      // 3-gram (더 정확한 매칭)
      if (w.length >= 3) {
        for (let i = 0; i <= w.length - 3; i++) {
          const tri = w.slice(i, i + 3);
          if (/^[\uAC00-\uD7AF]{3}$/.test(tri)) out.push(`__TRI__${tri}`);
        }
      }
    }
  }
  return out;
}

// --- 디렉토리 재귀 수집 ---
function collectMdFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...collectMdFiles(p));
    } else if (ent.isFile() && ent.name.endsWith('.md') && !ent.name.startsWith('_')) {
      out.push(p);
    }
  }
  return out;
}

// --- 청크 빌드 ---
export function loadAllChunks() {
  if (_index) return _index.chunks;

  const files = collectMdFiles(KNOWLEDGE_DIR);
  const chunks = [];

  for (const f of files) {
    const rel = path.relative(KNOWLEDGE_DIR, f).replace(/\\/g, '/');
    const parts = rel.split('/');
    const category = parts[0];
    const fileKey = path.basename(f, '.md');
    const content = fs.readFileSync(f, 'utf8');

    // ## 기준으로 분할
    const sections = content.split(/\n(?=##\s)/);
    for (const sec of sections) {
      const text = sec.trim();
      if (text.length < 30) continue;

      const headingMatch = text.match(/^#{1,6}\s+(.+)/);
      const heading = headingMatch ? headingMatch[1].trim() : '';

      const tokens = tokenize(text);
      if (!tokens.length) continue;

      const tf = {};
      for (const t of tokens) tf[t] = (tf[t] || 0) + 1;

      // 섹션 제목 별도 토큰화 (가중치용)
      const headingTokens = heading ? new Set(tokenize(heading)) : new Set();

      chunks.push({
        file: rel,
        category,
        areaKey: fileKey,
        heading,
        headingTokens,
        text,
        tokens,
        tokenCount: tokens.length,
        tf
      });
    }
  }

  // IDF 계산
  const N = chunks.length;
  const df = {};
  for (const c of chunks) {
    const seen = new Set(c.tokens);
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }
  const idf = {};
  for (const [t, d] of Object.entries(df)) {
    idf[t] = Math.log((N - d + 0.5) / (d + 0.5) + 1);
  }
  const avgdl = chunks.reduce((s, c) => s + c.tokenCount, 0) / Math.max(1, N);

  _index = { chunks, idf, avgdl, N };
  return chunks;
}

/**
 * 점수 계산 (BM25 + 도메인 부스팅 + 제목 매칭 보너스)
 */
function scoreChunk(chunk, qTokens, idf, avgdl) {
  let bm25 = 0;
  let domainBoost = 0;
  let headingBonus = 0;

  for (const q of qTokens) {
    const tf = chunk.tf[q];
    if (!tf) continue;
    const idfV = idf[q] || 0;
    const dl = chunk.tokenCount;
    const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl));
    const baseScore = idfV * ((tf * (BM25_K1 + 1)) / denom);
    bm25 += baseScore;

    // 도메인 키워드 매칭 시 추가 가중치
    if (q.startsWith('__DOMAIN__')) {
      domainBoost += baseScore * 2.0;  // 2배 가중치
    }

    // 3-gram 매칭 시 추가 가중치 (더 정확한 매칭)
    if (q.startsWith('__TRI__')) {
      domainBoost += baseScore * 0.5;
    }

    // 섹션 제목에 포함되면 보너스
    if (chunk.headingTokens && chunk.headingTokens.has(q)) {
      headingBonus += idfV * 1.5;
    }
  }

  return bm25 + domainBoost + headingBonus;
}

/**
 * 사용자 쿼리로 관련 지식 청크 검색 (고도화)
 */
export function searchKnowledge(query, topK = 3, opts = {}) {
  const { areaKey = null, category = null, minScore = 0.15 } = opts;
  loadAllChunks();
  if (!_index || !_index.chunks.length) return [];

  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const uniqQ = Array.from(new Set(qTokens));

  const pool = _index.chunks.filter((c) => {
    if (areaKey && c.areaKey !== areaKey) return false;
    if (category && c.category !== category) return false;
    return true;
  });

  // areaKey 필터 후 결과가 너무 적으면 전체로 재검색
  const effectivePool = (areaKey && pool.length < 2)
    ? _index.chunks
    : pool;

  const scored = effectivePool.map((c) => ({
    file: c.file,
    areaKey: c.areaKey,
    category: c.category,
    heading: c.heading,
    text: c.text,
    score: scoreChunk(c, uniqQ, _index.idf, _index.avgdl)
  }));

  const filtered = scored
    .filter((s) => s.score > minScore)
    .sort((a, b) => b.score - a.score);

  // 중복 heading 제거 (같은 섹션이 여러 번 나오는 경우 방지)
  const seen = new Set();
  const deduped = [];
  for (const s of filtered) {
    const key = `${s.file}::${s.heading}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
    if (deduped.length >= topK) break;
  }

  return deduped;
}

/**
 * 검색 결과를 프롬프트 주입용 텍스트로 합침
 */
export function searchKnowledgeText(query, opts = {}) {
  const { topK = 3, maxChars = 4000, ...rest } = opts;
  const hits = searchKnowledge(query, topK, rest);
  if (!hits.length) return '';

  const blocks = hits.map(
    (h) => `[${h.areaKey} · ${h.heading || h.file}]\n${h.text}`
  );

  let joined = blocks.join('\n\n---\n\n');
  if (joined.length > maxChars) joined = joined.slice(0, maxChars) + '\n…';

  return joined;
}

/**
 * 디버깅용 — 쿼리와 매칭된 청크 상세 정보 반환
 */
export function searchKnowledgeDebug(query, opts = {}) {
  const hits = searchKnowledge(query, opts.topK || 5, opts);
  return hits.map(h => ({
    area: h.areaKey,
    heading: h.heading,
    score: Number(h.score.toFixed(3)),
    preview: h.text.slice(0, 100) + '...'
  }));
}

// --- 레거시 호환 ---
export async function ragSearch(query, apiKey = null, opts = {}) {
  const { topK = 5, areaKey = null, minScore = 0.15 } = opts;
  return searchKnowledgeText(query, { topK, areaKey, minScore });
}
