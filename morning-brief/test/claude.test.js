import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL, makeAsk } from "../lab/claude.js";

const reply = (message) => ({ messages: { stream: (params) => ({ finalMessage: async () => message(params) }) } });
const done = (text, extra = {}) => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 }, ...extra });

test("지시문과 입력을 보내고 글 칸의 JSON을 읽어 사용량을 남긴다", async () => {
  const usage = [];
  let sent;
  const ask = makeAsk(reply((params) => { sent = params; return done('```json\n{"ok":true}\n```'); }), usage);
  assert.deepEqual(await ask("group", "지시", { a: 1 }), { ok: true });
  assert.equal(sent.model, MODEL);
  assert.equal(sent.system, "지시");
  assert.deepEqual(sent.messages, [{ role: "user", content: '{"a":1}' }]);
  assert.deepEqual(usage, [{ stage: "group", input: 10, output: 5 }]);
});

test("답이 잘리거나 거절되면 다시 시도하고 끝내 안 되면 실패한다", async () => {
  let calls = 0;
  const ask = makeAsk(reply(() => { calls += 1; return calls === 1 ? done("{", { stop_reason: "max_tokens" }) : done('{"n":2}'); }), []);
  assert.deepEqual(await ask("write", "지시", {}), { n: 2 });
  const refused = makeAsk(reply(() => done("", { stop_reason: "refusal" })), []);
  await assert.rejects(refused("write", "지시", {}), /refusal/);
});
