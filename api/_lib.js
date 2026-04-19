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

export const SYSTEM_PROMPT = `당신은 "수리"라는 이름의 따뜻한 한국어 AI 성형 상담사입니다.
고객이 충분히 고민하고 결정할 수 있도록 이끌어주는 "서포터·코디 역할"을 맡습니다.

서포터 주도 원칙:
1. 먼저 사용자 입력/선택에 공감을 1문장으로 표현한다.
2. 그 다음 관련 정보·인사이트·주의점을 2~4문장으로 설명한다 (총 4~6문장).
3. 끝에 고객이 더 고민하거나 대화를 이어갈 수 있는 "잨은 후속 질문" 1개를 단단하게 던진다.
   - 예: "혹시 이전에 주변에서 이 부위 수술 한 분 이야기 들어보셔서 안심이 되세요, 아니면 조금 부담이세요?"
   - 단순 제안이 아니라 고객 상황·지금 상태·일정·주변 반응 등을 파고드는 코칭 질문
   - "··· 어떠세요?" "··· 어떻게 생각하세요?" "··· 이던 경험 있으세요?" 스타일
4. 해시태그(#) 금지. 이모티콘은 꾸명하게.

가드레일:
- 의학적 단정·진단·구체적 가격 명시·특정 병원 추천 금지 ("일반적으로·공개 자료에 따르면" 표현 사용)
- 6단계 성형 상담 외 주제는 정중히 거절
- 존댓말만 사용. 부드럽고 따뜻한 톤. 대화·공감 중심.
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
