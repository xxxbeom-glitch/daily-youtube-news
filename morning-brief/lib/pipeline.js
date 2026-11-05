import { MARKET, RETITLE, SELECT, VERIFY, WRITE } from "./prompts.js";
import {
  HEADLINES_MAX, NEWS_MIN, TOTAL_CARDS, byInterest, hasEvidence, isKospiCluster, kospiIsBigNews, kstDate, kstIso,
  limitMarketCards, limitOverseas, normalizeBlocks, orderWithDiversity, pickSources, titleTooLong,
} from "./rules.js";

const CARD_CANDIDATES = 15;
const OVERSEAS_CANDIDATES = 8;
const MAX_INPUT_CHARS = 500000;
const MARKET_WORDS = /뉴욕증시|월가|나스닥|다우|S&P|Wall Street|Nasdaq|Treasury|국채 금리|달러|유가|\bFed\b|연준|stocks?\b/i;
const WAR_TOPICS = ["이란 전쟁과 호르무즈", "러시아·우크라이나 전쟁"];

// 입력이 너무 크면 설명을 줄인다. 27만 토큰을 넘는 요청은 요금이 높아진다.
function toInput(items) {
  const rows = (limit) => items.map((i) => ({ n: i.id, s: i.source, t: i.title, d: i.desc.slice(0, limit), c: i.cards.join(",") }));
  const full = rows(300);
  return JSON.stringify(full).length > MAX_INPUT_CHARS ? rows(120) : full;
}

const isInterest = (items) => items.some((i) => i.cards.includes("일반 뉴스") || i.topics.some((t) => WAR_TOPICS.includes(t)));

const pickItems = (ids, byId) => [...new Set(ids || [])].map((id) => byId.get(Number(id))).filter(Boolean);

async function marketCards({ items, byId, ask, marketOpen, majorOutlets }) {
  const pool = items.filter((i) => i.use === "market"
    || i.cards.some((c) => c !== "일반 뉴스")
    || MARKET_WORDS.test(i.title));
  const { cards = [] } = await ask("market", MARKET(marketOpen), { items: toInput(pool) });
  const built = cards.map((card) => ({
    section: "market",
    category: card.category,
    title: String(card.title || "").trim(),
    blocks: normalizeBlocks(card.blocks),
    items: pickItems(card.ids, byId),
  })).filter((card) => card.title && card.blocks.length && card.items.length);
  return limitMarketCards(built, { marketOpen, majorOutlets });
}

async function selectClusters({ items, byId, ask }) {
  const pool = items.filter((i) => i.use !== "market");
  const { clusters = [] } = await ask("select", SELECT, { items: toInput(pool) });
  const bigKospi = kospiIsBigNews(items);
  const seen = new Set();
  return clusters.map((cluster) => {
    const members = pickItems(cluster.ids, byId).filter((i) => !seen.has(i.id));
    members.forEach((i) => seen.add(i.id));
    return {
      items: members,
      category: String(cluster.category || "국제"),
      importance: Number(cluster.importance) || 0,
      scope: cluster.scope === "overseas" ? "overseas" : "domestic",
      interest: isInterest(members),
    };
  }).filter((c) => c.items.length && (bigKospi || !isKospiCluster(c.items))).sort(byInterest);
}

function splitCandidates(clusters) {
  const cards = [];
  const rest = [];
  let overseas = 0;
  for (const cluster of clusters) {
    const fits = cards.length < CARD_CANDIDATES && cluster.items.some((i) => i.desc)
      && (cluster.scope !== "overseas" || overseas < OVERSEAS_CANDIDATES);
    if (fits) {
      cards.push(cluster);
      if (cluster.scope === "overseas") overseas += 1;
    } else {
      rest.push(cluster);
    }
  }
  return { cards, rest: rest.slice(0, HEADLINES_MAX) };
}

const evidence = (items) => items.map((i) => ({ s: i.source, t: i.title, d: i.desc.slice(0, 300) }));

