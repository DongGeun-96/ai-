/**
 * 경량 RAG 모듈 — TF-IDF 기반 키워드 검색
 * 임베딩 API 호출 없이 서버리스에서 즉시 동작
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge', 'surgery');

let _index = null;

// 한글 형태소 간이 처리 (조사 제거)
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\uAC00-\uD7AF\u3130-\u318Fa-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

// 청크 인덱스 빌드
function buildIndex() {
  if (_index) return _index;
  
  const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  const chunks = [];
  
  for (const f of files) {
    const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf8');
    const areaKey = f.replace('.md', '');
    
    // 섹션 단위로 분할 (## 또는 ### 기준)
    const sections = content.split(/\n(?=#{1,3}\s)/);
    for (const section of sections) {
      const text = section.trim();
      if (text.length < 30) continue;
      
      // 헤딩 추출
      const headingMatch = text.match(/^#{1,3}\s+(.+)/);
      const heading = headingMatch ? headingMatch[1] : '';
      
      const tokens = tokenize(text);
      const tf = {};
      for (const t of tokens) {
        tf[t] = (tf[t] || 0) + 1;
      }
      
      chunks.push({ text, areaKey, heading, tokens, tf, tokenCount: tokens.length });
    }
  }
  
  // IDF 계산
  const docCount = chunks.length;
  const df = {};
  for (const chunk of chunks) {
    const seen = new Set(chunk.tokens);
    for (const t of seen) {
      df[t] = (df[t] || 0) + 1;
    }
  }
  
  const idf = {};
  for (const [term, count] of Object.entries(df)) {
    idf[term] = Math.log((docCount + 1) / (count + 1)) + 1;
  }
  
  // TF-IDF 벡터 생성
  for (const chunk of chunks) {
    chunk.tfidf = {};
    for (const [term, freq] of Object.entries(chunk.tf)) {
      chunk.tfidf[term] = (freq / chunk.tokenCount) * (idf[term] || 1);
    }
  }
  
  _index = { chunks, idf };
  return _index;
}

// 코사인 유사도 (sparse vector)
function cosineSparse(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (const key in a) {
    normA += a[key] ** 2;
    if (key in b) dot += a[key] * b[key];
  }
  for (const key in b) {
    normB += b[key] ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 텍스트 쿼리로 관련 지식 검색
 * @param {string} query - 검색 쿼리
 * @param {string|null} apiKey - 미사용 (호환성)
 * @param {object} opts - { topK, areaKey, minScore }
 * @returns {string} 관련 텍스트 (합쳐진)
 */
export async function ragSearch(query, apiKey = null, opts = {}) {
  const { topK = 5, areaKey = null, minScore = 0.05 } = opts;
  const index = buildIndex();
  if (!index.chunks.length) return '';
  
  // 쿼리 TF-IDF
  const qTokens = tokenize(query);
  if (!qTokens.length) return '';
  
  const qTf = {};
  for (const t of qTokens) {
    qTf[t] = (qTf[t] || 0) + 1;
  }
  const qTfidf = {};
  for (const [term, freq] of Object.entries(qTf)) {
    qTfidf[term] = (freq / qTokens.length) * (index.idf[term] || 1);
  }
  
  // 유사도 계산 + 정렬
  const scored = index.chunks
    .filter(c => !areaKey || c.areaKey === areaKey)
    .map(c => ({
      text: c.text,
      areaKey: c.areaKey,
      heading: c.heading,
      score: cosineSparse(qTfidf, c.tfidf)
    }))
    .filter(c => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  
  if (!scored.length) return '';
  return scored.map(r => r.text).join('\n\n---\n\n');
}
