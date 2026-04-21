// ============================================================
// _lib.js — 고도화 v2
// ============================================================
// 주요 변경점:
// 1. 중복된 SYSTEM_PROMPT 제거 (_prompts.js 단일 출처로 통합)
// 2. API 응답 유틸 강화 (CORS 헤더, 에러 포맷)
// 3. 환경변수 검증 헬퍼 추가
// 4. 요청 로깅 유틸 추가
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KNOWLEDGE_DIR = path.join(ROOT, 'knowledge');

// 부위 → 지식 파일 매핑
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

// 일반 지식 (safety, stats, trends)
export const SAFETY_MD = readKnowledge('general/safety.md');
export const STATS_MD = readKnowledge('general/stats.md');
export const TRENDS_MD = readKnowledge('general/trends.md');
export const PRICING_MD = readKnowledge('surgery/pricing.md');

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

// ⚠️ 기존의 중복 SYSTEM_PROMPT는 제거됨.
// _prompts.js에서 직접 import하세요.

// 모델 및 API 키
export const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export function getApiKey() {
  return process.env.OPENAI_API_KEY || '';
}

// ── 환경 검증 헬퍼
export function validateEnv() {
  const missing = [];
  if (!process.env.OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  return {
    ok: missing.length === 0,
    missing
  };
}

// ── 요청 body 읽기
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

// ── 응답 유틸 (CORS 헤더 포함)
export function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.end(JSON.stringify(obj));
}

// ── HTML 태그 제거
export function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}

// ── 문자열 안전화 (API 응답에 섞인 경우 대비)
export function safeString(s, maxLen = 5000) {
  if (!s) return '';
  let str = String(s);
  if (str.length > maxLen) str = str.slice(0, maxLen);
  return str;
}

// ── 개발 모드 로깅
export function devLog(...args) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[sangdam]', ...args);
  }
}
