import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBody, robotsAllows } from "../lab/article.js";
import { collapseDuplicates, pickEvents, removeRepeats, koreanUnits, latinNames, mergeEvents, missingNumbers, quoteFound, readingOrder, runLab, scoreEvent } from "../lab/pipeline.js";

const item = (id, source, title, extra = {}) => ({ id, source, title, desc: "", region: "domestic", url: `https://a.example/${id}`, publishedAt: Date.now(), ...extra });

test("같은 제목은 한 건으로 세고 복제 수를 남긴다", () => {
  const rows = collapseDuplicates([item(1, "A", "뉴욕증시 나스닥 5% 급락 마감"), item(2, "A", "뉴욕증시 나스닥 5% 급락 마감", { desc: "더 긴 설명" }), item(3, "B", "연준 금리 동결")]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].copies.length, 2);
  assert.equal(rows[0].desc, "더 긴 설명");
});

test("기사 수가 아니라 언론사 수로 점수를 낸다", () => {
  const one = (n, source) => ({ ...item(n, source, `t${n}`), copies: [item(n, source, `t${n}`)] });
  const many = scoreEvent({ impact: 3, items: [one(1, "A"), one(2, "A"), one(3, "A")] }, new Date());
  const spread = scoreEvent({ impact: 3, items: [one(1, "A"), one(2, "B"), one(3, "C")] }, new Date());
  assert.equal(many.outlets.length, 1);
  assert.equal(spread.outlets.length, 3);
  assert.ok(spread.score > many.score);
});

test("나뉜 사건을 합치면 기사는 겹치지 않고 언론사 수로 다시 점수를 낸다", () => {
  const one = (n, source) => ({ ...item(n, source, `t${n}`), copies: [item(n, source, `t${n}`)] });
  const events = [
    { title: "증시 급락", impact: 4, items: [one(1, "A"), one(2, "B")] },
    { title: "다른 일", impact: 4, items: [one(3, "C"), one(4, "D"), one(5, "E")] },
    { title: "국채로 이동", impact: 5, items: [one(2, "B"), one(6, "F")] },
  ];
  const merged = mergeEvents(events, [{ keep: 0, absorb: [2, 9, 0] }], new Date());
  assert.equal(merged.length, 2);
  const market = merged.find((event) => event.title === "증시 급락");
  assert.equal(market.items.length, 3);
  assert.equal(market.impact, 5);
  assert.deepEqual(market.merged, ["국채로 이동"]);
  assert.equal(merged[0].title, "증시 급락");
});

test("읽을 기사는 해외부터 고르고 언론사가 겹치지 않게 섞는다", () => {
  const order = readingOrder([item(1, "A", "a", { desc: "xxxx" }), item(2, "A", "b", { desc: "xxx" }), item(3, "B", "c", { region: "overseas", desc: "x" })]);
  assert.deepEqual(order.slice(0, 2).map((row) => row.source), ["B", "A"]);
});

test("영어 금액 단위를 코드로 바꾼다", () => {
  assert.equal(koreanUnits("3.2tn달러 이상"), "3조2000억달러 이상");
  assert.equal(koreanUnits("$2tn가 사라졌다"), "2조달러가 사라졌다");
  assert.equal(koreanUnits("$165 billion 규모"), "1650억달러 규모");
  assert.equal(koreanUnits("거의 1 million명"), "거의 100만명");
  assert.equal(koreanUnits("$4 billion in sales"), "40억달러 in sales");
  assert.equal(koreanUnits("주가는 $115.16였다"), "주가는 115.16달러였다");
  assert.equal(koreanUnits("3.2조달러 이상"), "3조2000억달러 이상");
  assert.equal(koreanUnits("5.5% 하락"), "5.5% 하락");
});

test("영어 이름만 찾고 굳어진 약어는 둔다", () => {
  assert.deepEqual(latinNames("SanDisk와 Micron이 AI 우려로 S&P 500과 PCE 지표에 12bp 영향"), ["SanDisk", "Micron"]);
});

test("근거에 없는 숫자를 찾아낸다", () => {
  const claims = [{ text: "나스닥이 5.5% 내렸다", quote: "fell 5.5%" }];
  assert.deepEqual(missingNumbers("나스닥이 5.5% 내렸어요", claims), []);
  assert.deepEqual(missingNumbers("나스닥이 6.5% 내렸어요", claims), ["6.5"]);
});

test("인용문은 본문에 실제로 있어야 한다", () => {
  const body = "연준은 이번 회의에서 기준금리를 동결했다고 밝혔다.";
  assert.equal(quoteFound("이번 회의에서 기준금리를 동결했다고 밝혔다", body), true);
  assert.equal(quoteFound("이번 회의에서 기준금리를 인하했다고 밝혔다", body), false);
});

