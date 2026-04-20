/**
 * 경량 RAG 모듈 — BM25 유사 TF-IDF 기반 키워드 검색
 * 임베딩 API 호출 없이 서버리스에서 즉시 동작
 *
 * 1. knowledge/ 하위 모든 .md 파일(`_`로 시작하는 내부 파일은 제외)을 읽음
 * 2. `## 섹션` 단위로 분할하여 청크 생성 (하위 ###도 같은 덩어리에 포함)
 * 3. 각 청크에 `file`(knowledge/xxx/xxx.md), `area`(카테고리), `heading`(섹션명) 태그
 * 4. searchKnowledge(query, topK=3): BM25 스타일 키워드 유사도 정렬
 * 5. export: searchKnowledge, loadAllChunks, ragSearch(레거시 호환)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');

// BM25 파라미터
const BM25_K1 = 1.5;
const BM25_B = 0.75;

let _index = null;

// --- 토큰화: 한글 n-gram(2글자) + 영숫자 단어 ---
function tokenize(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/[^\uAC00-\uD7AF\u3130-\u318Fa-z0-9\s]/g, ' ');
  const out = [];
  const words = cleaned.split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (/[a-z0-9]/.test(w) && w.length >= 2) {
      out.push(w);
    }
    // 한글은 2-gram으로 쪼개기 (짧은 조사 제거 효과 + 부분 매칭)
    if (/[\uAC00-\uD7AF]/.test(w)) {
      if (w.length === 1) {
        // 단일 한글은 버림
      } else {
        for (let i = 0; i <= w.length - 2; i++) {
          const bi = w.slice(i, i + 2);
          if (/[\uAC00-\uD7AF]{2}/.test(bi)) out.push(bi);
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
    // area: 상위 디렉토리 (surgery/eye.md -> surgery), 파일명 기준 key
    const parts = rel.split('/');
    const category = parts[0];
    const fileKey = path.basename(f, '.md');
    const content = fs.readFileSync(f, 'utf8');

    // ## 기준으로 분할. 첫 청크는 파일 상단 소개.
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

      chunks.push({
        file: rel,
        category,
        areaKey: fileKey,
        heading,
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

function bm25Score(chunk, qTokens, idf, avgdl) {
  let score = 0;
  for (const q of qTokens) {
    const tf = chunk.tf[q];
    if (!tf) continue;
    const idfV = idf[q] || 0;
    const dl = chunk.tokenCount;
    const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl));
    score += idfV * ((tf * (BM25_K1 + 1)) / denom);
  }
  return score;
}

/**
 * 사용자 쿼리로 관련 지식 청크 검색
 * @param {string} query
 * @param {number} topK
 * @param {object} opts - { areaKey, category, minScore }
 * @returns {Array<{file,areaKey,category,heading,text,score}>}
 */
export function searchKnowledge(query, topK = 3, opts = {}) {
  const { areaKey = null, category = null, minScore = 0.1 } = opts;
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

  const scored = pool.map((c) => ({
    file: c.file,
    areaKey: c.areaKey,
    category: c.category,
    heading: c.heading,
    text: c.text,
    score: bm25Score(c, uniqQ, _index.idf, _index.avgdl)
  }));

  return scored
    .filter((s) => s.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 검색 결과를 프롬프트 주입용 텍스트로 합침
 * @param {string} query
 * @param {object} opts - { topK, areaKey, category, minScore, maxChars }
 * @returns {string}
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

// --- 레거시 ragSearch 호환 (기존 호출부가 있을 수 있음) ---
export async function ragSearch(query, apiKey = null, opts = {}) {
  const { topK = 5, areaKey = null, minScore = 0.1 } = opts;
  return searchKnowledgeText(query, { topK, areaKey, minScore });
}
