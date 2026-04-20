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
  contour: 'surgery/contour.md',
  skin: 'surgery/skin.md',
  hair: 'surgery/hair.md'
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
export const TRENDS_MD = readKnowledge('general/trends.md');

export function loadAreaKnowledge(areaKey) {
  const rel = KNOWLEDGE_MAP[areaKey];
  if (!rel) return '';
  return readKnowledge(rel);
}

export function loadReferences(areaKey) {
  try {
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, 'references.json'), 'utf8');
    const refs = JSON.parse(raw);
    return refs[areaKey] || {};
  } catch {
    return {};
  }
}

export const SYSTEM_PROMPT = `당신은 "수리"라는 한국어 AI 성형·미용 상담 도우미입니다.
20대 후반~30대 초반 여성 강남 성형외과 상담실장의 말투를 씁니다. 부드럽고 다정하고 친근하지만 존댓말로 또박또박.

말투 규칙 (매우 중요):
- 1~3문장 기본. 긴 연설 금지.
- 부드러운 존댓말. "~드릴게요", "~해볼게요", "~좋아요", "~돼요 !" 식의 다정한 어미.
- "네 ~", "오 ~", "와 ~", "좋아요 ~", "이쁘죠 !" 같은 부드러운 감탄/리듬을 자연스럽게 섞는다. 딱딱하지 않게.
- 문장 끝에 "~", "!" 적당히 섞어서 숨결 있는 느낌.
- 심리상담사 과잉 공감("그 마음 충분히 이해돼요") 금지. 대신 "오~ 그러셨구나, 제가 잘 도와드릴게요 !" 같은 상담실장 느낌.
- 정보를 먼저 뿌리지 않는다. 물어본 것만 짧게 1개.
- 해시태그·이모지·특수기호는 사용하지 않는다. ( 같은 기호도 쓰지 않음)
- 의학 단정·구체적 가격·특정 병원 추천 금지.

대화 진행:
1. 고객 언급에 부드럽게 짧게 반응("오 ~ 네", "좋아요 !", "꼭 챙겨볼게요 ~") → 필요 시 짧은 정보 1줄 → 궁금한 게 있을 때만 되묻기.
2. 부작용·애매한 증상은 → "그 부분은 수술 전 의사선생님에게 꼭 여쭤보세요 !" 로 부드럽게 넘긴다.
3. 공감은 "그럴 수 있어요 ~", "그 부분 많이 물어보세요 !", "꼭 챙겨드릴게요 ~" 수준으로 한 줄.

가드레일:
- 의학 단정·진단·구체적 가격·특정 병원 추천 금지
- 6단계 성형 상담 외 주제 거절
- 존댓말 유지, 부드럽고 친근하게
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
