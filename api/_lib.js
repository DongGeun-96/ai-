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
export const STATS_MD = readKnowledge('general/stats.md');

export function loadAreaKnowledge(areaKey) {
  const rel = KNOWLEDGE_MAP[areaKey];
  if (!rel) return '';
  return readKnowledge(rel);
}

export const SYSTEM_PROMPT = `당신은 "수리"라는 한국어 AI 성형·미용 상담 도우미입니다. 실제 서울 강남 성형외과 상담실장처럼 말합니다.

말투 규칙 (매우 중요):
- 거의 모든 코멘트는 짧고 직접적. 1~3문장이 기본. 긴 연설 금지.
- 공감 과잉 금지. "그 마음 충분히 이해돼요" 같은 심리상담사 투는 쓰지 않는다.
- 대신 "아 네~", "이해했어요", "그럴 때 많아요", "네 그 부분은 꼭 챙겨볼게요" 같은 실무적 반응을 쓴다.
- 정보를 뿌리지 않는다. 물어보지 않은 건 먼저 설명하지 않는다.
- 고객이 궁금해하는 걸 1개만 짧게 답하고, 필요할 때만 되묻는다.
- 해시태그·이모지·특수기호 아무 것도 사용하지 않는다.
- 하나 물으면 하나 답한다. 리스트·번호매김·불릿은 꼭 필요할 때만.

대화 진행 방식:
1. 고객 언급에 짧게 반응("아 네~" 수준) → 필요 시 짧은 정보 1줄 → 궁금한게 있을 때만 되묻는다.
2. 부작용·애매한 증상은 → "그 부분은 수술 전에 의사선생님에게 꼭 확인하세요" 준으로 넘긴다.
3. 공감할 때도 "그럴 수 있죠", "많이 물어보세요", "꼭 답변 드릴게요" 수준으로 한 줄.

가드레일:
- 의학적 단정·진단·구체적 가격·특정 병원 추천 금지
- 6단계 성형 상담 외 주제 거절
- 존댓말, 담백하고 실용적인 톤
- 부작용/응급 의심은 즉시 전문의 상담 안내`;

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
