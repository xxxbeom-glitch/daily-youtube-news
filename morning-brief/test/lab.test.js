import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBody, robotsAllows } from "../lab/article.js";
import { collapseDuplicates, missingNumbers, quoteFound, readingOrder, runLab, scoreEvent } from "../lab/pipeline.js";

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

test("읽을 기사는 언론사가 겹치지 않고 국내외를 섞는다", () => {
  const order = readingOrder([item(1, "A", "a", { desc: "xxxx" }), item(2, "A", "b", { desc: "xxx" }), item(3, "B", "c", { region: "overseas", desc: "x" })]);
  assert.deepEqual(order.slice(0, 2).map((row) => row.source), ["A", "B"]);
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
