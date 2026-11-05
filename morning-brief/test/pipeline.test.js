import assert from "node:assert/strict";
import { test } from "node:test";
import { applyVerification, buildBriefing } from "../lib/pipeline.js";

const NOW = new Date("2026-11-05T22:10:00Z");

function makeItems(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1, title: `기사 ${i + 1}`, desc: "설명이 있는 기사", url: `https://a/${i + 1}`, source: `언론${i + 1}`,
    region: "domestic", use: "general", cards: ["일반 뉴스"], topics: [], publishedAt: NOW.getTime(),
  }));
}

function fakeAsk({ market = [], clusters = 10, reject = [], failMarket = false, scope = "domestic" } = {}) {
  const calls = [];
  const ask = async (stage, _instructions, payload) => {
    calls.push({ stage, payload });
    if (stage === "market") {
      if (failMarket) throw new Error("market down");
      return { cards: market };
    }
    if (stage === "select") {
      const rows = payload.items.slice(0, clusters);
      return { clusters: rows.map((row, i) => ({ ids: [row.n], category: i % 2 ? "국제" : "경제", importance: 90 - i, scope })) };
    }
    if (stage === "write") {
      return {
        cards: payload.clusters.map((c) => ({ k: c.k, title: `카드 ${c.k}`, blocks: ["첫 블록이에요."] })),
        headlines: payload.rest.map((c) => ({ k: c.k, title: `제목 ${c.k}` })),
      };
    }
    if (stage === "retitle") return { titles: payload.cards.map((c) => ({ k: c.k, title: "줄인 제목" })) };
    if (stage === "verify") return { results: payload.cards.map((c) => ({ k: c.k, firstOk: !reject.includes(c.title), badBlocks: [] })) };
    throw new Error(`unexpected ${stage}`);
  };
  return { ask, calls };
}

const run = (items, options) => {
  const fake = fakeAsk(options);
  return buildBriefing({ items, sourceErrors: [], marketOpen: true, majorOutlets: [], ask: fake.ask, now: NOW })
    .then((brief) => ({ brief, calls: fake.calls }));
};

test("시황 뒤에 일반 뉴스를 붙여 12장을 만들고 쓴 기사는 일반에서 뺀다", async () => {
  const market = [{ category: "미국 시황", title: "뉴욕증시 상승", blocks: ["올랐어요."], ids: [1] }];
  const { brief, calls } = await run(makeItems(30), { market, clusters: 20 });
  assert.equal(brief.date, "2026-11-06");
  assert.equal(brief.cards.length, 12);
  assert.equal(brief.cards[0].section, "market");
  assert.equal(brief.cards.filter((c) => c.section === "news").length, 11);
  const select = calls.find((c) => c.stage === "select");
  assert.ok(!select.payload.items.some((row) => row.n === 1));
});

test("시황 단계가 실패해도 일반 뉴스로 계속한다", async () => {
  const { brief } = await run(makeItems(30), { failMarket: true, clusters: 20 });
  assert.equal(brief.cards.length, 12);
  assert.ok(brief.cards.every((c) => c.section === "news"));
});

test("일반 카드가 6건 미만이면 실패한다", async () => {
  await assert.rejects(run(makeItems(30), { clusters: 5 }), /Only 5 news cards/);
});

test("검증에서 떨어진 카드는 빠지고 예비 카드가 채운다", async () => {
  const { brief } = await run(makeItems(30), { clusters: 20, reject: ["카드 0", "카드 1"] });
  assert.equal(brief.cards.length, 12);
  assert.ok(!brief.cards.some((c) => c.title === "카드 0"));
  assert.ok(!brief.headlines.some((h) => h.title === "카드 0"));
});

test("20자가 넘는 제목은 다시 쓴다", async () => {
  const market = [{ category: "미국 시황", title: "가".repeat(25), blocks: ["올랐어요."], ids: [1] }];
  const { brief, calls } = await run(makeItems(30), { market, clusters: 20 });
  assert.equal(brief.cards[0].title, "줄인 제목");
  assert.equal(calls.filter((c) => c.stage === "retitle").length, 1);
});

test("설명 없는 묶음은 카드가 아니라 제목 목록으로 간다", async () => {
  const items = makeItems(30).map((item, i) => (i < 3 ? { ...item, desc: "" } : item));
  const { brief, calls } = await run(items, { clusters: 20 });
  const written = calls.find((c) => c.stage === "write").payload;
  assert.ok(written.clusters.every((c) => c.items.every((i) => i.d)));
  assert.ok(brief.headlines.some((h) => h.url === "https://a/1"));
});

test("해외 카드는 5장까지만 나온다", async () => {
  await assert.rejects(run(makeItems(30), { clusters: 20, scope: "overseas" }), /Only 5 news cards/);
});

test("출처는 실제 수집 기사에서만 나온다", async () => {
  const market = [{ category: "미국 시황", title: "상승", blocks: ["올랐어요."], ids: [1, 9999] }];
  const { brief } = await run(makeItems(30), { market, clusters: 20 });
  assert.deepEqual(brief.cards[0].sources, [{ name: "언론1", url: "https://a/1" }]);
});

test("뒤 블록만 틀리면 그 블록을 빼고 합치기를 다시 적용한다", () => {
  const long = "가".repeat(120);
  const cards = [{ title: "t", blocks: [`${long}요.`, `${long}다.`, `${long}까.`] }, { title: "u", blocks: ["맞아요."] }];
  const passed = applyVerification(cards, [{ k: 0, firstOk: true, badBlocks: [1] }]);
  assert.equal(passed.length, 1);
  assert.deepEqual(passed[0].blocks, [`${long}요.`, `${long}까.`]);
});
