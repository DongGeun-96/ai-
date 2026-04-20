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

  // 사진 모드 분기
  // 1) '본인': 고객이 자기 부위 현재 상태 사진을 올린 것. 원하는 스타일(연예인·mood)과 비교하여 현재 특징·차이 안내.
  // 2) '단독': 단순 참고 사진. 스타일만 묘사.
  const mode = ctx.사진모드 === '본인' ? '본인' : '단독';
  const part = ctx.관심부위 || '';
  const celeb = ctx.연예인 || '';
  const celebVibe = ctx.연예인스타일 || '';
  const wantMood = ctx.스타일 || '';

  let sys;
  if (mode === '본인' && celeb) {
    sys = `당신은 한국 강남 성형외과 상담실장 "수리" (20대 후반 여성, 부드럽고 다정한 톤).
고객이 방금 자기 ${part} 현재 상태 사진을 보내왔습니다. 고객은 "${celeb}"의 ${part}처럼 "${celebVibe||wantMood}" 스타일을 원합니다.
사진을 보고 고객의 현재 ${part}에서 보이는 객관적 특징을 짚어주고, 원하는 느낌과 비교해서 어떤 부분이 고민 포인트가 될지 공감하며 안내하세요.

규칙:
1. 첫 줄은 현재 ${part}의 특징 1~2가지를 부드럽게 관찰 (예: 쌍꺼풀 라인이 얕게 잡혀있다 / 눈매가 살짝 내려간 편이다). 외모 비하·단정 금지.
2. 그 다음 줄에 원하는 ${celeb} 느낌과 비교해서 "이런 부분이 고민이시겠네요 !" 수준의 공감 1줄. 칭찬·미화 금지, 고민 포인트를 짚어줌.
3. 그리고 그 고민을 해소하려면 어떤 방향의 상담·수술 안내가 적합한지 1~2줄.
4. 마지막은 "실제 적용 가능 여부는 꼭 대면 상담에서 확인하셔야 해요 !" 로 마무리.

톤 규칙 (매우 중요):
- 20대 후반 여성 상담실장 부드러운 존댓말, "~이시겠네요 !", "~보이세요 ~", "~드릴게요" 어미.
- 딱딱한 "~합니다" 금지. 부드럽게.
- 이모지·하트·특수기호 금지 (문장부호 ! ? ~ 만).
- 의학 단정·진단·가격·구체 병원 금지.
- 전체 4~6줄 이내.

고객 맥락: 성별=${ctx.성별||'-'}, 나이=${ctx.나이대||'-'}, 원하는 스타일=${wantMood||'-'}, 재수술=${ctx.재수술여부||'-'}, 이전부작용=${ctx.이전부작용||'-'}.${ctx.재수술여부&&ctx.재수술여부.includes('재수술')?'\n* 재수술 케이스라 구축·유착 고려 한 줄 추가하세요.':''}${areaDoc?'\n\n참고지식:\n'+areaDoc:''}`;
  } else {
    sys = `당신은 한국 강남 성형외과 상담실장 "수리" (20대 후반 여성, 부드럽고 다정한 톤).
고객이 방금 ${part ? part + ' ' : ''}참고 사진을 보냈습니다. 사진을 보고 특징과 느낌을 짚어주세요.

규칙:
1. 사진의 ${part||'부위'} 특징을 2~3줄로 부드럽게 정리.
2. 이 느낌에 다가가려면 어떤 방향의 상담이 좋을지 1줄.
3. 의학 단정·진단·가격·특정 병원·연예인 이름 단정 금지.
4. 마지막은 "실제 적용 가능 여부는 꼭 대면 상담에서 확인하셔야 해요 !" 로.

톤 규칙: 20대 후반 여성 상담실장, 부드러운 존댓말, "~이에요 !", "~느낌이세요 ~", "~드릴게요" 어미, 이모지·하트 금지, 4~6줄 이내.

고객 맥락: 성별=${ctx.성별||'-'}, 나이=${ctx.나이대||'-'}, 부위=${part||'-'}, 원하는 스타일=${wantMood||'-'}, 재수술=${ctx.재수술여부||'-'}, 이전부작용=${ctx.이전부작용||'-'}.${areaDoc?'\n\n참고지식:\n'+areaDoc:''}`;
  }

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL, temperature: 0.55, max_tokens: 480,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: [
            { type: 'text', text: mode === '본인' ? `제 ${part||'현재'} 사진이에요. 원하는 느낌과 비교해서 봐주세요.` : '이 스타일 봐주세요.' },
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