test("따옴표 차이와 말줄임표로 줄인 인용도 본문에서 찾는다", () => {
  const body = 'He said "99%의 경우 공장을 짓지 않으면 관세를 내야 하기 때문"이라고 강조했다. 나스닥은 5.5% 내렸고 그 뒤로 시가총액 2조 달러가 사라졌다.';
  assert.equal(quoteFound("99%의 경우 공장을 짓지 않으면 관세를 내야 하기 때문이라고 강조했다.", body), true);
  assert.equal(quoteFound("나스닥은 5.5% 내렸고 ... 시가총액 2조 달러가 사라졌다", body), true);
  assert.equal(quoteFound("나스닥은 5.5% 내렸고 ... 시가총액 9조 달러가 사라졌다", body), false);
});

test("금지 경로는 열지 않는다", () => {
  const rules = "User-agent: *\nDisallow: /private\nAllow: /private/open\n\nUser-agent: GPTBot\nDisallow: /";
  assert.equal(robotsAllows(rules, "/news/1"), true);
  assert.equal(robotsAllows(rules, "/private/1"), false);
  assert.equal(robotsAllows(rules, "/private/open/1"), true);
});

test("언론사별 위치에서 본문만 뽑는다", () => {
  const text = "본문 문장입니다. ".repeat(40);
  const html = `<html><body><div id="articletxt"><p>${text}</p><aside>관련 기사</aside></div></body></html>`;
  const result = extractBody(html, "https://www.hankyung.com/article/1");
  assert.ok(result.text.includes("본문 문장"));
  assert.ok(!result.text.includes("관련 기사"));
});

test("틀린 문장은 고쳐서 다시 검사하고 고친 뒤에도 틀리면 뺀다", async () => {
  const body = "연준은 이번 회의에서 기준금리를 5.25%로 동결했다고 밝혔다. ".repeat(10);
  let verified = 0;
  const ask = async (stage, _, payload) => {
    if (stage === "group") return { events: [{ title: "금리 동결", ids: [1], impact: 5, reason: "r" }] };
    if (stage === "claims") return { claims: [
      { a: 1, text: "금리가 5.25%로 동결됐다", quote: "기준금리를 5.25%로 동결했다고 밝혔다", speaker: "연준", status: "확정" },
      { a: 1, text: "회의에서 결정됐다", quote: "연준은 이번 회의에서 기준금리를 5.25%로", speaker: "연준", status: "확정" },
    ] };
    if (stage === "write") return { title: "t", sentences: [{ text: "금리가 6%예요.", claims: ["a1-1"] }, { text: "금리가 7%예요.", claims: ["a1-1"] }], doubts: [] };
    if (stage === "fix") return { lines: [{ k: 0, text: "금리가 5.25%예요." }, { k: 1, text: "금리가 8%예요." }] };
    verified += 1;
    return { results: payload.lines.map(({ k }) => ({ k, ok: true })) };
  };
  const lab = await runLab({ items: [item(1, "A", "연준 기준금리 동결 결정")], ask, read: async () => ({ status: "ok", body }), now: new Date() });
  const [good, bad] = lab.results[0].card.lines;
  assert.equal(verified, 2);
  assert.equal(good.passed, true);
  assert.equal(good.before, "금리가 6%예요.");
  assert.equal(bad.passed, false);
});

test("영어 이름은 한글로 고치고 재검사에서 틀리면 원래 문장을 둔다", async () => {
  const body = "마이크론 주가가 17% 내렸고 샌디스크 주가는 22% 내렸다고 시장이 밝혔다. ".repeat(10);
  const ask = async (stage, _, payload) => {
    if (stage === "group") return { events: [{ title: "급락", ids: [1], impact: 5, reason: "r" }] };
    if (stage === "claims") return { claims: [
      { a: 1, text: "마이크론이 17% 내렸다", quote: "마이크론 주가가 17% 내렸고 샌디스크 주가는 22% 내렸다고", speaker: "시장", status: "확정" },
      { a: 1, text: "샌디스크가 22% 내렸다", quote: "샌디스크 주가는 22% 내렸다고 시장이 밝혔다", speaker: "시장", status: "확정" },
    ] };
    if (stage === "write") return { title: "t", sentences: [{ text: "Micron이 17% 내렸어요.", claims: ["a1-1"] }, { text: "SanDisk가 22% 내렸어요.", claims: ["a1-2"] }], doubts: [] };
    if (stage === "fix") return { lines: [{ k: 0, text: "마이크론이 17% 내렸어요." }, { k: 1, text: "샌디스크가 99% 내렸어요." }] };
    return { results: payload.lines.map(({ k }) => ({ k, ok: true })) };
  };
  const lab = await runLab({ items: [item(1, "A", "미국 증시 급락")], ask, read: async () => ({ status: "ok", body }), now: new Date() });
  const [first, second] = lab.results[0].card.lines;
  assert.equal(first.text, "마이크론이 17% 내렸어요.");
  assert.equal(first.passed, true);
  assert.equal(second.text, "SanDisk가 22% 내렸어요.");
  assert.equal(second.passed, true);
});

