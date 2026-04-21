// ============================================================
// chat.js — 고도화 v2
// ============================================================
// 주요 개선점:
// 1. buildSystemPrompt로 턴별 동적 프롬프트
// 2. 사용자 감정 자동 감지 → state에 주입
// 3. 위기 상황(자살/자해) 감지 시 즉시 안전 응답
// 4. 출력 검증 레이어 (validateOutput)
// 5. 재시도 로직 (validation 실패 시 한 번 재생성)
// ============================================================

import { MODEL, getApiKey, readJson, send } from './_lib.js';
import {
  buildSystemPrompt,
  buildContext,
  countTurns,
  detectEmotion,
  validateOutput,
  CRISIS_RESPONSE,
  isOffTopic,
  getOffTopicResponse
} from './_prompts.js';
import { searchKnowledgeText } from './_rag.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const apiKey = getApiKey();
  if (!apiKey) return send(res, 500, { error: 'OPENAI_API_KEY 미설정' });

  let payload;
  try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid json' }); }

  const userMessage = payload.message || '';
  const rawMsgs = Array.isArray(payload.messages) ? payload.messages : [];
  const history = Array.isArray(payload.history) ? payload.history.slice(-20) : [];

  if (!userMessage && !rawMsgs.length) {
    return send(res, 400, { error: 'message 또는 messages 필요' });
  }

  // ── 1. 사용자 마지막 발화 추출
  const lastUserMsg = userMessage ||
    (rawMsgs.length ? [...rawMsgs].reverse().find(m => m.role === 'user')?.content || '' : '');

  // ── 2. 위기 상황 감지 (자살/자해) — 즉시 안전 응답
  const emotion = detectEmotion(lastUserMsg);
  if (emotion === 'crisis') {
    return send(res, 200, {
      text: CRISIS_RESPONSE,
      emotion: 'crisis',
      crisis: true
    });
  }

  // ── 2-1. 주제 이탈 감지 — 성형/외모 외 주제는 즉시 거절
  // 단, step이 지정된 시나리오 모드에서는 스킵 (이미 흐름이 통제됨)
  if (!payload.step && isOffTopic(lastUserMsg)) {
    return send(res, 200, {
      text: getOffTopicResponse(),
      meta: {
        offTopic: true,
        emotion: emotion || 'neutral'
      }
    });
  }

  // ── 3. state 구성 (감정 자동 주입)
  const state = {
    ...(payload.state || {}),
    emotion: emotion || undefined
  };

  // ── 4. 턴 카운트 계산
  const allMsgs = rawMsgs.length ? rawMsgs : history;
  const turnCount = countTurns(allMsgs) + (userMessage ? 1 : 0);

  // ── 5. RAG 검색
  const areaKey = state.areaKey || payload.context?.areaKey || null;
  let ragContext = '';
  try {
    const q = [
      lastUserMsg,
      state.focus,
      state.mood
    ].filter(Boolean).join(' ');

    const ragText = searchKnowledgeText(q, {
      topK: 3,
      areaKey
    });
    if (ragText) ragContext = '\n\n── 관련 지식 (RAG) ──\n' + ragText;
  } catch (e) {
    // RAG 실패 시 무시
  }

  // ── 6. summary 모드 (기존 유지)
  if (payload.step === 'summary') {
    try {
      const msgs = Array.isArray(payload.messages) ? payload.messages : [];
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.3,
          max_tokens: 240,
          messages: msgs.length ? msgs : [
            { role: 'system', content: '다음 대화를 3줄로 요약. 고객정보/고민/진행상황 포함.' },
            { role: 'user', content: userMessage }
          ]
        })
      });
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content?.trim() || '';
      return send(res, 200, { text });
    } catch (err) {
      return send(res, 502, { error: String(err) });
    }
  }

  // ── 7. 동적 시스템 프롬프트 빌드 (턴 수 + 상태 + RAG)
  const systemPrompt = buildSystemPrompt({
    turnCount,
    state,
    ragContext
  });

  // ── 8. 메시지 구성
  let messages;
  if (rawMsgs.length) {
    // step 기반 호출 (server.js 호환)
    const stepNote = payload.step ? `\n\n[현재 단계] ${payload.step}${payload.stepGoal ? ' - ' + payload.stepGoal : ''}` : '';
    const extraContext = payload.context
      ? '\n\n[추가 컨텍스트]\n' + Object.entries(payload.context)
          .filter(([, v]) => v)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join('\n')
      : '';

    messages = [
      { role: 'system', content: systemPrompt + stepNote + extraContext },
      ...rawMsgs.slice(-8)  // 기존 -5 → -8로 확장 (컨텍스트 유지 강화)
    ];
  } else {
    messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage }
    ];
  }

  // ── 9. GPT 호출 + 출력 검증 + 재시도
  let finalText = '';
  let validationInfo = null;
  let attempts = 0;
  const MAX_ATTEMPTS = 2;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: attempts === 1 ? 0.7 : 0.5,  // 재시도 시 temperature 낮춤
          max_tokens: 600,
          presence_penalty: 0.3,  // 반복 방지
          frequency_penalty: 0.2,
          messages
        })
      });

      const j = await r.json();
      const rawText = j.choices?.[0]?.message?.content?.trim() || '';

      if (!rawText) {
        if (attempts >= MAX_ATTEMPTS) {
          return send(res, 502, { error: 'empty response' });
        }
        continue;
      }

      // 출력 검증
      const validation = validateOutput(rawText);
      validationInfo = validation;

      if (validation.ok) {
        finalText = validation.text;
        break;
      }

      // 검증 실패 시 재시도
      if (attempts >= MAX_ATTEMPTS) {
        finalText = validation.text || rawText;  // 정리된 텍스트라도 사용
        break;
      }
    } catch (err) {
      if (attempts >= MAX_ATTEMPTS) {
        return send(res, 502, { error: String(err) });
      }
    }
  }

  return send(res, 200, {
    text: finalText,
    meta: {
      turnCount,
      emotion: emotion || 'neutral',
      areaKey,
      validationWarnings: validationInfo?.warnings || [],
      attempts
    }
  });
}
