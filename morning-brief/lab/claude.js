import Anthropic from "@anthropic-ai/sdk";
import { parseModelJson } from "../lib/ai.js";

export const MODEL = process.env.BRIEF_MODEL || "claude-haiku-5-5";
const MAX_TOKENS = 32000;
const ATTEMPTS = 3;
const TIME_LIMIT_MS = 240000;

// 시험 페이지가 단계별 사용량을 보여줄 수 있게 남긴다.
export const usageLog = [];

async function once(client, instructions, payload) {
  const message = await client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
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
export function makeAsk(client, log = usageLog) {
  return async function ask(stage, instructions, payload) {
    let lastError;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const { parsed, usage } = await once(client, instructions, payload);
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

export const claudeAsk = () => makeAsk(new Anthropic({ timeout: TIME_LIMIT_MS, maxRetries: 1 }));
