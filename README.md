# AI 성형상담 · 시안 (로컬 실행)

## 1. API 키 세팅
`.env.example`을 `.env`로 복사하고 키를 입력해 주세요.

```bash
cp .env.example .env
# .env 파일 열어서 OPENAI_API_KEY 채우기
```

## 2. 서버 실행
```bash
node server.js
```

기본 포트: `http://127.0.0.1:5173`
모델: `gpt-4o-mini` (원하면 `.env`의 `OPENAI_MODEL`로 바꿀 수 있어요)

## 3. 구조
- `index.html` — UI + 6단계 플로우 + Orb 애니메이션
- `server.js` — 로컬 Node 프록시 (OpenAI API 호출, 키 숨김)
- `.env` — OPENAI_API_KEY (커밋 금지)

## 4. STEP 플로우
1. 고민/관심 시술 자유 입력
2. AI 추가 질문 (신경 쓰이는 포인트, 회복 기간, 분위기)
3. 정보 제공 + 지역 선택 → 병원 8곳 추천
4. 병원 8곳 리스트 (순위 없음, 후기 기반 장점)
5. 2차 질문 (비용/부작용/다른 지역/체크리스트)
6. 최종 요약 + 연락처 + 교통 루트 (예약 직접 연결 없음)

AI 응답은 `/api/chat` 엔드포인트를 통해 STEP 번호와 사용자 컨텍스트를 함께 전달해요.
