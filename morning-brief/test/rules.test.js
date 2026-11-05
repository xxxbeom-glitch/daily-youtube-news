import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isKospiCluster, kospiIsBigNews, kstDate, limitMarketCards, limitOverseas, marketWasOpen, normalizeBlocks,
  orderWithDiversity, pickSources, windowStart,
} from "../lib/rules.js";

const text = (n, end = "요.") => `${"가".repeat(n - end.length)}${end}`;

test("140자 이내 본문은 한 블록으로 합친다", () => {
  assert.deepEqual(normalizeBlocks(["짧은 첫 블록이에요.", "둘째 블록이에요."]), ["짧은 첫 블록이에요. 둘째 블록이에요."]);
});

test("60자 미만 둘째 블록은 앞 블록에 합친다", () => {
  const blocks = normalizeBlocks([text(100), text(30), text(100)]);
  assert.deepEqual(blocks.map((b) => b.length), [131, 100]);
});

test("합치면 140자를 넘을 때 문장 경계에서 다시 나눈다", () => {
  const blocks = normalizeBlocks([`${text(70)} ${text(69)}`, text(20)]);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.length <= 140));
  assert.ok(blocks[1].length >= 60);
});

test("어떤 블록도 140자를 넘지 않고 3블록을 넘지 않는다", () => {
  const blocks = normalizeBlocks([`${text(100)} ${text(90)}`, text(120), text(120), text(120)]);
  assert.ok(blocks.length <= 3);
  assert.ok(blocks.every((b) => b.length <= 140));
});

test("링크는 언론사 중복 없이 최대 5개이고 국내외를 섞는다", () => {
  const item = (source, region) => ({ source, region, url: `https://x/${source}` });
  const picked = pickSources([
    item("A", "overseas"), item("A", "overseas"), item("B", "overseas"), item("C", "overseas"), item("D", "overseas"),
    item("E", "overseas"), item("가", "domestic"), item("나", "domestic"),
  ]);
  assert.equal(picked.length, 5);
  assert.equal(new Set(picked.map((p) => p.name)).size, 5);
  assert.ok(picked.some((p) => p.name === "가"));
});

const evidence = (...sources) => sources.map((source) => ({ source, desc: "설명" }));

test("기업 카드는 최대 4장, 시황 구역은 최대 6장이고 언론사가 적은 기업부터 뺀다", () => {
  const majors = ["a", "b", "c", "d"];
  const cards = [
    { category: "미국 시황", items: evidence("a") },
    { category: "시장과 정치", items: evidence("a") },
    { category: "환율·원자재", items: evidence("a") },
    { category: "빅테크", items: evidence("a", "b", "c", "d") },
    { category: "반도체", items: evidence("a", "b", "c") },
    { category: "AI 기업", items: evidence("a", "b", "c") },
    { category: "빅테크", items: evidence("a") },
  ];
  const kept = limitMarketCards(cards, { marketOpen: true, majorOutlets: majors });
  assert.equal(kept.length, 6);
  assert.ok(!kept.includes(cards[6]));
});

test("3장째 기업 카드는 정해 둔 언론사 3곳 이상이어야 한다", () => {
  const cards = [
    { category: "빅테크", items: evidence("a", "b") },
    { category: "반도체", items: evidence("a", "b") },
    { category: "AI 기업", items: evidence("a", "x") },
  ];
  assert.equal(limitMarketCards(cards, { marketOpen: true, majorOutlets: ["a", "b"] }).length, 2);
});

test("휴장일에는 지수, 정치, 환율 카드를 빼고 기업 카드는 유지한다", () => {
  const cards = [{ category: "미국 시황", items: evidence("a") }, { category: "빅테크", items: evidence("a") }];
  assert.deepEqual(limitMarketCards(cards, { marketOpen: false, majorOutlets: [] }).map((c) => c.category), ["빅테크"]);
});

test("설명 없는 제목 2건은 시황 카드 근거가 되지 않는다", () => {
  const cards = [{ category: "미국 시황", items: [{ source: "a", desc: "" }, { source: "b", desc: "" }] }];
  assert.equal(limitMarketCards(cards, { marketOpen: true, majorOutlets: [] }).length, 0);
});

test("같은 분야가 3건 연속되지 않는다", () => {
  const ordered = orderWithDiversity(["국제", "국제", "국제", "경제"].map((category) => ({ category })));
  assert.deepEqual(ordered.map((c) => c.category), ["국제", "국제", "경제", "국제"]);
});

test("해외 카드는 최대 5장이다", () => {
  const list = Array.from({ length: 7 }, () => ({ scope: "overseas" }));
  assert.equal(limitOverseas([...list, { scope: "domestic" }]).length, 6);
});

test("코스피는 급락 제목 언론사 5곳 이상일 때만 큰 뉴스다", () => {
  const titles = (n) => Array.from({ length: n }, (_, i) => ({ source: `s${i}`, title: "코스피 급락 마감" }));
  assert.equal(kospiIsBigNews(titles(4)), false);
  assert.equal(kospiIsBigNews(titles(5)), true);
  assert.equal(isKospiCluster([{ title: "코스피 소폭 상승" }]), true);
  assert.equal(isKospiCluster([{ title: "북한 발사" }]), false);
});

test("날짜 계산은 KST 기준이다", () => {
  const now = new Date("2026-11-05T22:10:00Z");
  assert.equal(kstDate(now), "2026-11-06");
  assert.equal(windowStart(now).toISOString(), "2026-11-05T09:00:00.000Z");
});

test("일요일과 월요일 아침, 휴장일 다음 날은 시황이 없다", () => {
  const at = (day) => new Date(`${day}T07:10:00+09:00`);
  assert.equal(marketWasOpen(at("2026-11-06"), []), true);
  assert.equal(marketWasOpen(at("2026-11-08"), []), false);
  assert.equal(marketWasOpen(at("2026-11-09"), []), false);
  assert.equal(marketWasOpen(at("2026-11-27"), ["2026-11-26"]), false);
});
