# 미국 경제 수집·선별 보완 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공개 기사 목록으로 수집률을 높이고, AI 중요도 대신 언론사 편집 위치로 사건을 골라 카드 10장을 만든다.

**Architecture:** `lab/lists.js`가 공개 목록을, `lab/placements.js`가 편집 페이지의 기사 위치를 읽는다. `run.mjs`가 둘을 기존 수집에 합치고, `pipeline.js`는 위치와 언론사 수로 점수를 낸다. AI는 미국 경제 판정과 사건 묶기만 맡는다.

**Tech Stack:** Node 24, ES 모듈, cheerio, `node --test`, GitHub Actions, Vercel.

**Spec:** `docs/superpowers/specs/2026-11-06-us-economy-collection-design.md`

## Global Constraints

- 작업 폴더는 `D:\project\daily-youtube-news-lab`, 브랜치는 `lab/us-economy`다. `main`과 프로덕션 프로젝트 `morning-news-mockup`은 건드리지 않는다.
- 수집기 이름은 기존 `USER_AGENT`를 쓴다. 막히면 재시도나 우회 없이 건너뛴다. 유료벽, 로그인, 위장, 네이버 뉴스 페이지 크롤링은 금지다.
- 기사 본문과 결과는 커밋하지 않는다. 공개 로그에는 개수만 남긴다.
- 페이지 접속 사이에는 기존 `READ_GAP_MS`(1000ms)를 둔다.
- `lab-site`를 바꿔 재배포할 때는 `rootDirectory`를 `lab-site`로 넣는다.

## Review Focus

- 목록이나 페이지 하나가 실패하거나 구조가 바뀌어도 실행은 끝까지 가고, 실패가 개수로 기록된다.
- 페이지 위쪽의 기사가 수집 창 밖이면 점수에 쓰지 않는다.
- 같은 기사의 주소가 `?` 추적값이나 끝 `/`만 다를 때 한 기사로 합친다.
- 목록 기사는 소개글이 비어 있어도 묶기와 본문 읽기가 동작한다.
- 뉴스가 적어 후보가 10개보다 적으면 있는 만큼만 카드를 낸다.

---

### Task 1: 공개 기사 목록 수집

**Files:**
- Create: `morning-brief/lab/lists.js`
- Modify: `morning-brief/lab/sources.json`, `morning-brief/lab/run.mjs`
- Test: `morning-brief/test/lists.test.js`

**Interfaces:**
- Produces: `parseSitemap(xml, outlet) -> item[]`, `usCandidate(item) -> boolean`, `articleKey(url) -> string`
- `item`은 기존 수집 기사와 같은 모양이다: `{ title, desc: "", url, source, region, lang, via: "list", publishedAt }`

- [ ] **Step 1: 실패하는 테스트 작성**

테스트: `news:`와 `n:` 접두어를 모두 읽는다, CDATA와 `&amp;`를 푼다, 제목이나 주소가 없는 항목은 뺀다, `usCandidate`는 "美 10월 고용"과 "Nasdaq futures"를 통과시키고 "코스피 급락"을 뺀다, `articleKey`는 `https://www.mk.co.kr/news/world/1/?a=1`과 `https://mk.co.kr/news/world/1`을 같게 만든다.

- [ ] **Step 2: `npm test`로 실패 확인**

- [ ] **Step 3: `lists.js` 구현과 `sources.json`에 `lists` 추가**

주소: 매경 `https://www.mk.co.kr/sitemap/latest-articles/`, 한경 `https://www.hankyung.com/sitemap/latest-article.xml`, CNBC `https://www.cnbc.com/sitemap_news.xml`, 가디언 `https://www.theguardian.com/sitemaps/news.xml`. 단어 목록은 측정에 쓴 국문, 영문 정규식을 쓴다.

- [ ] **Step 4: `collectAll`에 목록을 합치기**

`byUrl`의 키를 `articleKey`로 바꾸고, RSS와 네이버 뒤에 목록 후보를 더한다. 소개글이 있는 기존 기사를 덮어쓰지 않는다. `log`에 `{ name, via: "목록", received, kept }`를 남긴다.

- [ ] **Step 5: `npm test` 통과 확인 후 커밋**

### Task 2: 편집 위치 읽기

**Files:**
- Create: `morning-brief/lab/placements.js`
- Modify: `morning-brief/lab/sources.json`, `morning-brief/lab/run.mjs`
- Test: `morning-brief/test/placements.test.js`

**Interfaces:**
- Consumes: `articleKey(url)`, `robotsAllows(text, path)`
- Produces: `parsePlacements(html, page) -> [{ key, outlet, tier }]`, `tier`는 `"top"` 또는 `"major"`. `mergePlacements(items, placements) -> items`는 기사에 `placement: { top: [outlet], major: [outlet] }`을 단다.

- [ ] **Step 1: 실패하는 테스트 작성**

테스트: 매경은 `data-section="sub-top"`이 top, `주요기사`가 major이고 `많이 본 기사`와 `최신기사`는 무시한다. 위치형 페이지는 기사 링크 순서대로 1~5위가 top, 6~12위가 major다. 같은 기사가 두 칸에 있으면 높은 등급만 남는다. 주소에 `#`이 붙은 안내 링크는 뺀다.

