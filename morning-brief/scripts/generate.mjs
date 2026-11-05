import { readFile } from "node:fs/promises";
import { ask } from "../lib/ai.js";
import { collect } from "../lib/collect.js";
import { AUDIENCE } from "../lib/oidc.js";
import { buildBriefing } from "../lib/pipeline.js";
import { kstDate, marketWasOpen, windowStart } from "../lib/rules.js";

const MIN_HEALTHY_FEEDS = 5;
const BASE_URL = process.env.BRIEF_BASE_URL || "https://morning-news-mockup.vercel.app";
const load = async (name) => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"));

// Actions가 발급하는 서명 토큰으로 저장 API에 자신을 증명한다. 저장된 비밀값이 필요 없다.
async function actionsToken() {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env;
  if (!url || !bearer) throw new Error("Workflow needs permissions: id-token: write");
  const response = await fetch(`${url}&audience=${AUDIENCE}`, { headers: { authorization: `Bearer ${bearer}` } });
  if (!response.ok) throw new Error(`OIDC token failed (${response.status})`);
  return (await response.json()).value;
}

async function ingest(token, init = {}, query = "") {
  const response = await fetch(`${BASE_URL}/api/ingest${query}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!response.ok) throw new Error(`Ingest failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function main() {
  const now = new Date();
  const date = kstDate(now);
  const token = await actionsToken();

  if (process.env.FORCE !== "true" && (await ingest(token, {}, `?date=${date}`)).exists) {
    console.log(`${date} briefing already exists, skipping`);
    return;
  }

  const [{ sources, majorOutlets }, { topics }, { dates: holidays }] = await Promise.all([
    load("sources.json"), load("topics.json"), load("market-holidays.json"),
  ]);
  const { items, sourceErrors, healthyGeneral } = await collect({ sources, topics, now, since: windowStart(now) });
  console.log(`collected ${items.length} items, ${healthyGeneral} healthy general feeds`);
  for (const failure of sourceErrors) console.warn(`feed failed: ${failure.name}: ${failure.error}`);
  if (healthyGeneral < MIN_HEALTHY_FEEDS) throw new Error(`Only ${healthyGeneral} general feeds healthy`);

  const brief = await buildBriefing({
    items, sourceErrors, majorOutlets, ask, now, marketOpen: marketWasOpen(now, holidays),
  });

  // 공개 저장소의 로그이므로 내용은 남기지 않고 개수만 남긴다.
  const market = brief.cards.filter((card) => card.section === "market").length;
  console.log(`built ${brief.cards.length} cards (${market} market), ${brief.headlines.length} headlines`);

  // 실행 직전에 토큰이 만료될 수 있어 저장 때 새로 받는다.
  const saved = await ingest(await actionsToken(), { method: "POST", body: JSON.stringify(brief) });
  console.log(`saved ${saved.saved}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