test("짚어볼 점은 물음이어야 하고 사건 이름이 검증에 전달된다", async () => {
  const body = "연준은 이번 회의에서 기준금리를 5.25%로 동결했다고 밝혔다. ".repeat(10);
  const seen = [];
  const ask = async (stage, _, payload) => {
    if (stage === "group") return { events: [{ title: "금리 동결", ids: [1], impact: 5, reason: "r" }] };
    if (stage === "claims") return { claims: [
      { a: 1, text: "금리가 5.25%로 동결됐다", quote: "기준금리를 5.25%로 동결했다고 밝혔다", speaker: "연준", status: "확정" },
      { a: 1, text: "회의에서 결정됐다", quote: "연준은 이번 회의에서 기준금리를 5.25%로", speaker: "연준", status: "확정" },
    ] };
    if (stage === "write") return { title: "t", sentences: [{ text: "금리가 5.25%예요.", claims: ["a1-1"] }], doubts: [{ text: "동결이 이어질까요?", claims: ["a1-1"] }, { text: "동결됐어요.", claims: ["a1-1"] }] };
    if (stage === "fix") return { lines: [{ k: 2, text: "" }] };
    seen.push(payload.event);
    return { results: payload.lines.map(({ k }) => ({ k, ok: true })) };
  };
  const lab = await runLab({ items: [item(1, "A", "연준 기준금리 동결 결정")], ask, read: async () => ({ status: "ok", body }), now: new Date() });
  const lines = lab.results[0].card.lines;
  assert.equal(lines[1].passed, true);
  assert.equal(lines[2].passed, false);
  assert.deepEqual(seen, ["금리 동결"]);
});

test("같은 주제는 가장 높은 순위 하나만 고르고 주제 없는 사건은 제한하지 않는다", () => {
  const events = [
    { title: "a", topic: "데이터센터" }, { title: "b", topic: "데이터 센터" }, { title: "c", topic: "관세" },
    { title: "d", topic: "" }, { title: "e", topic: "" }, { title: "f", topic: "연준" },
  ];
  assert.deepEqual(pickEvents(events, 4).map((row) => row.title), ["a", "c", "d", "e"]);
});

test("앞 카드와 되풀이되는 문장은 뒤 카드에서 빼고 첫 문장은 남긴다", () => {
  const line = (text, kind = "sentence") => ({ kind, text, passed: true });
  const results = [
    { card: { title: "앞", lines: [line("a"), line("b")] } },
    { card: { title: "뒤", lines: [line("c"), line("a"), line("d"), line("e")] } },
    { card: { title: "끝", lines: [line("f"), line("a"), line("b?", "doubt")] } },
  ];
  const trimmed = removeRepeats(results, [{ c: 0, k: 1 }, { c: 1, k: 0 }, { c: 1, k: 1 }, { c: 2, k: 1 }]);
  assert.equal(trimmed[0].card.lines.length, 2);
  assert.deepEqual(trimmed[1].card.lines.map((row) => row.text), ["c", "d", "e"]);
  assert.deepEqual(trimmed[1].card.removed.map((row) => row.text), ["a"]);
  assert.equal(trimmed[2].card, null);
  assert.equal(trimmed[2].repeated.title, "끝");
});

test("본문을 못 읽은 사건은 카드를 만들지 않고 나머지는 근거 없는 문장을 표시한다", async () => {
  const body = "연준은 이번 회의에서 기준금리를 5.25%로 동결했다고 밝혔다. ".repeat(10);
  const ask = async (stage) => {
    if (stage === "group") return { events: [{ title: "금리 동결", ids: [1, 2], impact: 5, reason: "r" }, { title: "다른 일", ids: [3], impact: 2, reason: "r" }] };
    if (stage === "claims") return { claims: [
      { a: 1, text: "금리가 5.25%로 동결됐다", quote: "기준금리를 5.25%로 동결했다고 밝혔다", speaker: "연준", status: "확정" },
      { a: 1, text: "회의에서 결정됐다", quote: "연준은 이번 회의에서 기준금리를 5.25%로", speaker: "연준", status: "확정" },
      { a: 1, text: "가짜 주장", quote: "본문에 전혀 없는 구절을 지어낸 경우입니다", speaker: "x", status: "확정" },
    ] };
    if (stage === "write") return { title: "금리 동결", sentences: [{ text: "금리가 5.25%예요.", claims: ["a1-1"] }, { text: "금리가 6%예요.", claims: ["a1-1"] }], doubts: [] };
    return { results: [{ k: 0, ok: true }, { k: 1, ok: true }] };
  };
  const read = async (url) => (url.endsWith("/3") ? { status: "blocked", body: "" } : { status: "ok", body });
  const lab = await runLab({
    items: [item(1, "A", "연준 기준금리 동결 결정"), item(2, "B", "파월 의장 기자회견 발언"), item(3, "C", "전혀 다른 소식 하나")],
    ask, read, now: new Date(),
  });
  const first = lab.results[0];
  assert.equal(first.dropped.length, 1);
  assert.equal(first.card.lines[0].passed, true);
  assert.equal(first.card.lines[1].passed, false);
  assert.equal(lab.results[1].card, null);
});
