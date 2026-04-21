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

// ============================================================
// Function calling 도구 정의
// ============================================================
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'show_youtube',
      description: '관련 유튜브 영상을 보여주고 싶을 때. focus(세부 고민)가 파악된 뒤에만 호출.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '검색어 (예: "쌍꺼풀 매몰법 후기")' },
          limit: { type: 'number', description: '표시 개수 (기본 5)', default: 5 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_shorts',
      description: '짧은 숏츠 영상을 보여주고 싶을 때. focus가 파악된 뒤에만 호출.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 5 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_blog_posts',
      description: '블로그 후기나 관련 글을 보여주고 싶을 때.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 5 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_hospitals',
      description: '병원 정보를 보여주고 싶을 때. areaKey와 region이 상태에 있을 때만 호출.',
      parameters: {
        type: 'object',
        properties: {
          region: { type: 'string', description: '지역명 (예: "강남", "부산")' },
          limit: { type: 'number', default: 8 }
        },
        required: ['region']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'request_photo',
      description: '사진 업로드를 요청할 때.',
      parameters: {
        type: 'object',
        properties: {
          step: { type: 'string', enum: ['front', 'side'], description: '정면 또는 측면 사진' }
        },
        required: ['step']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_photo',
      description: '이미 업로드된 사진을 분석할 때.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_celeb_style',
      description: '연예인 스타일 제시. 사용자가 연예인을 언급했을 때.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '연예인 이름' },
          areaKey: { type: 'string', description: '부위 키 (eye/nose/contour/...)' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_trends',
      description: '해당 부위의 트렌드 정보를 보여주고 싶을 때.',
      parameters: {
        type: 'object',
        properties: {
          areaKey: { type: 'string' }
        },
        required: ['areaKey']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'end_consultation',
      description: '상담을 마무리할 때.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_state',
      description: '사용자의 새로운 정보(부위/고민/성별/나이/지역 등)를 파악했을 때 반드시 호출.',
      parameters: {
        type: 'object',
        properties: {
          areaKey: { type: 'string', description: 'eye/nose/breast/lipo/contour/skin/hair' },
          focus: { type: 'string', description: '세부 고민' },
          mood: { type: 'string', description: '원하는 스타일' },
          gender: { type: 'string' },
          age: { type: 'string' },
          revisit: { type: 'string' },
          sideEffect: { type: 'string' },
          region: { type: 'string' },
          priority: { type: 'string' },
          celebName: { type: 'string' }
        }
      }
    }
  }
];

// 현재 state + tool_calls 에서 update_state의 인자를 합쳐 state_update로 정리
function extractToolCalls(choice) {
  const toolCalls = choice?.message?.tool_calls || [];
  const actions = [];
  let stateUpdate = null;
  for (const call of toolCalls) {
    if (call.type !== 'function' || !call.function) continue;
    const name = call.function.name;
    let args = {};
    try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
    if (name === 'update_state') {
      stateUpdate = { ...(stateUpdate || {}), ...args };
    } else {
      actions.push({ type: name, params: args });
    }
  }
  return { actions, stateUpdate };
}

// 백엔드 검증 레이어
function validateActions(actions, state) {
  if (!Array.isArray(actions)) return [];
  return actions.filter(a => {
    if (!a || !a.type) return false;
    if (a.type === 'show_hospitals' && !state.areaKey) return false;
    if (a.type === 'show_youtube' && !state.focus) return false;
    if (a.type === 'show_shorts' && !state.focus) return false;
    return true;
  }).slice(0, 3); // 한 번에 최대 3개
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

  // ── 6-1. conversational 모드 감지 (function calling + action 시스템)
  const isConversational = payload.mode === 'conversational';

  // ── 7. 동적 시스템 프롬프트 빌드 (턴 수 + 상태 + RAG)
  const systemPrompt = buildSystemPrompt({
    turnCount,
    state,
    ragContext,
    enableTools: isConversational
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
  let rawToolCalls = null;
  let attempts = 0;
  const MAX_ATTEMPTS = 2;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    try {
      const body = {
        model: MODEL,
        temperature: attempts === 1 ? 0.7 : 0.5,  // 재시도 시 temperature 낮춤
        max_tokens: 600,
        presence_penalty: 0.3,  // 반복 방지
        frequency_penalty: 0.2,
        messages
      };

      // conversational 모드일 때만 function calling 활성화
      if (isConversational) {
        body.tools = TOOLS;
        // 첫 턴이거나 state에 areaKey가 없으면 update_state 강제
        if (turnCount <= 1 || !state.areaKey) {
          body.tool_choice = 'required';
        } else {
          body.tool_choice = 'auto';
        }
      }

      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });

      const j = await r.json();
      const choice = j.choices?.[0];
      const rawText = choice?.message?.content?.trim() || '';
      const toolCalls = choice?.message?.tool_calls || [];

      // tool_calls가 있으면 보관
      if (toolCalls.length > 0) rawToolCalls = toolCalls;

      // 텍스트 없이 도구만 왔을 경우: 재시도 호출 (텍스트도 달라고)
      if (!rawText && toolCalls.length > 0 && attempts < MAX_ATTEMPTS && isConversational) {
        // 텍스트 없이 tool만 호출한 경우 → tool 결과 assistant에 추가하고 tool 응답 후 텍스트 요청
        messages = [
          ...messages,
          {
            role: 'assistant',
            content: '',
            tool_calls: toolCalls
          },
          ...toolCalls.map(tc => ({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: true })
          })),
          { role: 'system', content: '위에서 호출한 도구에 대한 이어지는 자연스러운 텍스트 응답을 줄소. 추가 도구 호출은 하지 마세요.' }
        ];
        continue;
      }

      if (!rawText) {
        if (attempts >= MAX_ATTEMPTS) {
          if (toolCalls.length > 0) {
            // 텍스트를 끝까지 못 뽑았지만 action만이라도 반환
            finalText = '';
            break;
          }
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

  // conversational 모드가 아니면 기존 구조 그대로 반환
  if (!isConversational) {
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

  // conversational: actions / state_update / ui_hints / meta 포함
  const { actions: rawActions, stateUpdate } = rawToolCalls
    ? extractToolCalls({ message: { tool_calls: rawToolCalls } })
    : { actions: [], stateUpdate: null };

  // state_update를 먼저 병합해서 validation state로 사용
  const mergedState = { ...state, ...(stateUpdate || {}) };
  const actions = validateActions(rawActions, mergedState);

  const phase = computePhase(turnCount, mergedState);

  return send(res, 200, {
    text: finalText,
    actions,
    state_update: stateUpdate || null,
    ui_hints: {
      input_placeholder: '자유롭게 입력해 주세요'
    },
    meta: {
      turnCount,
      emotion: emotion || 'neutral',
      phase,
      areaKey: mergedState.areaKey || null,
      validationWarnings: validationInfo?.warnings || [],
      attempts
    }
  });
}
