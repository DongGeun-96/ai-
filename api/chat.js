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
function isPriceIntent(text = '') {
  return /가격|비용|얼마나?\s*(해|하|드|들|정도|쯤|돼|되)|얼만|비싸|저렴|시세/.test(String(text || '').toLowerCase());
}

function asksMaterial(lastUserMsg = '', type = '') {
  const t = String(lastUserMsg || '').toLowerCase();
  const anyMaterial = /자료|예시|보여|보여줘|정리|링크|참고|후기|영상|블로그|쇼츠|shorts|유튜브|가격|비용|수술법|방법|병원|추천|사례|보고\s*싶|얼마|얼만|비싸|저렴/.test(t);
  if (type === 'show_youtube' || type === 'show_shorts') return /영상|쇼츠|shorts|유튜브|자료|예시|후기|참고|사례|보고\s*싶/.test(t);
  if (type === 'show_blog_posts') return /블로그|후기|자료|예시|참고|사례|보고\s*싶/.test(t);
  if (type === 'show_trends') return /수술법|방법|가격|비용|정리|추천|자료|예시|뭐가|얼마|얼만|비싸|저렴|시세/.test(t);
  if (type === 'show_hospitals') return /병원|추천|어디서|의원|자료|정리/.test(t);
  return anyMaterial;
}

function shouldSurfaceMaterial(type, state, phase, lastUserMsg = '') {
  if (asksMaterial(lastUserMsg, type)) return true;
  if (type === 'show_trends') return !!(state.areaKey && state.focus && ['history_check','method_explanation','priority_check','evidence_share'].includes(phase));
  if (type === 'show_youtube' || type === 'show_shorts' || type === 'show_blog_posts') {
    return !!(state.areaKey && state.trendShown);
  }
  if (type === 'show_hospitals') return !!(state.areaKey && state.region && ['region_ask','summary_close','followup_qna'].includes(phase));
  return false;
}

function validateActions(actions, state, phase, lastUserMsg = '') {
  if (!Array.isArray(actions)) return [];
  const priority = {
    show_trends: 1,
    show_youtube: 2,
    show_shorts: 3,
    show_blog_posts: 4,
    show_hospitals: 5,
    request_photo: 6,
    show_celeb_style: 7,
    end_consultation: 8
  };
  return actions.filter(a => {
    if (!a || !a.type) return false;
    if (a.type === 'show_hospitals' && !state.areaKey) return false;
    if (a.type === 'show_youtube' && !state.areaKey) return false;
    if (a.type === 'show_shorts' && !state.areaKey) return false;
    if (['show_trends','show_youtube','show_shorts','show_blog_posts','show_hospitals'].includes(a.type) && !shouldSurfaceMaterial(a.type, state, phase, lastUserMsg)) return false;
    return true;
  }).sort((a,b)=>(priority[a.type]||99)-(priority[b.type]||99)).slice(0, 3);
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
      if (state.focus) return `${state.focus} 관련해서 이전에 상담이나 시술 받아보신 적 있으세요?`;
      return '혹시 이전에 시술이나 수술 받아보신 적이 있으세요?';
    case 'method_explanation':
      return '설명드린 방법 중에 끌리는 게 있으세요, 아니면 다른 부분이 더 궁금하세요?';
    case 'priority_check':
      return '회복이 빠른 게 중요하세요, 아니면 결과가 자연스러운 게 더 중요하세요?';
    case 'evidence_share':
      return '자료 보시고 마음에 드는 스타일 있으면 말씀해주세요.';
    case 'region_ask':
      return '어느 지역에서 알아보고 계세요?';
    default:
      return '지금 가장 궁금한 부분이 뭐예요?';
  }
}

function stripMaterialLeadNoise(text = '') {
  return String(text)
    .replace(/^수술이나 시술 경험이 있으셨다면 더 신중하게 보게 되실 거예요\.\s*/,'')
    .replace(/^그 부분이 계속 마음에 걸리실 수 있어요\.\s*/,'')
    .trim();
}

function normalizeMaterialQuestion(text = '') {
  return String(text).replace(/\s*혹시\s*이전에\s*시술이나\s*수술\s*받아보신\s*적이\s*있으세요\?\s*$/,' 자료 보시고 어떤 스타일이 더 마음에 드는지 말씀해주시면 그 기준으로 더 좁혀드릴게요.');
}

function normalizePriceCardLead(text = '', actions = []) {
  const trend = actions.find(a => a.type === 'show_trends');
  if (!trend || trend.params?.intent !== 'price') return String(text || '');
  // 가격 intent일 때만: GPT 본문의 긴 가격 설명을 짧은 안내로 교체
  return '가격은 수술 방법이랑 재료에 따라 차이가 있어서, 가격표 카드로 같이 정리해드릴게요.';
}

