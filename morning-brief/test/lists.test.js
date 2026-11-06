import assert from "node:assert/strict";
import { test } from "node:test";
import { articleKey, countSummary, parseSitemap, usCandidate } from "../lab/lists.js";

const outlet = { name: "CNBC", region: "overseas", lang: "en" };

test("공개 목록의 두 가지 표기를 모두 읽고 글자를 푼다", () => {
  const xml = `<urlset>
    <url><loc>https://a.example/1</loc><n:news><n:title>Fed &amp; stocks</n:title><n:publication_date>2026-11-06T08:35:23-04:00</n:publication_date></n:news></url>
    <url><loc>https://a.example/2</loc><news:news><news:publication_date>2026-11-06T22:40:05+09:00</news:publication_date><news:title><![CDATA[美 고용 증가]]></news:title></news:news></url>
    <url><loc>https://a.example/3</loc></url>
  </urlset>`;
  const rows = parseSitemap(xml, outlet);
  assert.deepEqual(rows.map((row) => row.title), ["Fed & stocks", "美 고용 증가"]);
  assert.equal(rows[0].publishedAt, new Date("2026-11-06T12:35:23Z").getTime());
  assert.deepEqual([rows[0].source, rows[0].region, rows[0].lang, rows[0].via, rows[0].desc], ["CNBC", "overseas", "en", "list", ""]);
});

test("제목으로 미국 경제 후보만 남긴다", () => {
  assert.equal(usCandidate({ title: "美 10월 고용 깜짝 증가" }), true);
  assert.equal(usCandidate({ title: "Nasdaq futures rebound" }), true);
  assert.equal(usCandidate({ title: "코스피 6% 급락" }), false);
});

test("추적값과 끝 슬래시가 달라도 같은 기사로 본다", () => {
  assert.equal(articleKey("https://www.mk.co.kr/news/world/1/?a=1"), articleKey("https://mk.co.kr/news/world/1"));
  assert.notEqual(articleKey("https://mk.co.kr/news/world/1"), articleKey("https://mk.co.kr/news/world/2"));
});

test("언론사별 수집 수와 목록 후보, 편집 위치, 페이지 실패를 개수로 센다", () => {
  const items = [
    { source: "CNBC", title: "비밀 제목", placement: { top: ["CNBC"], major: [] } },
    { source: "CNBC", title: "다른 제목", placement: { top: [], major: [] } },
    { source: "매일경제", title: "제목", placement: { top: [], major: ["매일경제"] } },
  ];
  const log = [
    { name: "CNBC", via: "목록", received: 90, kept: 7 },
    { name: "매일경제", via: "목록", received: 50, kept: 4 },
    { name: "한국경제", via: "목록", error: "HTTP 500" },
    { name: "CNBC", via: "편집 위치", status: "ok", received: 12 },
    { name: "가디언", via: "편집 위치", status: "failed", error: "timeout" },
    { name: "매일경제", via: "편집 위치", status: "robots" },
  ];
  assert.deepEqual(countSummary(items, log), { outlets: { CNBC: 2, 매일경제: 1 }, listCandidates: 11, placed: 2, pageFailures: 2, only: {} });
});

test("제목 맨 앞의 대문자 단어도 후보로 본다", () => {
  for (const title of ["Stocks slide on weak data", "Inflation cooled last month", "Tariffs hit importers", "Earnings beat forecasts", "Unemployment claims jump", "Payrolls rose in May"]) {
    assert.equal(usCandidate({ title }), true, title);
  }
  assert.equal(usCandidate({ title: "Tell us about livestock" }), false);
});

test("한 경로로만 들어온 기사 수를 경로별로 센다", () => {
  const placement = { top: [], major: [] };
  const items = [{ source: "A", placement, routes: ["rss"] }, { source: "A", placement, routes: ["rss", "list"] }, { source: "B", placement, routes: ["list"] }, { source: "B", placement, routes: ["rss"] }];
  assert.deepEqual(countSummary(items, []).only, { rss: 2, list: 1 });
});
