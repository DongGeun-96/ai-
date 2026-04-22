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
function wantsMaterial(lastUserMsg = '', type = '') {
  const t = String(lastUserMsg || '').toLowerCase();
  const anyMaterial = /자료|예시|보여|보여줘|정리|링크|참고|후기|영상|블로그|쇼츠|shorts|유튜브|가격|비용|수술법|방법|병원|추천/.test(t);
  if (type === 'show_youtube' || type === 'show_shorts') return /영상|쇼츠|shorts|유튜브|자료|예시|후기|참고/.test(t);
  if (type === 'show_blog_posts') return /블로그|후기|자료|예시|참고/.test(t);
  if (type === 'show_trends') return /수술법|방법|가격|비용|정리|추천|자료|예시|뭐가/.test(t);
  if (type === 'show_hospitals') return /병원|추천|어디서|의원|자료|정리/.test(t);
  return anyMaterial;
}

function validateActions(actions, state, lastUserMsg = '') {
  if (!Array.isArray(actions)) return [];
  return actions.filter(a => {
    if (!a || !a.type) return false;
    if (a.type === 'show_hospitals' && !state.areaKey) return false;
    if (a.type === 'show_youtube' && !state.areaKey) return false;
    if (a.type === 'show_shorts' && !state.areaKey) return false;
    if (['show_trends','show_youtube','show_shorts','show_blog_posts','show_hospitals'].includes(a.type) && !wantsMaterial(lastUserMsg, a.type)) return false;
    return true;
  }).slice(0, 3);
}

// 대화 흐름에 따른 phase
function computePhase(turnCount, state) {
  if (!state.gender || !state.age || !state.areaKey) return 'intake';
  if (!state.focus) return 'focus_identification';
  if (!state.mood) return 'style_identification';
  if (!state.revisit && !state.sideEffect) return 'history_check';
  if (!state.trendShown) return 'method_explanation';
  if (!state.priority) return 'priority_check';
  if (!state.videosShown) return 'evidence_share';
  if (!state.region) return 'region_ask';
  return turnCount >= 8 ? 'summary_close' : 'followup_qna';
}

function hasQuestionTone(text = '') {
  return /\?|\uFF1F|신가요|세요\.|세요\?|알려주실|말씀해주실|어떠세요|어떤\s+편|궁금하신|있으세요/.test(String(text));
}

function hasEmpathyTone(text = '') {
  return /고민이시군요|걱정되|많이\s*고민|불안하|신경\s*쓰이|마음에\s*걸리|부담되|스트레스/.test(String(text));
}

function getEmpathyLead(phase, state) {
  if (state.sideEffect) return '그 부분이 계속 마음에 걸리실 수 있어요.';
  if (phase === 'history_check') return '수술이나 시술 경험이 있으셨다면 더 신중하게 보게 되실 거예요.';
  if (phase === 'priority_check') return '무엇을 더 중요하게 볼지 고민되실 수 있어요.';
  if (phase === 'evidence_share') return '사진이나 후기 자료를 보실 때 더 복잡하게 느껴지실 수 있어요.';
  if (state.focus) return `${state.focus} 부분이 고민이시군요.`;
  return '많이 고민되셨을 것 같아요.';
}

function getFollowupQuestion(phase, state) {
  switch (phase) {
    case 'intake':
      if (!state.gender && !state.age) return '성별과 나이도 같이 알려주시면 더 정확하게 봐드릴 수 있어요.';
      if (!state.areaKey) return '어느 부위가 가장 고민이세요?';
      return '그 부위에서 어떤 점이 가장 신경 쓰이세요?';
    case 'focus_identification':
      return '사진에서 봤을 때 어떤 인상 때문에 가장 스트레스 받으시는지 말씀해주실 수 있으세요?';
    case 'style_identification':
      return '원하시는 방향은 자연스러운 쪽인지, 또렷하게 변화가 보이는 쪽인지 어떤 편이세요?';
    case 'history_check':
      return '혹시 이전에 시술이나 수술 받아보신 적이 있으세요?';
    case 'method_explanation':
      return '지금 설명드린 방법 중에서는 어떤 방향이 가장 끌리세요?';
    case 'priority_check':
      return '회복 기간, 자연스러움, 비용 중에서는 어떤 부분을 가장 중요하게 보세요?';
    case 'evidence_share':
      return '자료 보시면 어떤 스타일이 더 마음에 드는지 말씀해주실 수 있으세요?';
    case 'region_ask':
      return '어느 지역에서 알아보고 계세요?';
    default:
      return '지금 가장 궁금한 부분이 뭐예요?';
  }
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

  // 자료/카드/병원은 상담 근거 자료로 쓰고, 사용자가 원할 때만 노출
  const actions = validateActions(rawActions, mergedState, lastUserMsg);

  // text에서 validateOutput 적용
  const textValidation = validateOutput(finalText);
  let cleanText = textValidation.ok ? textValidation.text : (textValidation.text || finalText);

  // 코디네이터식 대화 유도: 공감 없이 바로 설명하면 앞에 보강
  const hasEndAction = actions.some(a => a.type === 'end_consultation');
  const isMaterialTurn = actions.length > 0 && wantsMaterial(lastUserMsg);
  if (!hasEndAction && !isMaterialTurn && !hasEmpathyTone(cleanText)) {
    cleanText = `${getEmpathyLead(phase, mergedState)} ${cleanText}`.trim();
  }

  // 설명만 하고 끝나지 않게 다음 질문 보강
  if (!hasEndAction && !hasQuestionTone(cleanText)) {
    cleanText += ' ' + getFollowupQuestion(phase, mergedState);
  }

  return send(res, 200, {
    text: cleanText,
    actions,
    state_update: stateUpdate,
    ui_hints: { input_placeholder: '자유롭게 입력해 주세요' },
    meta: { turnCount, emotion: emotion || 'neutral', phase, areaKey: mergedState.areaKey || null, attempts }
  });
}
