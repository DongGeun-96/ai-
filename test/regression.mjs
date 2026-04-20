#!/usr/bin/env node
// ai-sangdam 회귀 테스트 — 배포 전 반드시 통과해야 함
// 사용: node test/regression.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const js = html.split('<script>')[1].split('</script>')[0];

// 중괄호 균형 맞는 블록 추출기
function extractBlock(source, startRe) {
  const m = source.match(startRe);
  if (!m) throw new Error(`pattern not found: ${startRe}`);
  let i = m.index + m[0].length;
  // m[0]이 '{'까지 포함하는 패턴이라고 가정
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return source.slice(m.index, i);
}

function extractFn(name) {
  return extractBlock(js, new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`));
}
function extractLine(startRe) {
  const m = js.match(startRe);
  if (!m) throw new Error(`line not found: ${startRe}`);
  // semicolon 종료
  const start = m.index;
  const end = js.indexOf(';', start) + 1;
  return js.slice(start, end);
}

const snippet = [
  extractLine(/const CELEB_TRIGGER\s*=/),
  extractLine(/const CELEB_SKIP\s*=/),
  extractFn('detectArea'),
  extractFn('detectGender'),
  extractFn('detectAge'),
  extractFn('detectCelebName'),
  'globalThis.__fns = {detectArea, detectGender, detectAge, detectCelebName};'
].join('\n\n');

await import('data:text/javascript;base64,' + Buffer.from(snippet).toString('base64'));
const { detectArea, detectGender, detectAge, detectCelebName } = globalThis.__fns;

const tests = [
  // 연예인 감지
  { in: '카리나 눈 처럼 되고싶어', celeb: '카리나', area: 'eye' },
  { in: '카리나처럼 쌍수', celeb: '카리나', area: 'eye' },
  { in: '아이유 같은 코', celeb: '아이유', area: 'nose' },
  { in: '한소희 스타일 원함', celeb: '한소희', area: '' },
  { in: '수지 같이 예쁘게', celeb: '수지', area: '' },
  // 연예인 오탐 금지
  { in: '쌍수 하고 싶어', celeb: '', area: 'eye' },
  { in: '쌍수처럼 되고싶어', celeb: '', area: 'eye' },
  { in: '요즘 남자 성형', celeb: '', area: '' },
  // 성별
  { in: '남자 코 견적', gender: '남성', area: 'nose' },
  { in: '여성 쌍꺼풀', gender: '여성', area: 'eye' },
  { in: '여친 선물로 코', gender: '여성', area: 'nose' },
  // 나이
  { in: '17살 쌍수 궁금', age: '10대', area: 'eye' },
  { in: '20대 눈매교정', age: '20대', area: 'eye' },
  { in: '45세 코 상담', age: '40대', area: 'nose' },
  // 피부시술
  { in: '보톡스 맞고 싶어', area: 'skin' },
  { in: '기미 치료 방법', area: 'skin' },
  { in: '울쎄라 효과', area: 'skin' },
  // 모발이식
  { in: 'M자 탈모 모발이식', area: 'hair' },
  { in: '정수리 탈모 상담', area: 'hair' },
  // 코 세부 키워드
  { in: '인중축소', area: 'nose' },
  { in: '콧볼축소 하고 싶어요', area: 'nose' },
  { in: '들창코 교정', area: 'nose' },
  { in: '입술 필러', area: 'skin' },
  { in: '다크서클 없애고 싶어', area: 'eye' },
  // 부위 미지정
  { in: '요즘 유행하는 성형', area: '' },
  { in: '뭐가 제일 예뻐', area: '' }
];

let pass = 0, fail = 0;
for (const t of tests) {
  const r = {
    celeb: detectCelebName(t.in),
    area: detectArea(t.in),
    gender: detectGender(t.in),
    age: detectAge(t.in)
  };
  const checks = [];
  for (const k of ['celeb', 'area', 'gender', 'age']) {
    if (t[k] === undefined) continue;
    if (r[k] !== t[k]) checks.push(`${k}: expected "${t[k]}" got "${r[k]}"`);
  }
  if (checks.length === 0) {
    pass++;
    console.log(`✓ ${t.in}`);
  } else {
    fail++;
    console.log(`✗ ${t.in}\n    ${checks.join(', ')}`);
  }
}

// 오타 / 금지 기호 전수 검사
const banned = ['♡', '♥', '❤', '이쁜죠', '이뽐죠', '이뿐죠', '예뽐죠', '오너자', '좌쪽', '아 네~', '되고 싶으시구나요', '되고 싶으구나'];
let lintFail = 0;
for (const word of banned) {
  if (html.includes(word) || readFileSync(join(__dirname, '..', 'api', '_lib.js'), 'utf8').includes(word)) {
    console.log(`✗ 금지어 발견: "${word}"`);
    lintFail++;
  }
}
if (lintFail === 0) console.log('✓ 오타·금지어 없음');

console.log(`\n${pass}/${pass + fail} detect passed, ${lintFail === 0 ? '0 lint issue' : lintFail + ' lint issue'}`);
process.exit(fail === 0 && lintFail === 0 ? 0 : 1);
