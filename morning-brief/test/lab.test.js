import { ATTACH, GROUP } from "../lab/prompts.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBody, robotsAllows } from "../lab/article.js";
import { capCards, collapseDuplicates, pickEvents, removeRepeats, koreanUnits, latinNames, mergeEvents, missingNumbers, quoteFound, qualitySummary, readingOrder, runLab, scoreEvent, solidCard } from "../lab/pipeline.js";

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
  assert.deepEqual(market.merged, ["국채로 이동"]);
});

test("언론사가 윗칸에 올린 곳 수를 가장 크게 본다", () => {
  const placed = (n, source, placement) => ({ ...item(n, source, `t${n}`), copies: [item(n, source, `t${n}`, { placement })] });
  const old = new Date(Date.now() + 24 * 3600e3);
  const parts = scoreEvent({ items: [
    placed(1, "A", { top: ["A"], major: [] }),
    placed(2, "B", { top: [], major: ["B"] }),
    placed(3, "A", { top: [], major: ["A"] }),
  ] }, old).parts;
  assert.deepEqual(parts, { top: 15, major: 8, outlets: 12, bothRegions: 0, fresh: 0 });
});

test("점수가 같으면 입력 순서와 관계없이 같은 순위가 나온다", () => {
  const row = (n, source, title, publishedAt) => ({ title, items: [{ ...item(n, source, title, { publishedAt }), copies: [item(n, source, title, { publishedAt })] }] });
  const now = new Date();
  const time = now.getTime() - 3600e3;
  const events = [row(1, "A", "나 사건", time), row(2, "B", "가 사건", time), row(3, "C", "다 사건", time + 1000)];
  const titles = (list) => mergeEvents(list, [], now).map((event) => event.title);
  assert.deepEqual(titles(events), ["다 사건", "가 사건", "나 사건"]);
  assert.deepEqual(titles([...events].reverse()), ["다 사건", "가 사건", "나 사건"]);
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
  assert.equal(koreanUnits("1000만 gallons의 물"), "1000만 갤런의 물");
  assert.equal(koreanUnits("1,100 basis points를 넘었다"), "1,100 베이시스포인트를 넘었다");
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

test("같은 주제는 두 개까지 고르고 주제 없는 사건은 제한하지 않는다", () => {
  const events = [
    { title: "a", topic: "데이터센터" }, { title: "b", topic: "데이터 센터" }, { title: "c", topic: "데이터센터" },
    { title: "d", topic: "" }, { title: "e", topic: "" }, { title: "f", topic: "연준" },
  ];
  assert.deepEqual(pickEvents(events, 4).map((row) => row.title), ["a", "b", "d", "e"]);
});

const goodCard = (title) => ({ title, lines: [{ kind: "sentence", passed: true }, { kind: "sentence", passed: true }] });

test("카드는 앞에서부터 정해진 수까지만 남기고 실패한 사건은 다음 순위가 채운다", () => {
  const rows = [{ card: goodCard("1") }, { card: null }, { card: goodCard("2") }, { card: goodCard("3") }];
  assert.deepEqual(capCards(rows, 2).filter((row) => row.card).map((row) => row.card.title), ["1", "2"]);
  assert.equal(capCards(rows.slice(0, 2), 10).filter((row) => row.card).length, 1);
});

test("통과한 문장이 두 개 안 되는 카드는 자리를 차지하지 않는다", () => {
  const thin = { title: "얕음", lines: [{ kind: "sentence", passed: true }, { kind: "sentence", passed: false }, { kind: "doubt", passed: true }] };
  const rows = [{ card: thin }, { card: goodCard("1") }, { card: goodCard("2") }];
  assert.equal(solidCard(thin), false);
  assert.deepEqual(capCards(rows, 2).map((row) => row.card.title), ["얕음", "1", "2"]);
});

test("짚어볼 점은 되풀이 판정이 나와도 지우지 않는다", () => {
  const line = (text, kind = "sentence") => ({ kind, text, passed: true });
  const results = [
    { card: { title: "앞", lines: [line("a")] } },
    { card: { title: "뒤", lines: [line("b"), line("c"), line("d"), line("e?", "doubt")] } },
  ];
  const trimmed = removeRepeats(results, [{ c: 1, k: 3 }, { c: 1, k: 1 }]);
  assert.deepEqual(trimmed[1].card.lines.map((row) => row.text), ["b", "d", "e?"]);
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

const body = "연준은 이번 회의에서 기준금리를 5.25%로 동결했다고 밝혔다. ".repeat(10);
const flow = (fail) => async (stage, _, payload) => {
  if (fail(stage, payload)) throw new Error("AI 실패");
  if (stage === "group") return { events: [{ title: "금리 동결", ids: [1], reason: "r" }, { title: "고용 지표", ids: [2], reason: "r" }, { title: "관세 발표", ids: [3], reason: "r" }] };
  if (stage === "claims") return { claims: [
    { a: 1, text: "금리가 5.25%로 동결됐다", quote: "기준금리를 5.25%로 동결했다고 밝혔다", speaker: "연준", status: "확정" },
    { a: 1, text: "회의에서 결정됐다", quote: "연준은 이번 회의에서 기준금리를 5.25%로", speaker: "연준", status: "확정" },
  ] };
  if (stage === "write") return { title: "카드", sentences: [{ text: "금리가 5.25%예요.", claims: ["a1-1"] }, { text: "회의에서 정했어요.", claims: ["a1-2"] }], doubts: [] };
  if (stage === "verify") return { results: [{ k: 0, ok: true }, { k: 1, ok: true }] };
  return {};
};
const items = () => [item(1, "A", "연준 기준금리 동결"), item(2, "B", "미국 고용 지표 발표"), item(3, "C", "트럼프 관세 발표")];
const run = (ask) => runLab({ items: items(), ask, read: async () => ({ status: "ok", body }), now: new Date() });

test("한 사건의 AI 호출이 실패해도 나머지 카드는 만든다", async () => {
  const lab = await run(flow((stage, payload) => stage === "claims" && payload.event === "고용 지표"));
  assert.equal(lab.results.filter((row) => row.card).length, 2);
  const failed = lab.results.find((row) => row.event.title === "고용 지표");
  assert.equal(failed.card, null);
  assert.deepEqual(failed.claims, []);
});

test("합치기와 되풀이 점검이 실패해도 카드는 그대로 나온다", async () => {
  const lab = await run(flow((stage) => stage === "merge" || stage === "overlap"));
  assert.equal(lab.results.filter((row) => row.card).length, 3);
});

test("사건 묶기가 실패하면 실행을 멈춘다", async () => {
  await assert.rejects(run(flow((stage) => stage === "group")), /AI 실패/);
});

test("품질 요약은 개수와 기사 주소 지문만 담고 글자는 담지 않는다", () => {
  const row = (title, lines, urls) => ({ event: { outlets: urls.length === 1 ? ["A"] : ["A", "B"], items: urls.map((url) => ({ url })) }, card: { title, lines } });
  const good = [{ kind: "sentence", passed: true, text: "비밀 문장이에요." }, { kind: "sentence", passed: true, text: "Powell 발언이에요." }, { kind: "doubt", passed: true, text: "정말일까요?" }];
  const thin = [{ kind: "sentence", passed: true, text: "하나" }, { kind: "sentence", passed: false, text: "둘" }];
  const results = [row("카드", good, ["https://a.example/1", "https://b.example/2"]), row("얕음", thin, ["https://a.example/3"]), { event: { outlets: [], items: [] }, card: null }];
  const summary = qualitySummary(results, { flags: [{ c: 0, issue: "shallow" }, { c: 0, issue: "shallow" }, { c: 0, issue: "지어낸 문구" }] });
  assert.equal(summary.cards, 1);
  assert.equal(summary.thin, 1);
  assert.equal(summary.noCard, 1);
  assert.equal(summary.oneOutlet, 0);
  assert.equal(summary.failedLines, 1);
  assert.equal(summary.doubts, 1);
  assert.equal(summary.english, 1);
  assert.deepEqual(summary.flags, { shallow: 2, other: 1 });
  assert.equal(summary.ranks[0].length, 2);
  assert.match(summary.ranks[0][0], /^[0-9a-f]{8}$/);
  assert.equal(JSON.stringify(summary).includes("비밀"), false);
});

test("품질 요약은 표시된 카드 번호를 남기되 AI가 쓴 글자는 남기지 않는다", () => {
  const review = { flags: [{ c: 5, issue: "korea" }, { c: "2", issue: "지어낸 문구" }, { c: "비밀 제목", issue: "shallow" }] };
  const summary = qualitySummary([], review);
  assert.deepEqual(summary.flagged, [[5, "korea"], [2, "other"]]);
  assert.equal(JSON.stringify(summary).includes("비밀"), false);
});

test("카드 검수는 통과한 문장만 보내고 실패해도 실행을 멈추지 않는다", async () => {
  let sent;
  const flagged = flow((stage) => stage === "review");
  const ask = async (stage, instructions, payload) => {
    if (stage === "review") { sent = payload; return { flags: [{ c: 0, issue: "unclear" }] }; }
    return flagged(stage, instructions, payload);
  };
  const lab = await run(ask);
  assert.deepEqual(lab.review.flags, [{ c: 0, issue: "unclear" }]);
  assert.equal(sent.cards.length, 3);
  const skipped = await run(flagged);
  assert.deepEqual(skipped.review, { flags: [] });
});

test("뽑은 주장 중 카드에 쓴 비율을 볼 수 있게 센다", () => {
  const lines = [{ kind: "sentence", passed: true, text: "가", claims: ["a1-1"] }, { kind: "sentence", passed: true, text: "나", claims: ["a1-1", "a1-2"] }, { kind: "sentence", passed: false, text: "다", claims: ["a1-3"] }];
  const row = { event: { outlets: ["A"], items: [] }, claims: [{ id: "a1-1" }, { id: "a1-2" }, { id: "a1-3" }, { id: "a1-4" }], card: { title: "t", lines } };
  const summary = qualitySummary([row]);
  assert.equal(summary.claims, 4);
  assert.equal(summary.claimsUsed, 2);
});

test("사건 묶기와 붙이기는 한국 투자자의 매매 동향 기사를 뺀다", () => {
  assert.match(GROUP, /한국 투자자.*서학개미.*뺍니다/);
  assert.match(ATTACH, /한국 투자자.*서학개미.*붙이지 않습니다/);
});
