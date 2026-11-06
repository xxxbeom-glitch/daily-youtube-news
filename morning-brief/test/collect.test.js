import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, mergeItems, topicUrl } from "../lib/collect.js";
import { naverFeed, naverKeys, outletName, parseNaver } from "../lib/naver.js";
import { parseFeed } from "../lib/rss.js";

const googleFeed = { name: "구글", url: "https://news.google.com/rss/search?q=x", region: "overseas", lang: "en", use: "topic", card: "빅테크" };
const plainFeed = { name: "연합뉴스", url: "https://www.yna.co.kr/rss/news.xml", region: "domestic", lang: "ko", use: "general" };

test("구글 뉴스 항목은 언론사를 source 태그로 잡고 제목 끝 이름과 설명을 뺀다", () => {
  const [item] = parseFeed(`<rss><channel><item><title>Apple rises - Reuters</title><link>https://news.google.com/a</link>
    <pubDate>Thu, 05 Nov 2026 21:00:00 GMT</pubDate><description>&lt;a href="x"&gt;Apple rises&lt;/a&gt; Reuters</description>
    <source url="https://reuters.com">Reuters</source></item></channel></rss>`, googleFeed);
  assert.equal(item.title, "Apple rises");
  assert.equal(item.source, "Reuters");
  assert.equal(item.desc, "");
});

test("CDATA와 HTML을 벗긴 설명을 쓴다", () => {
  const [item] = parseFeed(`<item><title><![CDATA[제목 &amp; 부제]]></title><link>https://a.kr/1</link>
    <description><![CDATA[<p>설명 <b>본문</b></p>]]></description></item>`, plainFeed);
  assert.equal(item.title, "제목 & 부제");
  assert.equal(item.desc, "설명 본문");
  assert.equal(item.publishedAt, null);
});

test("주소가 같은 기사는 하나만 남기고 구간 밖 기사는 뺀다", () => {
  const now = new Date("2026-11-05T22:00:00Z");
  const since = new Date("2026-11-05T09:00:00Z");
  const base = { title: "t", desc: "", url: "https://a/1", source: "Reuters", publishedAt: now.getTime() - 1000, card: "빅테크", topic: "애플" };
  const merged = mergeItems([[base, { ...base, desc: "설명", card: "반도체", topic: "TSMC" }], [{ ...base, url: "https://a/2", publishedAt: since.getTime() - 1 }]], { now, since });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, "로이터");
  assert.equal(merged[0].desc, "설명");
  assert.deepEqual(merged[0].cards, ["빅테크", "반도체"]);
});

test("날짜 없는 항목은 수집 시각을 쓴다", () => {
  const now = new Date("2026-11-05T22:00:00Z");
  const merged = mergeItems([[{ title: "t", desc: "", url: "https://a/1", source: "s", publishedAt: null }]], { now, since: new Date(0) });
  assert.equal(merged[0].publishedAt, now.getTime());
});

test("피드 하나가 실패해도 계속하고 실패를 기록한다", async () => {
  const fetcher = async (url) => (url.includes("bad")
    ? new Response("", { status: 503 })
    : new Response("<item><title>t</title><link>https://a/1</link></item>"));
  const now = new Date();
  const { items, sourceErrors, healthyGeneral } = await collect({
    sources: [{ ...plainFeed, name: "좋음", url: "https://good" }, { ...plainFeed, name: "나쁨", url: "https://bad" }],
    topics: [], now, since: new Date(now.getTime() - 1000), fetcher,
  });
  assert.equal(items.length, 1);
  assert.equal(healthyGeneral, 1);
  assert.deepEqual(sourceErrors, [{ name: "나쁨", error: "HTTP 503" }]);
});

test("영어 주제 검색에는 다섯 언론사 조건을 붙인다", () => {
  const url = new URL(topicUrl({ query: "TSMC", lang: "en" }));
  assert.match(url.searchParams.get("q"), /site:reuters\.com OR .*site:ft\.com\) when:1d$/);
  assert.equal(url.searchParams.get("ceid"), "US:en");
  assert.equal(new URL(topicUrl({ query: "북한", lang: "ko" })).searchParams.get("q"), "북한 when:1d");
});

const naverBody = {
  items: [{
    title: "<b>코스피</b> 급락 &amp; 반등", originallink: "https://www.yna.co.kr/view/1", link: "https://n.news.naver.com/1",
    description: "<b>코스피</b>가 내렸어요", pubDate: "Thu, 05 Nov 2026 21:00:00 +0900",
  }],
};

test("네이버 결과는 태그를 벗기고 원문 주소로 언론사를 찾는다", () => {
  const [item] = parseNaver(naverBody, naverFeed({ name: "코스피", card: "기업 공통", query: "코스피" }));
  assert.equal(item.title, "코스피 급락 & 반등");
  assert.equal(item.desc, "코스피가 내렸어요");
  assert.equal(item.url, "https://www.yna.co.kr/view/1");
  assert.equal(item.source, "연합뉴스");
  assert.equal(item.via, "naver");
  assert.equal(outletName("https://biz.chosun.com/a"), "조선일보");
  assert.equal(outletName("https://www.example.kr/a"), "");
  const other = { items: [{ ...naverBody.items[0], originallink: "https://www.example.kr/1" }] };
  assert.equal(parseNaver(other, naverFeed({ name: "코스피", query: "코스피" })).length, 0);
});

test("키가 없으면 네이버를 호출하지 않는다", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return new Response("<item><title>t</title><link>https://a/1</link></item>");
  };
  const now = new Date();
  await collect({
    sources: [plainFeed], topics: [], naverTopics: [{ name: "n", card: "일반 뉴스", query: "q" }],
    now, since: new Date(now.getTime() - 1000), fetcher,
  });
  assert.equal(calls.length, 1);
  assert.equal(naverKeys({ NAVER_API_KEY_ID: "a" }), null);
  assert.deepEqual(naverKeys({ NAVER_API_KEY_ID: "a", NAVER_API_KEY: "b" }), { id: "a", secret: "b" });
});

test("네이버 호출은 키를 헤더로 보내고 실패해도 RSS는 계속한다", async () => {
  const now = new Date("2026-11-05T22:00:00Z");
  const seen = [];
  const fetcher = async (url, init) => {
    if (!url.includes("naverapihub")) return new Response("<item><title>t</title><link>https://a/1</link></item>");
    seen.push(init.headers);
    return url.includes("bad") ? new Response("", { status: 429 }) : Response.json(naverBody);
  };
  const { items, sourceErrors } = await collect({
    sources: [plainFeed], topics: [], fetcher, now, since: new Date(now.getTime() - 86400e3),
    naverKeys: { id: "id", secret: "secret" },
    naverTopics: [{ name: "좋음", card: "일반 뉴스", query: "q" }, { name: "나쁨", card: "일반 뉴스", query: "bad" }],
  });
  assert.equal(seen[0]["X-NCP-APIGW-API-KEY-ID"], "id");
  assert.equal(seen[0]["X-NCP-APIGW-API-KEY"], "secret");
  assert.equal(items.filter((i) => i.via === "naver").length, 1);
  assert.equal(items.length, 2);
  assert.deepEqual(sourceErrors, [{ name: "네이버 나쁨", error: "HTTP 429" }]);
});
