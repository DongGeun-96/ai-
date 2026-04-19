// 공유 유틸 (Vercel Serverless Function 공용)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// api/_lib.js 기준 → 프로젝트 루트는 한 단계 위
const ROOT = path.resolve(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');

const KNOWLEDGE_MAP = {
  eye: 'surgery/eye.md',
  nose: 'surgery/nose.md',
  breast: 'surgery/breast.md',
  lipo: 'surgery/lipo.md',
  contour: 'surgery/contour.md'
};

function readKnowledge(rel) {
  try {
    return fs.readFileSync(path.join(KNOWLEDGE_DIR, rel), 'utf8');
  } catch {
    return '';
  }
}

export const SAFETY_MD = readKnowledge('general/safety.md');

export function loadAreaKnowledge(areaKey) {
  const rel = KNOWLEDGE_MAP[areaKey];
  if (!rel) return '';
  return readKnowledge(rel);
}

export const SYSTEM_PROMPT = `당신은 "수리"라는 이름의 한국어 AI 성형 상담사입니다.
공개 정보 기반으로 객관적 안내를 제공합니다.

가드레일:
- 의학적 단정·진단·가격·특정 병원 추천 금지
- 6단계 성형 상담 외 주제(코딩, 시사 등)는 정중히 거절
- 존댓말, 3·4문장 이내, 부드럽고 따뜻한 톤
- 부작용/응급 의심 표현이 있으면 즉시 전문의 상담 안내`;

export const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export function getApiKey() {
  return process.env.OPENAI_API_KEY || '';
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > 5_000_000) {
        req.destroy();
        reject(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

export function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}
