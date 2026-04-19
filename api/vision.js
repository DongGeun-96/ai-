import { loadAreaKnowledge, MODEL, getApiKey, readJson, send } from './_lib.js';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const apiKey = getApiKey();
  if (!apiKey) return send(res, 500, { error: 'OPENAI_API_KEY 미설정' });
  let payload;
  try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid json' }); }
  const image = payload.image;
  if (!image || typeof image !== 'string') return send(res, 400, { error: 'image 필요' });
  const ctx = payload.context || {};
  const areaDoc = loadAreaKnowledge(ctx.areaKey);
  const sys = `당신은 한국 AI 성형 상담사 "수리". 사용자가 원하는 스타일 참고용 사진을 받았으니 아래 지침을 따르세요.
1. 사진의 스타일 특징을 2~3줄로 정리 (눈 라인, 코 높이, 얼굴형 등).
2. 이 느낌에 다가가려면 어떻게 상담할지 1문장.
3. 의학적 단정·진단·가격 언급 금지.
4. 특정 인물 식별·연예인 이름 금지.
5. 끝에 "실제 적용 가능 여부는 대면 상담에서 보세요" 안내.
6. 존댓말, 3·4문장 이내.
사용자 맥락: 성별=${ctx.성별||'-'}, 나이=${ctx.나이대||'-'}, 부위=${ctx.관심부위||'-'}, 원하는 스타일=${ctx.스타일||'-'}.${areaDoc?'\n지식요약:\n'+areaDoc:''}`;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL, temperature: 0.6, max_tokens: 260,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: [
            { type: 'text', text: '이 스타일에 대해 분석해주세요.' },
            { type: 'image_url', image_url: { url: image } }
          ] }
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