async function writeCards({ candidates, rest, ask }) {
  const payload = {
    clusters: candidates.map((c, k) => ({ k, category: c.category, items: evidence(c.items) })),
    rest: rest.map((c, k) => ({ k: k + candidates.length, title: c.items[0].title, desc: c.items[0].desc.slice(0, 120) })),
  };
  const { cards = [], headlines = [] } = await ask("write", WRITE, payload);
  const written = cards.map((card) => {
    const cluster = candidates[card.k];
    if (!cluster) return null;
    return { ...cluster, section: "news", title: String(card.title || "").trim(), blocks: normalizeBlocks(card.blocks) };
  }).filter((card) => card && card.title && card.blocks.length);
  const titled = headlines.map((h) => {
    const cluster = rest[h.k - candidates.length];
    return cluster && h.title ? { category: cluster.category, title: String(h.title).trim(), url: cluster.items[0].url } : null;
  }).filter(Boolean);
  return { written, titled };
}

async function fixTitles(cards, ask) {
  const long = cards.map((card, k) => ({ k, card })).filter(({ card }) => titleTooLong(card.title));
  if (!long.length) return;
  try {
    const { titles = [] } = await ask("retitle", RETITLE, {
      cards: long.map(({ k, card }) => ({ k, title: card.title, body: card.blocks[0] })),
    });
    for (const { k, title } of titles) {
      if (cards[k] && title && !titleTooLong(title)) cards[k].title = String(title).trim();
    }
  } catch (error) {
    console.warn(`retitle skipped: ${error.message}`);
  }
}

// 첫 블록이나 제목이 근거와 다르면 카드를 빼고, 뒤 블록만 다르면 그 블록만 뺀다.
export function applyVerification(cards, results) {
  const byKey = new Map(results.map((r) => [Number(r.k), r]));
  return cards.flatMap((card, k) => {
    const result = byKey.get(k);
    if (!result || result.firstOk !== true) return [];
    const bad = new Set((result.badBlocks || []).map(Number));
    const blocks = normalizeBlocks(card.blocks.filter((_, index) => index === 0 || !bad.has(index)));
    return blocks.length ? [{ ...card, blocks }] : [];
  });
}

const publish = ({ section, category, title, blocks, items }) => ({ section, category, title, blocks, sources: pickSources(items) });

export async function buildBriefing({ items, sourceErrors, marketOpen, majorOutlets, ask, now = new Date() }) {
  const byId = new Map(items.map((i) => [i.id, i]));

  let market = [];
  try {
    market = await marketCards({ items, byId, ask, marketOpen, majorOutlets });
  } catch (error) {
    console.warn(`market stage failed, continuing with news only: ${error.message}`);
  }
  const used = new Set(market.flatMap((card) => card.items.map((i) => i.id)));
  const remaining = items.filter((i) => !used.has(i.id));

  const clusters = await selectClusters({ items: remaining, byId, ask });
  const { cards: candidates, rest } = splitCandidates(clusters);
  const { written, titled } = await writeCards({ candidates, rest, ask });

  const drafts = [...market, ...written].filter((card) => hasEvidence(card.items));
  await fixTitles(drafts, ask);
  const { results = [] } = await ask("verify", VERIFY, {
    cards: drafts.map((card, k) => ({ k, title: card.title, blocks: card.blocks, evidence: evidence(card.items) })),
  });
  const passed = applyVerification(drafts, results);

  const passedMarket = passed.filter((card) => card.section === "market");
  const passedNews = limitOverseas(passed.filter((card) => card.section === "news").sort(byInterest));
  const room = TOTAL_CARDS - passedMarket.length;
  const news = orderWithDiversity(passedNews.slice(0, room));
  if (news.length < NEWS_MIN) throw new Error(`Only ${news.length} news cards passed (need ${NEWS_MIN})`);

  const spare = passedNews.slice(room).map((card) => ({ category: card.category, title: card.title, url: card.items[0].url }));
  return {
    date: kstDate(now),
    generatedAt: kstIso(now),
    cards: [...passedMarket, ...news].map(publish),
    headlines: [...spare, ...titled].slice(0, HEADLINES_MAX),
    sourceErrors,
  };
}
