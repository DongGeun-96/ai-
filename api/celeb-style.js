// 연예인 이름 → 스타일 힌트 (저작권 안전 가이드 고정)
import { getApiKey, readJson, send, MODEL } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const apiKey = getApiKey();
  if (!apiKey) return send(res, 500, { error: 'OPENAI_API_KEY 미설정' });
  let payload;
  try { payload = await readJson(req); } catch { return send(res, 400, { error: 'invalid json' }); }
  const name = String(payload.name || '').trim().slice(0, 20);
  const areaKey = payload.areaKey || '';
  if (!name) return send(res, 400, { error: 'name 필요' });

  const sys = `당신은 한국 미용 트렌드 참고 도우미입니다. 사용자가 언급한 한국 연예인/인플루언서 이름을 받아서,
해당 인물이 대중적으로 알려진 이미지/분위기를 기준으로 "어떤 느낌의 스타일인지" 라벨만 고릅니다.
저작권·초상권 보호: 외모 묘사·수술 여부 추측·의료 권유 절대 금지. 이미지 "분위기"만 추상적 키워드로.

mood 후보 (하나만):
- "자연스럽게": 은은·편안·내추럴
- "또렷하게": 강조·임팩트·큰 눈매 느낌
- "세련되게": 샤프·모던·시크
- "동안 느낌": 둥글·어리·부드러움

반드시 아래 JSON 하나만 반환 (코드펜스·설명·마크다운 금지):
{"found": true|false, "name": "이름", "mood": "mood값", "vibe": "5~15자 키워드", "note": "느낌 참고만 가능, 직접 닮기 목표 지양"}

인지 못하는 이름이면 {"found": false}만 반환.`;

  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `이름: ${name}\n부위힌트: ${areaKey || '미지정'}\nJSON만 반환.` }
        ],
        temperature: 0.3,
        max_tokens: 150
      })
    });
    const data = await upstream.json();
    if (!upstream.ok) return send(res, upstream.status, { error: data?.error?.message || '요청 실패' });
    let raw = data?.choices?.[0]?.message?.content?.trim() || '';
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return send(res, 200, { found: false });
    try {
      const parsed = JSON.parse(m[0]);
      return send(res, 200, parsed);
    } catch {
      return send(res, 200, { found: false });
    }
  } catch (err) {
    return send(res, 502, { error: String(err) });
  }
}
