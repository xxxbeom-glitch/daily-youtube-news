const MODEL = process.env.BRIEF_MODEL || "gpt-5.6-luna";

// 시험 페이지가 단계별 사용량을 보여줄 수 있게 남긴다.
export const usageLog = [];

export function parseModelJson(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("Model returned no JSON object");
  return JSON.parse(cleaned.slice(first, last + 1));
}

function outputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

async function once(instructions, payload) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      instructions,
      input: JSON.stringify(payload),
      reasoning: { effort: "medium" },
      max_output_tokens: 30000,
    }),
    signal: AbortSignal.timeout(420000),
  });
  if (!response.ok) throw new Error(`OpenAI failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  return { parsed: parseModelJson(outputText(data)), usage: data.usage };
}

// 단계 이름은 테스트의 가짜 응답이 구분하는 데 쓴다.
export async function ask(stage, instructions, payload) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { parsed, usage } = await once(instructions, payload);
      usageLog.push({ stage, input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 });
      console.log(`${stage}: in ${usage?.input_tokens ?? "?"} / out ${usage?.output_tokens ?? "?"} tokens`);
      return parsed;
    } catch (error) {
      lastError = error;
      console.warn(`${stage} attempt ${attempt} failed: ${error.message}`);
    }
  }
  throw lastError;
}