function ensureMaterialLead(text = '', actions = []) {
  const t = String(text || '').trim();
  const types = actions.map(a => a.type);
  const trendAction = actions.find(a => a.type === 'show_trends');
  if (types.includes('show_trends')) {
    // 가격 intent이면 이미 normalizePriceCardLead에서 처리됨 → 그대로 반환
    if (trendAction?.params?.intent === 'price') return t;
    // 일반 trend: 이미 자연스러운 연결이 있으면 그대로, 없으면 간단 연결만
    if (/수술법|방법|방식|카드|정리/.test(t)) return t;
    return `수술 방법 카드도 같이 정리해드릴게요. ${t}`.trim();
  }
  if (types.includes('show_youtube') || types.includes('show_shorts') || types.includes('show_blog_posts')) {
    if (/자료|영상|후기|사례|비포\s*애프터|블로그|보시면|참고/.test(t)) return t;
    // 다양한 연결 멘트 (반복 방지)
    const leads = [
      '실제 사례를 보시면 감이 더 잘 오실 거예요.',
      '참고할 수 있는 자료도 같이 정리해드릴게요.',
      '후기 영상이랑 글도 같이 보면 이해가 쉬우실 거예요.'
    ];
    const lead = leads[Math.floor(Math.random() * leads.length)];
    return `${lead} ${t}`.trim();
  }
  if (types.includes('show_hospitals')) {
    if (/병원|지역/.test(t)) return t;
    return `이제는 병원 정보도 같이 보시는 게 판단에 도움이 될 거예요. ${t}`.trim();
  }
  if (types.includes('request_photo')) {
    if (/사진/.test(t)) return t;
    return `사진으로 보면 더 정확하게 짚어드릴 수 있어요. ${t}`.trim();
  }
  if (types.includes('show_celeb_style')) {
    if (/스타일|느낌|참고/.test(t)) return t;
    return `원하시는 느낌을 더 구체적으로 맞추려면 참고 스타일도 같이 보는 게 도움이 돼요. ${t}`.trim();
  }
  return t;
}

// 불완전한 연예인 이름(초성/자음 포함) 감지
function hasIncompleteNameInput(text = '') {
  return /[가-힣]+[ㄱ-ㅎㅏ-ㅣ]/.test(String(text || ''));
}

// GPT가 불완전 이름을 보정해서 공감한 경우 후처리
function sanitizeCelebResponse(text = '', userMsg = '') {
  if (!hasIncompleteNameInput(userMsg)) return text;
  // 유저가 불완전 이름을 쳤는데 GPT가 특정 인물 이름 + 외모 묘사를 했으면 교체
  // 예: "차은우씨는 콧대가 높고", "차은우씨 코처럼"
  const celebDescPattern = /([가-힣]{2,5})(씨|분)[는은의의]?[\s,]*.{0,20}(코|콧대|눈|턱|얼굴|라인|느낌|스타일).{0,15}(높|낮|또렷|매끈|예쁘|깔끔|시원|날카|자연|세련|부드럽|곡선|특징)/;
  // 더 넓은 패턴: "OO씨 코처럼", "OO씨는 ~ 스타일"
  const celebSimple = /([가-힣]{2,5})(씨|분)[는은]?\s+코처럼/;
  if (celebDescPattern.test(text) || celebSimple.test(text)) {
    return '혹시 정확한 이름을 알려주실 수 있을까요? 이름이 정확해야 그 느낌을 참고해서 더 잘 안내해드릴 수 있거든요. 원하시는 코 느낌을 다른 방식으로 설명해주셔도 좋아요.';
  }
  return text;
}

