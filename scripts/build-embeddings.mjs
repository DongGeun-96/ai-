#!/usr/bin/env node
/**
 * knowledge/*.md → 청크 분할 → OpenAI 임베딩 → knowledge/embeddings.json
 * 빌드 시 1회 실행. Vercel 배포 전 또는 knowledge 변경 시.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge', 'surgery');
const OUT_PATH = path.join(ROOT, 'knowledge', 'embeddings.json');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY 환경변수 필요');
  process.exit(1);
}

const EMBED_MODEL = 'text-embedding-3-small';
const CHUNK_SIZE = 600; // 글자 기준
const CHUNK_OVERLAP = 100;

// 1. md 파일 읽기
function loadMarkdownFiles() {
  const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  const docs = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, f), 'utf8');
    const areaKey = f.replace('.md', '');
    docs.push({ areaKey, filename: f, content });
  }
  return docs;
}

// 2. 청크 분할 (헤딩 기반 + 크기 제한)
function chunkDocument(doc) {
  const lines = doc.content.split('\n');
  const chunks = [];
  let currentHeading = '';
  let currentText = '';

  for (const line of lines) {
    // 헤딩 감지
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      // 이전 청크 저장
      if (currentText.trim().length > 50) {
        chunks.push(...splitBySize(currentText.trim(), doc.areaKey, currentHeading, doc.filename));
      }
      currentHeading = headingMatch[1];
      currentText = line + '\n';
    } else {
      currentText += line + '\n';
    }
  }
  // 마지막 청크
  if (currentText.trim().length > 50) {
    chunks.push(...splitBySize(currentText.trim(), doc.areaKey, currentHeading, doc.filename));
  }
  return chunks;
}

function splitBySize(text, areaKey, heading, filename) {
  if (text.length <= CHUNK_SIZE) {
    return [{ text, areaKey, heading, filename }];
  }
  const results = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    results.push({
      text: text.slice(start, end),
      areaKey,
      heading,
      filename
    });
    start = end - CHUNK_OVERLAP;
    if (start >= text.length) break;
  }
  return results;
}

// 3. OpenAI 임베딩 API 호출 (배치)
async function getEmbeddings(texts) {
  const batchSize = 100;
  const allEmbeddings = [];
  
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    console.log(`  임베딩 ${i + 1}~${i + batch.length} / ${texts.length}...`);
    
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch })
    });
    
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`임베딩 API 실패: ${res.status} ${err}`);
    }
    
    const data = await res.json();
    for (const item of data.data) {
      allEmbeddings.push(item.embedding);
    }
    
    // 레이트 리밋 방지
    if (i + batchSize < texts.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  return allEmbeddings;
}

// 메인
async function main() {
  console.log('📚 Knowledge 임베딩 빌드 시작...');
  
  const docs = loadMarkdownFiles();
  console.log(`  ${docs.length}개 파일 로드`);
  
  const allChunks = [];
  for (const doc of docs) {
    const chunks = chunkDocument(doc);
    allChunks.push(...chunks);
  }
  console.log(`  ${allChunks.length}개 청크 생성`);
  
  const texts = allChunks.map(c => c.text);
  const embeddings = await getEmbeddings(texts);
  
  // 저장
  const output = allChunks.map((chunk, i) => ({
    text: chunk.text,
    areaKey: chunk.areaKey,
    heading: chunk.heading,
    filename: chunk.filename,
    embedding: embeddings[i]
  }));
  
  fs.writeFileSync(OUT_PATH, JSON.stringify(output));
  const sizeMB = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(2);
  console.log(`✅ ${OUT_PATH} 저장 (${output.length}개 청크, ${sizeMB}MB)`);
}

main().catch(err => {
  console.error('빌드 실패:', err);
  process.exit(1);
});
