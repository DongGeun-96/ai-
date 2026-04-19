import { SYSTEM_PROMPT, SAFETY_MD, STATS_MD, loadAreaKnowledge, MODEL, getApiKey, readJson, send } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const apiKey = getApiKey();
  if (!apiKey) return send(res, 500, { error: 'OPENAI_API_KEY 미설정' });
  let payload;
  try { payload = await readJson(req); } catch (e) { return send(res, 400, { error: 'invalid json' }); }
  const rawMsgs = Array.isArray(payload.messages) ? payload.messages : [];
  const userMessages = rawMsgs.slice(-5);
  const stepNote = payload.step ? `\n\n현재 STEP: ${payload.step}\n단계 목적: ${payload.stepGoal || ''}` : '';
  const context = payload.context
    ? `\n\n대화 컨텍스트\n${Object.entries(payload.context).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
    : '';
  const areaKey = payload.context?.areaKey;
  const areaDoc = loadAreaKnowledge(areaKey);
  const kb = areaDoc ? `\n\n── 전문 지식 (${areaKey}) ──\n${areaDoc}` : '';
  const step = Number(payload.step || 0);
  const includeSafety = step === 1 || step >= 6;
  const safety = includeSafety && SAFETY_MD ? `\n\n── 안전·가드레일 ──\n${SAFETY_MD}` : '';
  const stats = STATS_MD ? `\n\n── 공식 통계·부작용·비용 자료 (인용 가능) ──\n${STATS_MD}` : '';
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + stepNote + context + safety + kb + stats },
    ...userMessages
  ];
  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.65, max_tokens: 480 })
    });
    const data = await upstream.json();
    if (!upstream.ok) return send(res, upstream.status, { error: data?.error?.message || '요청 실패' });
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    return send(res, 200, { text });
  } catch (err) {
    return send(res, 502, { error: String(err) });
  }
}