function stripIrrelevantHistoryLead(text = '', lastUserMsg = '') {
  const userT = String(lastUserMsg || '');
  if (/이전|재수술|시술\s*받|수술\s*받/.test(userT)) return String(text || '');
  return String(text || '').replace(/^수술이나 시술 경험이 있으셨다면 더 신중하게 보게 되실 거예요\.\s*/,'').trim();
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
  const isConversational = payload.mode === 'conversational';

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
  // conversational 상담 모드에서는 딴소리도 상담 흐름으로 다시 끌고 와야 하므로 즉시 차단하지 않음
  if (!isConversational && !payload.step && isOffTopic(lastUserMsg)) {
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

  // ── 7. 시스템 프롬프트
  const offTopicRedirectNote = (isConversational && isOffTopic(lastUserMsg))
    ? '\n\n[현재 사용자 발화는 잠깐 상담 주제에서 벗어났습니다]\n- 그 말을 짧게 받아주세요\n- 하지만 대화를 그쪽으로 길게 끌고 가지 마세요\n- 지금까지 파악한 고민 부위와 상담 자료를 활용해 자연스럽게 현재 상담으로 다시 연결하세요\n- 거절형 응답 대신 상담 복귀형 응답을 하세요'
    : '';
  const systemPrompt = buildSystemPrompt({ turnCount, state, ragContext, enableTools: isConversational }) + offTopicRedirectNote;

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

  // 자료는 상담 근거로 활용하되, 적절한 타이밍에는 선제적으로 보여줌
  const autoActions = [...rawActions];
  const hasAction = (type) => autoActions.some(a => a.type === type);

  // show_trends: 이미 보여줬으면 가격 intent일 때만 허용, 아니면 제거
  const alreadyTrend = state.trendShown || mergedState.trendShown;
  const priceQ = isPriceIntent(lastUserMsg);
  // 처음 trend or 가격 질문이면 show_trends 추가
  // history_check 단계에서는 답변을 먼저 듣고 넘어가야 하므로 자료를 선제 노출하지 않음
  if (mergedState.areaKey && mergedState.focus && !hasAction('show_trends')) {
    if (!alreadyTrend && (['method_explanation','priority_check'].includes(phase) || asksMaterial(lastUserMsg, 'show_trends'))) {
      autoActions.push({ type: 'show_trends', params: { areaKey: mergedState.areaKey, intent: priceQ ? 'price' : 'trend' } });
    } else if (alreadyTrend && priceQ) {
      // trendShown 이후라도 가격 질문이면 가격표 카드 보여줌
      autoActions.push({ type: 'show_trends', params: { areaKey: mergedState.areaKey, intent: 'price' } });
    }
  }
  // 이미 trendShown인데 show_trends가 있으면: 가격 intent일 때만 허용, 아니면 제거
  if (alreadyTrend) {
    const priceQ = isPriceIntent(lastUserMsg);
    if (priceQ && hasAction('show_trends')) {
      autoActions.forEach(a => {
        if (a.type === 'show_trends') {
          a.params = { ...(a.params || {}), areaKey: (a.params||{}).areaKey || mergedState.areaKey, intent: 'price' };
        }
      });
    } else {
      // 가격 아니면 모든 show_trends 제거 (중복 방지)
      for (let i = autoActions.length - 1; i >= 0; i--) {
        if (autoActions[i].type === 'show_trends') autoActions.splice(i, 1);
      }
    }
  }
  // 가격 질문인데 GPT가 이미 show_trends를 넣었으면 intent만 보강
  if (hasAction('show_trends') && isPriceIntent(lastUserMsg)) {
    autoActions.forEach(a => {
      if (a.type === 'show_trends') {
        a.params = { ...(a.params || {}), areaKey: (a.params||{}).areaKey || mergedState.areaKey, intent: 'price' };
      }
    });
  }

  if (state.trendShown && mergedState.areaKey && !state.videosShown && !hasAction('show_youtube') && (turnCount >= 2 || asksMaterial(lastUserMsg))) {
    const q = (mergedState.focus || mergedState.areaKey) + ' 수술 후기';
    autoActions.push({ type: 'show_youtube', params: { query: q, limit: 5 } });
    autoActions.push({ type: 'show_shorts', params: { query: mergedState.areaKey + ' 수술 비포 애프터', limit: 5 } });
    autoActions.push({ type: 'show_blog_posts', params: { query: q, limit: 5 } });
  }

  // 쇼츠나 후기 자료를 꺼낼 때는 유튜브 본편도 같이 붙이기
  if ((hasAction('show_shorts') || hasAction('show_blog_posts')) && !hasAction('show_youtube') && mergedState.areaKey) {
    const q = (mergedState.focus || mergedState.areaKey) + ' 수술 후기';
    autoActions.push({ type: 'show_youtube', params: { query: q, limit: 5 } });
  }

  if (mergedState.areaKey && mergedState.region && !hasAction('show_hospitals') && phase === 'region_ask') {
    autoActions.push({ type: 'show_hospitals', params: { region: mergedState.region, limit: 8 } });
  }

  const actions = validateActions(autoActions, mergedState, phase, lastUserMsg);

  // text에서 validateOutput 적용
  const textValidation = validateOutput(finalText);
  let cleanText = textValidation.ok ? textValidation.text : (textValidation.text || finalText);
  cleanText = stripIrrelevantHistoryLead(cleanText, lastUserMsg);
  cleanText = sanitizeCelebResponse(cleanText, lastUserMsg);

  // 코디네이터식 대화 유도: 공감 없이 바로 설명하면 앞에 보강
  const hasEndAction = actions.some(a => a.type === 'end_consultation');
  const isMaterialTurn = actions.length > 0;
  if (isMaterialTurn) {
    cleanText = normalizePriceCardLead(cleanText, actions);
    cleanText = ensureMaterialLead(normalizeMaterialQuestion(stripMaterialLeadNoise(cleanText)), actions);
    // 카드가 있는 턴에서는 텍스트를 짧게 유지 (카드가 정보를 대신)
    // 문장 단위로 자르기: 요./요?/요!/죠./요~  등
    const sentences = cleanText.split(/(?<=[.?!])\s+/).filter(Boolean);
    if (sentences.length > 3) {
      cleanText = sentences.slice(0, 3).join(' ');
    }
  }
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
