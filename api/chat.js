// ============================================================
// chat.js — 고도화 v3 (JSON 응답 모드)
// ============================================================
// GPT-4o-mini에서 function calling 대신 JSON mode로 actions/state_update 수신
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

// ── 백엔드 검증 레이어 ──
function validateActions(actions, state) {
  if (!Array.isArray(actions)) return [];
  return actions.filter(a => {
    if (!a || !a.type) return false;
    if (a.type === 'show_hospitals' && !state.areaKey) return false;
    if (a.type === 'show_youtube' && !state.areaKey) return false;
    if (a.type === 'show_shorts' && !state.areaKey) return false;
    return true;
  }).slice(0, 3);
}

// 대화 흐름에 따른 phase
function computePhase(turnCount, state) {
  if (turnCount <= 2) return 'intake';
  if (!state.areaKey) return 'area_identification';
  if (!state.focus) return 'focus_identification';
  if (turnCount <= 5) return 'info_provision';
  if (!state.region) return 'region_ask';
  return 'recommendation';
}

// JSON 응답 파싱 (GPT 출력에서 JSON 추출)
function parseJsonResponse(text) {
  // 마크다운 코드블록 안의 JSON 추출
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1]); } catch {}
  }
  // 전체가 JSON인 경우
  try { return JSON.parse(text); } catch {}
  // { 로 시작하는 부분 추출
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}
  }
  return null;
}

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

  // ── 2. 위기 상황 감지
  const emotion = detectEmotion(lastUserMsg);
  if (emotion === 'crisis') {
    return send(res, 200, { text: CRISIS_RESPONSE, emotion: 'crisis', crisis: true });
  }

  // ── 2-1. 주제 이탈 감지
  if (!payload.step && isOffTopic(lastUserMsg)) {
    return send(res, 200, { text: getOffTopicResponse(), meta: { offTopic: true, emotion: emotion || 'neutral' } });
  }

  // ── 3. state 구성
  const state = { ...(payload.state || {}), emotion: emotion || undefined };

  // ── 4. 턴 카운트
  const allMsgs = rawMsgs.length ? rawMsgs : history;
  const turnCount = countTurns(allMsgs) + (userMessage ? 1 : 0);

  // ── 5. RAG 검색
  const areaKey = state.areaKey || payload.context?.areaKey || null;
  let ragContext = '';
  try {
    const q = [lastUserMsg, state.focus, state.mood].filter(Boolean).join(' ');
    const ragText = searchKnowledgeText(q, { topK: 3, areaKey });
    if (ragText) ragContext = '\n\n── 관련 지식 (RAG) ──\n' + ragText;
  } catch {}

  // ── 6. summary 모드 (기존 유지)
  if (payload.step === 'summary') {
    try {
      const msgs = Array.isArray(payload.messages) ? payload.messages : [];
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL, temperature: 0.3, max_tokens: 240,
          messages: msgs.length ? msgs : [
            { role: 'system', content: '다음 대화를 3줄로 요약. 고객정보/고민/진행상황 포함.' },
            { role: 'user', content: userMessage }
          ]
        })
      });
      const j = await r.json();
      return send(res, 200, { text: j.choices?.[0]?.message?.content?.trim() || '' });
    } catch (err) { return send(res, 502, { error: String(err) }); }
  }

  // ── 6-1. conversational 모드 감지
  const isConversational = payload.mode === 'conversational';

  // ── 7. 시스템 프롬프트
  const systemPrompt = buildSystemPrompt({ turnCount, state, ragContext, enableTools: isConversational });

  // ── 8. 메시지 구성
  let messages;
  if (rawMsgs.length) {
    const stepNote = payload.step ? `\n\n[현재 단계] ${payload.step}${payload.stepGoal ? ' - ' + payload.stepGoal : ''}` : '';
    const extraContext = payload.context
      ? '\n\n[추가 컨텍스트]\n' + Object.entries(payload.context).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n')
      : '';
    messages = [
      { role: 'system', content: systemPrompt + stepNote + extraContext },
      ...rawMsgs.slice(-8)
    ];
  } else {
    messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage }
    ];
  }

  // ── 9. GPT 호출
  let finalText = '';
  let validationInfo = null;
  let parsedJson = null;
  let attempts = 0;
  const MAX_ATTEMPTS = 2;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      const body = {
        model: MODEL,
        temperature: attempts === 1 ? 0.7 : 0.5,
        max_tokens: 800,
        presence_penalty: 0.3,
        frequency_penalty: 0.2,
        messages
      };

      // conversational 모드: JSON mode 강제
      if (isConversational) {
        body.response_format = { type: 'json_object' };
      }

      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });

      const j = await r.json();
      const rawText = j.choices?.[0]?.message?.content?.trim() || '';

      if (!rawText) {
        if (attempts >= MAX_ATTEMPTS) return send(res, 502, { error: 'empty response' });
        continue;
      }

      // conversational: JSON 파싱
      if (isConversational) {
        parsedJson = parseJsonResponse(rawText);
        if (parsedJson && parsedJson.text) {
          finalText = parsedJson.text;
          break;
        }
        // JSON 파싱 실패 시 text로 fallback
        finalText = rawText;
        break;
      }

      // 기존 모드: 출력 검증
      const validation = validateOutput(rawText);
      validationInfo = validation;
      if (validation.ok) { finalText = validation.text; break; }
      if (attempts >= MAX_ATTEMPTS) { finalText = validation.text || rawText; break; }
    } catch (err) {
      if (attempts >= MAX_ATTEMPTS) return send(res, 502, { error: String(err) });
    }
  }

  // ── 10. 응답 반환
  if (!isConversational) {
    return send(res, 200, {
      text: finalText,
      meta: { turnCount, emotion: emotion || 'neutral', areaKey, validationWarnings: validationInfo?.warnings || [], attempts }
    });
  }

  // conversational: JSON에서 actions/state_update 추출
  const stateUpdate = parsedJson?.state_update || null;
  const rawActions = parsedJson?.actions || [];

  // state_update를 병합해서 validation에 사용
  const mergedState = { ...state, ...(stateUpdate || {}) };
  const phase = computePhase(turnCount, mergedState);

  // ── 자동 action 주입: GPT가 빠뜨렸을 때 기존 플로우대로 보간 ──
  const autoActions = [...rawActions];
  const hasAction = (type) => autoActions.some(a => a.type === type);

  // 턴5: areaKey + focus 파악됐고 최소 5턴 지난 후 show_trends
  if (mergedState.areaKey && mergedState.focus && !hasAction('show_trends') && !state.trendShown && turnCount >= 5) {
    autoActions.push({ type: 'show_trends', params: { areaKey: mergedState.areaKey } });
  }

  // 턴11~13: 수술법 설명 후 영상/후기 (최소 8턴 후)
  if (state.trendShown && mergedState.areaKey && !state.videosShown && turnCount >= 8) {
    const q = (mergedState.focus || mergedState.areaKey) + ' 수술 후기';
    if (!hasAction('show_youtube')) autoActions.push({ type: 'show_youtube', params: { query: q, limit: 5 } });
    if (!hasAction('show_shorts')) autoActions.push({ type: 'show_shorts', params: { query: mergedState.areaKey + ' 수술 비포 애프터', limit: 5 } });
    if (!hasAction('show_blog_posts')) autoActions.push({ type: 'show_blog_posts', params: { query: q, limit: 5 } });
  }

  // 5단계: 지역 파악되면 병원 자동
  if (mergedState.region && mergedState.areaKey && !hasAction('show_hospitals')) {
    autoActions.push({ type: 'show_hospitals', params: { region: mergedState.region, limit: 8 } });
  }

  const actions = validateActions(autoActions, mergedState);

  // text에서 validateOutput 적용
  const textValidation = validateOutput(finalText);
  let cleanText = textValidation.ok ? textValidation.text : (textValidation.text || finalText);

  // 성별/나이 미수집 시 자동 질문 추가
  if (mergedState.areaKey && (!mergedState.gender || !mergedState.age)) {
    const needGender = !mergedState.gender && !cleanText.includes('성별');
    const needAge = !mergedState.age && !cleanText.includes('나이');
    if ((needGender || needAge) && !cleanText.includes('알려주세요')) {
      const asks = [];
      if (needGender) asks.push('성별');
      if (needAge) asks.push('나이');
      cleanText += ' ' + asks.join('과 ') + '도 알려주시면 더 맞춤형 상담이 가능해요.';
    }
  }
  // 지역 미수집 + 수술법 설명 후
  if (mergedState.areaKey && mergedState.gender && mergedState.age && !mergedState.region
      && !cleanText.includes('지역') && !cleanText.includes('어디') && !cleanText.includes('어느')
      && state.trendShown) {
    cleanText += ' 어느 지역에서 알아보고 계세요?';
  }

  return send(res, 200, {
    text: cleanText,
    actions,
    state_update: stateUpdate,
    ui_hints: { input_placeholder: '자유롭게 입력해 주세요' },
    meta: { turnCount, emotion: emotion || 'neutral', phase, areaKey: mergedState.areaKey || null, attempts }
  });
}
