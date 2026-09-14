# Daily YouTube News

매일 오전 09:00 KST에 JTBC News와 KBS News에서 전날 18:00~당일 09:00 사이 업로드된 일반 뉴스 클립을 수집하고, 2~5분 길이의 영상 중 사용자 관심 분야를 10~15개 선별해 비공개 YouTube 플레이리스트를 만드는 Vercel Cron 프로젝트입니다.

## 뉴스 기준

포함:
- 사회 이슈
- 국내외 경제
- 주요 사건·사고/재난/범죄
- 감염병·공중보건
- 실생활·경제·건강·안전에 영향이 큰 정부 정책
- 국제 정세·안보: 전쟁, 테러, 제재, 관세, 군사 충돌, 호르무즈 등

제외:
- 단순 정당 정치/선거 공방/지지율
- 연예
- 스포츠
- 사소한 지역 단신
- Shorts
- 2분 미만 또는 5분 초과 영상

## 환경 변수

`.env.example` 참고. 비밀값은 GitHub에 커밋하지 말고 Vercel Environment Variables에만 저장합니다.

필수:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`
- `CRON_SECRET`

권장:
- `OPENAI_API_KEY` — 없으면 키워드 기반 fallback으로 동작
- `OPENAI_MODEL`
- `SETUP_SECRET` — OAuth 설정 URL 보호
- `STATUS_SECRET` — 상태 조회 URL 보호

## Google OAuth redirect URI

프로덕션 도메인이 `https://YOUR-PROJECT.vercel.app` 라면 Google Cloud OAuth 클라이언트에 아래 URI를 추가합니다.

`https://YOUR-PROJECT.vercel.app/api/auth/callback`

그 다음 브라우저에서:

`https://YOUR-PROJECT.vercel.app/api/auth/start?setup=SETUP_SECRET`

을 열어 Google 계정에 권한을 부여합니다. 콜백 화면에 표시되는 refresh token은 채팅이나 GitHub에 올리지 말고 Vercel의 `YOUTUBE_REFRESH_TOKEN` 환경 변수에 저장합니다.

## Cron

`vercel.json`은 `0 0 * * *` (UTC)로 설정되어 있으며 한국 시간으로 매일 09:00입니다.

Cron 요청은 `CRON_SECRET` Bearer 인증을 확인합니다.

## 배포

GitHub 저장소의 `main` 브랜치는 Vercel 프로젝트와 연결되어 있으며, 이후 커밋은 자동으로 배포됩니다.

## 상태 확인

`GET /api/status?token=STATUS_SECRET`

오늘 플레이리스트가 준비되었으면 비공개 플레이리스트 URL과 영상 개수를 반환합니다.
