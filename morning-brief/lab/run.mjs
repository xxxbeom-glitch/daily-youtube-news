import { readFile } from "node:fs/promises";
import { ask, usageLog } from "../lib/ai.js";
import { fetchNaver, naverFeed, naverKeys } from "../lib/naver.js";
import { parseFeed } from "../lib/rss.js";
import { kstDate, windowStart } from "../lib/rules.js";
import { USER_AGENT, articleReader } from "./article.js";
import { runLab } from "./pipeline.js";

const SITE = process.env.LAB_URL || "https://morning-brief-lab.vercel.app";
const AUDIENCE = "morning-brief-lab";
const READ_GAP_MS = 1000;

async function actionsToken() {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env;
  if (!url || !bearer) throw new Error("Workflow needs permissions: id-token: write");
  const response = await fetch(`${url}&audience=${AUDIENCE}`, { headers: { authorization: `Bearer ${bearer}` } });
  if (!response.ok) throw new Error(`OIDC token failed (${response.status})`);
  return (await response.json()).value;
}

async function collectAll({ feeds, domesticOutlets, naverQueries }, now) {
  const since = windowStart(now).getTime();
  const log = [];
  const lists = await Promise.all(feeds.map(async (feed) => {
    try {
      const response = await fetch(feed.url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const items = parseFeed(await response.text(), { ...feed, use: "lab" });
      log.push({ name: feed.name, via: "RSS", received: items.length });
      return items;
    } catch (error) {
      log.push({ name: feed.name, via: "RSS", error: error.message });
      return [];
    }
  }));
  const keys = naverKeys();
  for (const query of keys ? naverQueries : []) {
    const feed = naverFeed({ name: query, card: "미국 경제", query });
    try {
      const items = await fetchNaver(feed, keys, fetch);
      const kept = items.filter((item) => domesticOutlets.includes(item.source));
      log.push({ name: query, via: "네이버", received: items.length, kept: kept.length });
      lists.push(kept);
    } catch (error) {
      log.push({ name: query, via: "네이버", error: error.message });
    }
  }
  const byUrl = new Map();
  for (const item of lists.flat()) {
    const time = item.publishedAt ?? now.getTime();
    if (time < since || time > now.getTime() + 3600e3) continue;
    const found = byUrl.get(item.url);
    if (!found) byUrl.set(item.url, { ...item, desc: item.desc || "", publishedAt: time });
    else if (!found.desc && item.desc) found.desc = item.desc;
  }
  return { items: [...byUrl.values()], log, since };
}

const brief = (item) => ({
  id: item.id, source: item.source, region: item.region, via: item.via || "rss", title: item.title, desc: item.desc, url: item.url,
  publishedAt: item.publishedAt, copies: item.copies.length,
});

async function main() {
  const now = new Date();
  const started = Date.now();
  const config = JSON.parse(await readFile(new URL("./sources.json", import.meta.url), "utf8"));
  const { items, log, since } = await collectAll(config, now);
  console.log(`collected ${items.length} items from ${log.length} sources`);
  for (const row of log) if (row.error) console.warn(`source failed: ${row.via} ${row.error}`);

  const read = articleReader();
  const lab = await runLab({ items, ask, read, now, wait: () => new Promise((done) => setTimeout(done, READ_GAP_MS)) });

  // 공개 저장소의 로그이므로 기사 내용은 남기지 않고 개수만 남긴다.
  const reads = lab.results.flatMap((row) => row.reads);
  const statuses = reads.reduce((all, row) => ({ ...all, [row.status]: (all[row.status] || 0) + 1 }), {});
  const lines = lab.results.flatMap((row) => row.card?.lines || []);
  console.log(`events ${lab.events.length}, reads ${JSON.stringify(statuses)}, cards ${lab.results.filter((row) => row.card).length}, lines passed ${lines.filter((l) => l.passed).length}/${lines.length}`);

  const report = {
    date: kstDate(now),
    createdAt: now.toISOString(),
    windowStart: new Date(since).toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    usage: usageLog,
    sources: log,
    counts: { collected: items.length, afterDuplicates: lab.collapsed.length, relevant: lab.relevant, events: lab.events.length },
    collected: lab.collapsed.map(brief),
    events: lab.events.map(({ title, topic, impact, reason, merged, items: members, outlets, parts, score }) => ({ title, topic, impact, reason, merged, outlets, parts, score, ids: members.map((item) => item.id) })),
    results: lab.results.map(({ event, reads: rows, claims, dropped, card, repeated }) => ({
      title: event.title, score: event.score, outlets: event.outlets, reads: rows, claims, dropped, card, repeated,
    })),
  };
  const response = await fetch(`${SITE}/api/ingest`, {
    method: "POST",
    headers: { authorization: `Bearer ${await actionsToken()}`, "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  if (!response.ok) throw new Error(`Upload failed (${response.status})`);
  console.log(`uploaded report for ${report.date}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
