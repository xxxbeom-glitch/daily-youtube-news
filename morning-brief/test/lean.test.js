import assert from "node:assert/strict";
import { test } from "node:test";
import { LEAN_THINKING, makeAsk, usageCost } from "../lab/claude.js";
import { gradeCards, gradeSummary } from "../lab/grade.js";
import { LEAN, numberedBody, onceEach, runLab, sentenceList, solidCard } from "../lab/pipeline.js";

const reply = (message) => ({ messages: { stream: (params) => ({ finalMessage: async () => message(params) }) } });
const done = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } });

const sentParams = async (stage, thinking, model) => {
  let sent;
  await makeAsk(reply((params) => { sent = params; return done("{}"); }), [], thinking, model)(stage, "지시", {});
  return sent;
};

test("생각을 끄는 단계는 끄고 낮추는 단계는 낮춘다", async () => {
  const off = await sentParams("claims", LEAN_THINKING);
  assert.deepEqual(off.thinking, { type: "disabled" });
  assert.equal(off.output_config, undefined);
  const low = await sentParams("verify", LEAN_THINKING);
  assert.deepEqual(low.thinking, { type: "adaptive" });
  assert.deepEqual(low.output_config, { effort: "low" });
});

test("설정이 없으면 지금 방식 그대로 보낸다", async () => {
  const sent = await sentParams("claims");
  assert.equal(sent.thinking, undefined);
  assert.equal(sent.output_config, undefined);
});

test("채점처럼 다른 모델을 지정할 수 있다", async () => {
  assert.equal((await sentParams("grade", { grade: "low" }, "claude-sonnet-5-5")).model, "claude-sonnet-5-5");
});

test("사용량으로 Haiku 비용을 계산한다", () => {
  assert.equal(usageCost([{ input: 1e6, output: 1e6 }, { input: 1e6, output: 0 }]), 0.7);
});

test("본문을 문장으로 나누고 번호를 붙인다", () => {
  const body = "연준은 이번 회의에서 금리를 동결했다고 밝혔다. 파월 의장은 물가가 아직 높다고 말했다. The Fed held rates steady on Wednesday afternoon. Stocks fell after the decision was announced.";
  const list = sentenceList(body);
  assert.equal(list.length, 4);
  assert.equal(list.join(" "), body);
  assert.ok(numberedBody(list).startsWith("[1] 연준은"));
  assert.ok(numberedBody(list).includes(" [2] 파월"));
});

test("아주 짧은 조각은 다음 문장에 붙인다", () => {
  const list = sentenceList("U.S. stocks fell sharply after the Fed decision today. 끝.");
  assert.equal(list.join(" "), "U.S. stocks fell sharply after the Fed decision today. 끝.");
  assert.ok(list.every((line) => line.length >= 4));
  assert.ok(list[0].startsWith("U.S. stocks"));
});

const item = (id, title) => ({ id, source: `S${id}`, title, desc: "", region: "domestic", url: `https://a.example/${id}`, publishedAt: Date.now() });
const body = "연준은 이번 회의에서 기준금리를 5.25%로 동결했다고 밝혔다. 파월 의장은 물가가 아직 높다고 기자들에게 말했다. 시장은 다음 회의를 주목하고 있다고 분석가들이 전했다. ".repeat(3);

const flow = (seen) => async (stage, _, payload) => {
  if (stage === "group") return { events: Array.from({ length: 14 }, (_, n) => ({ title: `사건${n + 1}`, ids: [n + 1], reason: "r" })) };
  if (stage === "claims") {
    seen.claims.push(payload);
    return { claims: [{ a: 1, text: "금리가 5.25%로 동결됐다", q: [1], speaker: "연준", status: "확정" }, { a: 1, text: "물가가 높다고 말했다", q: [2, 3], speaker: "파월", status: "주장" }, { a: 1, text: "없는 번호", q: [99], speaker: "x", status: "확정" }] };
  }
  if (stage === "write") return seen.fail?.(payload) ? { title: "t", sentences: [], doubts: [] } : { title: "카드", sentences: [{ text: "금리가 5.25%예요.", claims: ["a1-1"] }, { text: "물가가 높대요.", claims: ["a1-2"] }], doubts: [] };
  if (stage === "verify") return { results: payload.lines.map(({ k }) => ({ k, ok: true })) };
  return {};
};
const TITLES = ["연준 금리 동결", "나스닥 급락 마감", "애플 실적 발표", "테슬라 공장 증설", "고용지표 예상 상회", "물가상승률 둔화", "국채수익률 급등", "달러인덱스 하락", "트럼프 관세 연장", "엔비디아 신제품 공개", "보잉 인도량 감소", "유가 배럴당 반등", "은행권 대출 축소", "소비심리 위축 지속"];
const lean = (seen, profile = LEAN) => runLab({
  items: TITLES.map((title, n) => item(n + 1, title)),
  ask: flow(seen), read: async () => ({ status: "ok", body }), now: new Date(), profile,
});

