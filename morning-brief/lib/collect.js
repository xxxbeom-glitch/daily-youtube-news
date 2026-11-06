import { fetchNaver, naverFeed } from "./naver.js";
import { parseFeed } from "./rss.js";

const WIRE_FILTER = "(site:reuters.com OR site:bloomberg.com OR site:wsj.com OR site:cnbc.com OR site:ft.com)";
const PER_TOPIC = 20;
const PER_FEED = 60;
const CONCURRENCY = 4;
const OUTLET_NAMES = {
  Reuters: "로이터", Bloomberg: "블룸버그", "Bloomberg.com": "블룸버그", "The Wall Street Journal": "WSJ",
  "Wall Street Journal": "WSJ", "Financial Times": "FT", "ft.com": "FT", "wsj.com": "WSJ",
};

export function topicUrl(topic) {
  const url = new URL("https://news.google.com/rss/search");
  const params = topic.lang === "en"
    ? { q: `${topic.query} ${WIRE_FILTER} when:1d`, hl: "en-US", gl: "US", ceid: "US:en" }
    : { q: `${topic.query} when:1d`, hl: "ko", gl: "KR", ceid: "KR:ko" };
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export const topicFeed = (topic) => ({
  name: topic.name,
  url: topicUrl(topic),
  region: topic.lang === "en" ? "overseas" : "domestic",
  lang: topic.lang,
  use: "topic",
  card: topic.card,
  topic: topic.name,
});

async function fetchFeed(feed, fetcher) {
  const response = await fetcher(feed.url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; morning-brief/1.0)", accept: "application/rss+xml, application/xml, text/xml, */*" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseFeed(await response.text(), feed);
}

export function mergeItems(lists, { now, since }) {
  const byUrl = new Map();
  for (const item of lists.flat()) {
    // 날짜가 없는 항목은 수집 시각을 날짜로 쓴다.
    const time = item.publishedAt ?? now.getTime();
    if (time < since.getTime() || time > now.getTime() + 3600e3) continue;
    const existing = byUrl.get(item.url);
    if (existing) {
      if (!existing.desc && item.desc) existing.desc = item.desc;
      if (item.card && !existing.cards.includes(item.card)) existing.cards.push(item.card);
      if (item.topic && !existing.topics.includes(item.topic)) existing.topics.push(item.topic);
      continue;
    }
    byUrl.set(item.url, {
      ...item,
      source: OUTLET_NAMES[item.source] || item.source,
      publishedAt: time,
      cards: item.card ? [item.card] : [],
      topics: item.topic ? [item.topic] : [],
    });
  }
  return [...byUrl.values()]
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .map((item, index) => ({ ...item, id: index + 1 }));
}

export async function collect({ sources, topics, naverTopics = [], naverKeys = null, now = new Date(), since, fetcher = fetch }) {
  const feeds = [...sources, ...topics.map(topicFeed), ...(naverKeys ? naverTopics.map(naverFeed) : [])];
  const results = new Array(feeds.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < feeds.length) {
      const index = next;
      next += 1;
      try {
        const feed = feeds[index];
        results[index] = { items: await (feed.naver ? fetchNaver(feed, naverKeys, fetcher) : fetchFeed(feed, fetcher)) };
      } catch (error) {
        results[index] = { error: error.message };
      }
    }
  }));
  const sourceErrors = [];
  let healthyGeneral = 0;
  const lists = results.map((result, index) => {
    const feed = feeds[index];
    if (result.error) {
      sourceErrors.push({ name: feed.name, error: result.error });
      return [];
    }
    if (feed.use === "general") healthyGeneral += 1;
    return result.items.slice(0, feed.limit ?? (feed.use === "topic" ? PER_TOPIC : PER_FEED));
  });
  return { items: mergeItems(lists, { now, since }), sourceErrors, healthyGeneral };
}
