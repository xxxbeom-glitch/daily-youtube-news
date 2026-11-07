import Anthropic from "@anthropic-ai/sdk";
import { parseModelJson } from "../lib/ai.js";

export const MODEL = process.env.BRIEF_MODEL || "claude-haiku-5-5";
const MAX_TOKENS = 32000;
const ATTEMPTS = 3;
const TIME_LIMIT_MS = 240000;

// 시험 페이지가 단계별 사용량을 보여줄 수 있게 남긴다.
export const usageLog = [];

// 돈은 대부분 AI의 생각에 나간다. 옮겨 쓰는 단계는 끄고, 판단이 필요한 단계는 낮춘다.
export const LEAN_THINKING = { claims: "off", write: "low", fix: "low", overlap: "off", group: "low", attach: "low", merge: "low", verify: "low", review: "low" };

const THINKING = {
  off: { thinking: { type: "disabled" } },
  low: { thinking: { type: "adaptive" }, output_config: { effort: "low" } },
  medium: { thinking: { type: "adaptive" }, output_config: { effort: "medium" } },
};

// Haiku 5.5 값이다. 입력 100만 토큰 0.1달러, 출력 100만 토큰 0.5달러.
export const usageCost = (log) => log.reduce((sum, row) => sum + row.input * 0.1 + row.output * 0.5, 0) / 1e6;

async function once(client, instructions, payload, settings) {
  const message = await client.messages.stream({
    max_tokens: MAX_TOKENS,
    ...settings,
    system: instructions,
    messages: [{ role: "user", content: JSON.stringify(payload) }],
  }, { signal: AbortSignal.timeout(TIME_LIMIT_MS) }).finalMessage();
  if (message.stop_reason !== "end_turn") throw new Error(`Claude stopped: ${message.stop_reason}`);
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  return { parsed: parseModelJson(text), usage: message.usage };
}

// JSON 오류 문구에는 AI 답이 섞이므로, 공개 로그에는 오류 종류만 남긴다.
const safeMessage = (error) => (error instanceof SyntaxError ? "invalid JSON" : error.message);

// 단계 이름은 테스트의 가짜 응답이 구분하는 데 쓴다.
export function makeAsk(client, log = usageLog, thinking = {}, model = MODEL) {
  return async function ask(stage, instructions, payload) {
    const settings = { model, ...THINKING[thinking[stage]] };
    let lastError;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const { parsed, usage } = await once(client, instructions, payload, settings);
        log.push({ stage, input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 });
        console.log(`${stage}: in ${usage?.input_tokens ?? "?"} / out ${usage?.output_tokens ?? "?"} tokens`);
        return parsed;
      } catch (error) {
        lastError = error;
        console.warn(`${stage} attempt ${attempt} failed: ${safeMessage(error)}`);
      }
    }
    throw new Error(`${stage} failed: ${safeMessage(lastError)}`);
  };
}

export const claudeAsk = (log, thinking, model) => makeAsk(new Anthropic({ timeout: TIME_LIMIT_MS, maxRetries: 1 }), log, thinking, model);