test("AI는 문장 번호만 답하고 원문은 코드가 찾아 넣는다", async () => {
  const seen = { claims: [] };
  const lab = await lean(seen);
  assert.ok(seen.claims[0].articles[0].body.startsWith("[1] 연준은"));
  const row = lab.results[0];
  assert.equal(row.claims.length, 2);
  assert.equal(row.claims[0].quote, sentenceList(body)[0]);
  assert.equal(row.claims[1].quote, `${sentenceList(body)[1]} ${sentenceList(body)[2]}`);
  assert.equal(row.dropped.length, 1);
});

test("카드 10장이 차면 남은 후보는 만들지 않는다", async () => {
  const seen = { claims: [] };
  const lab = await lean(seen);
  assert.equal(seen.claims.length, 10);
  assert.equal(lab.results.filter((row) => solidCard(row.card)).length, 10);
});

test("카드가 모자라면 다음 후보로 채운다", async () => {
  const seen = { claims: [], fail: (payload) => payload.event === "사건2" || payload.event === "사건3" };
  const lab = await lean(seen);
  assert.equal(seen.claims.length, 12);
  assert.equal(lab.results.filter((row) => solidCard(row.card)).length, 10);
});

test("지금 방식은 후보 14건을 모두 만든다", async () => {
  const seen = { claims: [] };
  await lean(seen, { wave: 14, pointers: false });
  assert.equal(seen.claims.length, 14);
});

test("같은 주소는 한 번만 읽는다", async () => {
  let reads = 0;
  const read = onceEach(async () => { reads += 1; return { status: "ok", body }; });
  await read("https://a.example/1");
  await read("https://a.example/1");
  assert.equal(reads, 1);
});

const solid = (title) => ({ title, reads: [{ status: "ok", source: "A", title: "기사", body: "기사 본문" }, { status: "blocked", body: "" }], card: { title, lines: [{ kind: "sentence", passed: true, text: "비밀 문장 하나" }, { kind: "sentence", passed: true, text: "비밀 문장 둘" }, { kind: "sentence", passed: false, text: "탈락 문장" }] } });
const asRow = (row) => ({ ...row, event: { title: row.title } });

test("채점은 통과한 문장을 읽은 기사 본문과 대조하고 요약에는 개수만 남긴다", async () => {
  const sent = [];
  const ask = async (stage, _, payload) => {
    sent.push({ stage, payload });
    return { lines: [{ k: 0, verdict: "ok" }, { k: 1, verdict: "wrong_fact", reason: "비밀 이유" }], sameEvent: false };
  };
  const grades = await gradeCards([asRow(solid("가")), { event: { title: "빈" }, reads: [], card: null }], ask);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].stage, "grade");
  assert.deepEqual(sent[0].payload.lines.map((line) => line.text), ["비밀 문장 하나", "비밀 문장 둘"]);
  assert.deepEqual(sent[0].payload.articles.map((article) => article.body), ["기사 본문"]);
  const summary = gradeSummary(grades);
  assert.deepEqual(summary, { cards: 1, failed: 0, lines: 2, ok: 1, wrong_fact: 1, invented: 0, overclaim: 0, other: 0, mixedCards: 1 });
  assert.ok(!JSON.stringify(summary).includes("비밀"));
});

test("채점 한 건이 실패해도 나머지는 센다", async () => {
  let calls = 0;
  const ask = async () => { calls += 1; if (calls === 1) throw new Error("실패"); return { lines: [{ k: 0, verdict: "ok" }, { k: 1, verdict: "ok" }], sameEvent: true }; };
  const summary = gradeSummary(await gradeCards([asRow(solid("가")), asRow(solid("나"))], ask));
  assert.equal(summary.failed, 1);
  assert.equal(summary.ok, 2);
});
