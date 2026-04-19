# AI 성형상담 · 프로토타입

## 로컬 실행

### 1. API 키 세팅
`.env.example`을 `.env`로 복사하고 키 입력
```bash
cp .env.example .env
# OPENAI_API_KEY=sk-...
# (선택) NAVER_CLIENT_ID, NAVER_CLIENT_SECRET — 실제 병원 주소/전화까지 받으려면
```

### 2. 서버 실행
```bash
node server.js
```
- 포트: `http://127.0.0.1:5173`
- 모델: `gpt-4o-mini`

---

## Vercel 배포

### 1. Vercel 프로젝트 등록
- https://vercel.com/new
- GitHub `DongGeun-96/ai-` 레포 import
- Framework Preset: **Other**
- Build Command / Output Directory: 비워두기 (vercel.json이 처리)

### 2. 환경 변수 설정
Vercel 프로젝트 설정 → Environment Variables 에서 추가:
| Key | Value | 비고 |
|---|---|---|
| `OPENAI_API_KEY` | `sk-...` | 필수 |
| `OPENAI_MODEL` | `gpt-4o-mini` | 선택 (기본값) |
| `NAVER_CLIENT_ID` | `...` | 선택 (병원 정보) |
| `NAVER_CLIENT_SECRET` | `...` | 선택 |

### 3. Deploy
자동으로 빌드·배포되고, 다음 URL이 활성화됩니다:
- `https://<프로젝트명>.vercel.app/`
- `https://<프로젝트명>.vercel.app/api/chat`
- `https://<프로젝트명>.vercel.app/api/vision`
- `https://<프로젝트명>.vercel.app/api/yt?q=...`
- `https://<프로젝트명>.vercel.app/api/places?region=강남`

---

## 구조
```
.
├── index.html           # UI (단일 페이지)
├── server.js            # 로컬 개발용 Node 서버
├── api/                 # Vercel Serverless Functions
│   ├── _lib.js
│   ├── chat.js
│   ├── vision.js
│   ├── yt.js
│   └── places.js
├── knowledge/           # 부위별 전문 지식 (자동 주입)
│   ├── general/safety.md
│   └── surgery/{eye,nose,breast,lipo,contour}.md
├── package.json
├── vercel.json
└── .env.example
```

## STEP 플로우
1. 고민/관심 시술 자유 입력
2. 성별·나이·신경 쓰이는 포인트·스타일 (트렌드 카드 + 사진 업로드 Vision)
3. 병원 우선 조건 + 지역 선택
4. 공개 자료 기반 병원 안내 (네이버 Open API 또는 검색 페이지 폴백)
5. 추가 질문 (회복기간/비용/부작용/체크리스트)
6. 최종 요약

## 법적 포지션
- 가짜 병원 데이터 제거, 공개 자료 기반 **안내** (추천 아님)
- 예약 직접 연결 없음
- 수술 전후 사진 미사용
- AI 응답 가드레일 + 부위별 지식 자동 주입
