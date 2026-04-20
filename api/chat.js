import { MODEL, getApiKey, readJson, send } from './_lib.js';
import { SYSTEM_PROMPT, buildContext } from './_prompts.js';
import { searchKnowledgeText } from './_rag.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const apiKey = getApiKey();
  if (!apiKey) return send(res, 500, { error: 'OPENAI_API_KEY 미설정' });

  let payload;
  try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid json' }); }

  const userMessage = payload.message;
  if (!userMessage || typeof userMessage !== 'string') return send(res, 400, { error: 'message 필요' });

  const history = Array.isArray(payload.history) ? payload.history.slice(-20) : [];
  const stateCtx = payload.state ? buildContext(payload.state) : '';

  // RAG: 유저 메시지(+관심부위)로 관련 청크 검색
  const areaKey = payload.state?.areaKey || null;
  let kb = '';
  try {
    const q = [userMessage, payload.state?.focus, payload.state?.mood].filter(Boolean).join(' ');
    const ragText = searchKnowledgeText(q || userMessage, { topK: 3, areaKey });
    if (ragText) kb = '\n\n── 관련 지식 (RAG) ──\n' + ragText;
  } catch (e) {
    // RAG 실패시 조용히 넘어감 (기존 플로우 유지)
  }

  // step=summary: 채팅 히스토리 요약 전용 모드 (다른 프롬프트)
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

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + stateCtx + kb },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage }
  ];

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.6,
        max_tokens: 300,
        messages
      })
    });
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content?.trim() || '';
    return send(res, 200, { text });
  } catch (err) {
    return send(res, 502, { error: String(err) });
  }
}
