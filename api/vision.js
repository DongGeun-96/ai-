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

  const mode = ctx.사진모드 === '본인' ? '본인' : '단독';
  const part = ctx.관심부위 || '';
  const celeb = ctx.연예인 || '';
  const celebVibe = ctx.연예인스타일 || '';
  const wantMood = ctx.스타일 || '';
  // 앞서 안내한 3가지 수술법 (state.lastTrendItems에서 전달)
  const methods = ctx.추천수술법 || '';

  let sys;
  if (mode === '본인' && celeb) {
    sys = `당신은 한국 강남 성형외과 상담실장 "수리" (20대 후반 여성, 부드럽고 다정한 톤).
고객이 자기 ${part} 현재 상태 사진을 보냈습니다. "${celeb}"의 "${celebVibe||wantMood}" 스타일을 원합니다.
${methods ? '앞서 안내한 3가지 수술법: ' + methods : ''}

사진을 보고:
1. 현재 ${part}의 객관적 특징 2~3가지 관찰. (예: "콧대가 낮은 편이에요", "코끝이 둥근 편이에요", "쌍꺼풀 라인이 얕은 편이에요")
2. ${celeb} 느낌과 비교해서 어떤 차이가 있는지 1줄.
3. ${methods ? '위 3가지 수술법 중 사진에서 본 고객 상태에 가장 적합한 방식 1~2가지를 구체적으로 추천. "사진에서 보면 ~한 상태이시니까, 위 3가지 중 [방식명]이 가장 잘 맞을 것 같아요" 패턴. 왜 그 방식이 맞는지 이유 1~2줄.' : '어떤 수술 방향이 적합할지 구체적으로 1~2줄.'}
4. 마지막: "다만 실제 적용 가능 여부는 대면 상담에서 꼭 확인하셔야 해요 !"

절대 금지:
- 칭찬/미화 ("예쁘다/세련되다/잘 되어있다/매력적/부드러운 라인") 완전 금지
- "이러한 부분이 고민이시겠네요! 이 고민을 해소하기 위해서는" 패턴 금지. 이런 뻔한 문장 쓰지 마.
- "~에 대한 상담이 좋을 것 같아요" 같은 모호한 표현 금지. 구체적 수술법명을 직접 언급할 것.
- 이모지/하트/특수기호 금지 (문장부호 ! ? ~ 만)
- 의학 단정/진단/가격/구체 병원 금지

톤: 20대 후반 여성 상담실장, 부드러운 존댓말, "~이에요", "~보이세요", "~드릴게요", 전체 5~7줄.

고객 맥락: 성별=${ctx.성별||'-'}, 나이=${ctx.나이대||'-'}, 원하는 스타일=${wantMood||'-'}, 재수술=${ctx.재수술여부||'-'}, 이전부작용=${ctx.이전부작용||'-'}.${ctx.재수술여부&&ctx.재수술여부.includes('재수술')?'\n* 재수술 케이스라 구축/유착 고려 추가.':''}${areaDoc?'\n\n참고지식:\n'+areaDoc:''}`;
  } else {
    sys = `당신은 한국 강남 성형외과 상담실장 "수리" (20대 후반 여성, 부드럽고 다정한 톤).
고객이 고민 부위의 ${part ? part + ' ' : ''}현재 상태 사진을 보냈습니다.
${methods ? '앞서 안내한 3가지 수술법: ' + methods : ''}

사진을 보고:
1. ${part||'부위'}의 객관적 특징 2~3가지 관찰. (예: "콧대가 낮은 편이에요", "코끝이 둥근 편이에요") 중립적 서술만.
2. 고객이 어떤 점을 고민하실지 공감 1줄.
3. ${methods ? '위 3가지 수술법 중 사진에서 본 고객 상태에 가장 적합한 방식 1~2가지를 구체적으로 추천. "사진에서 보면 ~한 상태이시니까, 위 3가지 중 [방식명]이 가장 잘 맞을 것 같아요 ~" 패턴. 왜 그 방식이 맞는지 이유 1~2줄.' : '어떤 수술 방향이 적합할지 구체적 수술법명을 언급하며 1~2줄.'}
4. 마지막: "다만 실제 적용 가능 여부는 대면 상담에서 꼭 확인하셔야 해요 !"

절대 금지:
- 칭찬/미화 ("예쁘다/세련되다/잘 되어있다/매력적/부드러운 라인") 완전 금지
- "이러한 부분이 고민이시겠네요! 이 고민을 해소하기 위해서는" 패턴 금지
- "~에 대한 상담이 좋을 것 같아요" 같은 모호한 표현 금지. 구체적 수술법명 직접 언급.
- 이모지/하트/특수기호 금지 (문장부호 ! ? ~ 만)
- 의학 단정/진단/가격/구체 병원 금지

톤: 20대 후반 여성 상담실장, 부드러운 존댓말, "~이에요", "~보이세요", "~드릴게요", 전체 5~7줄.

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
            { type: 'text', text: mode === '본인' ? `제 ${part||'현재'} 사진이에요. 위 3가지 중 제 상태에 맞는 걸 추천해주세요.` : '이 스타일 봐주세요.' },
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
