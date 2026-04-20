import { MODEL, getApiKey, readJson, send } from './_lib.js';
import { SYSTEM_PROMPT, buildContext } from './_prompts.js';

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

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + stateCtx },
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