- [ ] **Step 2: `npm test`로 실패 확인**

- [ ] **Step 3: `placements.js` 구현과 `sources.json`에 `pages` 추가**

페이지: 매경 `/news/world`, `/news/stock`(`mode: "labels"`), 한경 `/globalmarket`, CNBC `/economy/`, `/markets/`, 가디언 `/us/business`(`mode: "order"`). 기사 주소 패턴은 페이지 설정에 둔다.

- [ ] **Step 4: `run.mjs`에서 페이지 읽기**

각 페이지 전에 해당 사이트 robots를 확인하고, 막히거나 실패하면 그 페이지만 건너뛴다. 수집 창 안의 기사에만 위치를 단다. 위치가 있는 기사가 수집되지 않았다면 페이지 제목으로 기사를 더하지 않는다. 로그에 페이지별 개수를 남긴다.

- [ ] **Step 5: `npm test` 통과 확인 후 커밋**

### Task 3: AI 중요도 빼고 점수 바꾸기

**Files:**
- Modify: `morning-brief/lab/pipeline.js`, `morning-brief/lab/prompts.js`, `morning-brief/lab/run.mjs`, `lab-site/public/index.html`
- Test: `morning-brief/test/lab.test.js`

**Interfaces:**
- Consumes: 기사의 `placement`
- Produces: `scoreEvent(event, now) -> { outlets, parts, score }`, `parts`는 `{ top, major, outlets, bothRegions, fresh }`

- [ ] **Step 1: 테스트 수정과 추가**

점수: top에 올린 언론사 한 곳당 15점, major만 올린 언론사 한 곳당 8점, 다룬 언론사 한 곳당 6점, 국내외 동시 보도 10점, 6시간 이내 3점. 한 언론사는 top과 major에서 한 번만 센다. 동점은 top 곳 수, 기사 수, 최신 시각, 제목 순서로 정한다. 같은 입력의 순서를 바꿔도 순위가 같아야 한다.

- [ ] **Step 2: `npm test`로 실패 확인**

- [ ] **Step 3: 구현**

`GROUP`에서 impact 항목과 판단 기준을 지우고 `event.impact` 사용을 없앤다. `mergeEvents`의 impact 처리도 지운다. `MERGE_POOL`을 20으로 올린다. 시험 페이지의 영향도 열을 편집 위치 곳 수로 바꾼다. 기존 화면 디자인은 유지한다.

- [ ] **Step 4: `npm test` 통과 확인 후 커밋**

### Task 4: 카드 10장 규칙과 읽기 규칙

**Files:**
- Modify: `morning-brief/lab/pipeline.js`, `morning-brief/lab/prompts.js`, `morning-brief/lab/run.mjs`
- Test: `morning-brief/test/lab.test.js`

**Interfaces:**
- Produces: `pickEvents(events, limit = CANDIDATES, perTopic = 2)`, `MAX_CARDS = 10`, `CANDIDATES = 14`

- [ ] **Step 1: 테스트 수정과 추가**

테스트: 같은 주제는 2개까지 고른다. 후보 14개 중 카드가 실패하면 다음 순위가 채워지고 결과 카드는 최대 10장이다. 후보가 7개면 7장만 낸다. 해외 기사가 있으면 읽기 3건에 1건 이상 들어간다. `removeRepeats`는 `kind`가 `doubt`인 문장을 지우지 않는다.

- [ ] **Step 2: `npm test`로 실패 확인**

- [ ] **Step 3: 구현**

후보 14개를 읽고 카드를 쓴 뒤, 중복 제거 후 살아남은 카드의 앞쪽 10장만 남긴다. `OVERLAP` 지시문에서 doubt를 고르지 않게 하고 코드에서도 막는다.

- [ ] **Step 4: `npm test` 통과 확인 후 커밋**

### Task 5: 시험 실행과 합격선 확인

**Files:**
- Modify: `morning-brief/lab/run.mjs` (개수 로그만)

- [ ] **Step 1: 로그에 개수 추가**

언론사별 수집 수, 목록 후보 수, 편집 위치가 붙은 기사 수, 페이지 실패 수를 남긴다.

- [ ] **Step 2: `lab/us-economy`에 푸시하고 실행 결과 확인**

성공 기준: 실행이 끝나고 업로드 성공, 페이지 실패가 기록됨, 카드 수 확인.

- [ ] **Step 3: 수집률 측정**

공개 목록의 미국 경제 기사를 표본으로 사람이 판정해, 필터를 통과한 비율이 언론사별 90% 이상인지 본다.

- [ ] **Step 4: 재현성 측정**

같은 수집 결과로 두 번 돌려 상위 10개 사건 중 8개 이상 같은지 본다. 이 측정에 필요한 입력 저장은 공개 저장소가 아니라 시험 사이트 비공개 저장소에만 둔다.

- [ ] **Step 5: `lab-site`가 바뀌었으면 `rootDirectory`를 `lab-site`로 재배포하고 사용자가 시험 사이트에서 확인**
