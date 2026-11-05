import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, mergeItems, topicUrl } from "../lib/collect.js";
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
