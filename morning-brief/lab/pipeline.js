import { ATTACH, CLAIMS, FIX, GROUP, MERGE, VERIFY, WRITE } from "./prompts.js";

export const MAX_EVENTS = 6;
export const READ_PER_EVENT = 3;
const MERGE_POOL = 12;
const TRY_PER_EVENT = 6;
const DUPLICATE = 0.6;
const BODY_LIMIT = 9000;
const RETRACTED = /속보|\[포토\]|\[사진\]|\[영상\]/;
const US_HINT = /미국|美|뉴욕|월가|나스닥|연준|파월|달러|트럼프|블루|엔비디아|테슬라|애플|Fed\b|Nasdaq|Wall Street|stocks?\b|tariff|Treasury|inflation/i;

const compact = (text) => String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function grams(text, size = 3) {
  const clean = compact(text);
  const set = new Set();
  for (let i = 0; i + size <= clean.length; i += 1) set.add(clean.slice(i, i + size));
  return set;
}

export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// 같은 언론사의 재전송과 복제 기사를 한 건으로 센다. 대표는 소개글이 긴 기사다.
export function collapseDuplicates(items) {
  const groups = [];
  for (const item of items) {
    const shape = grams(item.title);
    const found = groups.find((group) => similarity(group.shape, shape) >= DUPLICATE);
    if (!found) groups.push({ shape, lead: item, members: [item] });
    else {
      found.members.push(item);
      if (item.desc.length > found.lead.desc.length) found.lead = item;
    }
  }
  return groups.map(({ lead, members }) => ({ ...lead, copies: members }));
}

export function scoreEvent(event, now) {
  const outlets = new Set(event.items.flatMap((item) => item.copies.map((copy) => copy.source)));
  const regions = new Set(event.items.flatMap((item) => item.copies.map((copy) => copy.region)));
  const newest = Math.max(...event.items.map((item) => item.publishedAt));
  const hours = (now.getTime() - newest) / 3600e3;
  const parts = {
    impact: event.impact * 10,
    outlets: Math.min(outlets.size, 6) * 6,
    bothRegions: regions.size > 1 ? 5 : 0,
    fresh: hours <= 6 ? 3 : 0,
  };
  return { outlets: [...outlets], parts, score: Object.values(parts).reduce((sum, value) => sum + value, 0) };
}

const rank = (events, now) => events.map((event) => ({ ...event, ...scoreEvent(event, now) })).sort((a, b) => b.score - a.score);

// 같은 사건으로 판정된 묶음을 합친다. 기사는 겹치지 않게 모으고 점수는 다시 계산한다.
export function mergeEvents(events, merges, now) {
  const absorbed = new Set();
  const merged = events.map((event, index) => {
    const row = merges.find((item) => Number(item.keep) === index);
    if (!row || absorbed.has(index)) return event;
    const others = (row.absorb || []).map(Number).filter((other) => other !== index && events[other] && !absorbed.has(other));
    if (!others.length) return event;
    others.forEach((other) => absorbed.add(other));
    const parts = others.map((other) => events[other]);
    const items = [...new Map([event, ...parts].flatMap((part) => part.items).map((item) => [item.id, item])).values()];
    return {
      ...event,
      items,
      impact: Math.max(event.impact, ...parts.map((part) => part.impact)),
      merged: [...(event.merged || []), ...parts.map((part) => part.title)],
    };
  });
  return rank(merged.filter((_, index) => !absorbed.has(index)), now);
}

// 언론사가 겹치지 않게, 국내외가 섞이게, 속보보다 내용이 있어 보이는 기사를 먼저 고른다.
export function readingOrder(items) {
  const ranked = [...items].sort((a, b) => Number(RETRACTED.test(a.title)) - Number(RETRACTED.test(b.title)) || b.desc.length - a.desc.length);
  const order = [];
  const used = new Set();
  const regions = new Set();
  while (order.length < ranked.length) {
    const rest = ranked.filter((item) => !order.includes(item));
    const next = rest.find((item) => !used.has(item.source) && !regions.has(item.region))
      || rest.find((item) => !used.has(item.source))
      || rest[0];
    order.push(next);
    used.add(next.source);
    regions.add(next.region);
    if (regions.size > 1) regions.clear();
  }
  return order;
}

// 따옴표와 문장부호 차이는 무시하고, 말줄임표로 줄인 인용은 조각마다 본문에서 찾는다.
export function quoteFound(quote, body) {
  if (compact(quote).length < 15) return false;
  const text = compact(body);
  const parts = String(quote).split(/\.{2,}|…/).map(compact).filter((part) => part.length >= 8);
  return parts.length > 0 && parts.every((part) => text.includes(part));
}

const numbersIn = (text) => (String(text).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ""));

// 문장의 숫자가 근거 주장에 그대로 있는지 코드로 확인한다.
export function missingNumbers(sentence, claims) {
  const known = new Set(claims.flatMap((claim) => numbersIn(`${claim.text} ${claim.quote}`)));
  return numbersIn(sentence).filter((number) => !known.has(number));
}

async function readEvent(event, read, wait) {
  const reads = [];
  let usable = 0;
  for (const item of readingOrder(event.items).slice(0, TRY_PER_EVENT)) {
    if (usable >= READ_PER_EVENT) break;
    const result = await read(item.url);
    await wait();
    reads.push({ id: item.id, source: item.source, region: item.region, title: item.title, url: item.url, rss: item.desc, ...result, bodyLength: result.body.length });
    if (result.status === "ok") usable += 1;
  }
  return reads;
}

async function claimsFor(event, reads, ask) {
  const articles = reads.filter((r) => r.status === "ok").map((r, index) => ({ a: index + 1, id: r.id, s: r.source, t: r.title, body: r.body.slice(0, BODY_LIMIT) }));
  if (!articles.length) return { claims: [], dropped: [] };
  const { claims = [] } = await ask("claims", CLAIMS, { event: event.title, articles: articles.map(({ id, ...rest }) => rest) });
  const counts = new Map();
  const kept = [];
  const dropped = [];
  for (const claim of claims) {
    const article = articles.find((item) => item.a === Number(claim.a));
    if (!article) continue;
    counts.set(article.a, (counts.get(article.a) || 0) + 1);
    const entry = { ...claim, id: `a${article.a}-${counts.get(article.a)}`, s: article.s, articleId: article.id };
    (quoteFound(claim.quote, article.body) ? kept : dropped).push(entry);
  }
  return { claims: kept, dropped };
}

const evidence = (cited) => cited.map(({ text, quote, speaker, status }) => ({ claim: text, quote, speaker, status }));

function withCitations(line, claims) {
  const cited = claims.filter((claim) => (line.claims || []).includes(claim.id));
  return { ...line, cited, numbers: missingNumbers(line.text, cited) };
}

async function checkLines(lines, ask) {
  if (!lines.length) return [];
  const { results = [] } = await ask("verify", VERIFY, {
    lines: lines.map(({ k, text, cited }) => ({ k, text, evidence: evidence(cited) })),
  });
  return lines.map((line) => {
    const result = results.find((row) => Number(row.k) === line.k);
    const problems = [];
    if (!line.cited.length) problems.push("근거 주장 없음");
    if (line.numbers.length) problems.push(`근거에 없는 숫자: ${line.numbers.join(", ")}`);
    if (result?.ok === false) problems.push(result.reason || "근거와 맞지 않음");
    if (!result) problems.push("검사 결과 없음");
    return { ...line, problems, passed: !problems.length };
  });
}

// 틀린 문장은 바로 버리지 않고 근거에 맞게 한 번 고쳐 다시 검사한다. 그래도 틀리면 뺀다.
async function repairLines(lines, claims, ask) {
  const failed = lines.filter((line) => !line.passed && line.cited.length);
  if (!failed.length) return lines;
  const { lines: fixes = [] } = await ask("fix", FIX, {
    lines: failed.map(({ k, text, problems, cited }) => ({ k, text, problems, evidence: evidence(cited) })),
  });
  const revised = fixes.filter((row) => row.text).map((row) => {
    const line = lines.find((item) => item.k === Number(row.k));
    return line && withCitations({ ...line, text: String(row.text), before: line.text, beforeProblems: line.problems }, claims);
  }).filter(Boolean);
  const rechecked = await checkLines(revised, ask);
  return lines.map((line) => rechecked.find((row) => row.k === line.k) || line);
}

async function writeCard(event, claims, ask) {
  if (claims.length < 2) return null;
  const card = await ask("write", WRITE, {
    event: event.title,
    claims: claims.map(({ id, s, text, speaker, status }) => ({ id, s, text, speaker, status })),
  });
  const lines = [...(card.sentences || []).map((line) => ({ ...line, kind: "sentence" })), ...(card.doubts || []).map((line) => ({ ...line, kind: "doubt" }))]
    .map((line, k) => withCitations({ ...line, k }, claims));
  const repaired = await repairLines(await checkLines(lines, ask), claims, ask);
  return {
    title: card.title,
    lines: repaired.map(({ kind, text, claims: ids, problems, passed, before, beforeProblems }) => ({ kind, text, claims: ids || [], problems, passed, before, beforeProblems })),
  };
}

export async function runLab({ items, ask, read, now, wait = async () => {} }) {
  const collapsed = collapseDuplicates(items).map((item, index) => ({ ...item, id: index + 1 }));
  const { events: grouped = [] } = await ask("group", GROUP, {
    items: collapsed.map((item) => ({ n: item.id, s: item.source, t: item.title, d: item.desc.slice(0, 200) })),
  });
  // 한 번에 350건을 보면 관련 기사를 놓치므로, 남은 기사 중 미국 소식으로 보이는 것을 사건에 다시 붙여 본다.
  const placed = new Set(grouped.flatMap((event) => (event.ids || []).map(Number)));
  const rest = collapsed.filter((item) => !placed.has(item.id) && US_HINT.test(item.title));
  if (rest.length && grouped.length) {
    const { assign = [] } = await ask("attach", ATTACH, {
      events: grouped.map((event, e) => ({ e, title: event.title })),
      items: rest.map((item) => ({ n: item.id, s: item.source, t: item.title, d: item.desc.slice(0, 200) })),
    });
    for (const row of assign) grouped[Number(row.e)]?.ids?.push(Number(row.n));
  }
  const byId = new Map(collapsed.map((item) => [item.id, item]));
  const seen = new Set();
  const sorted = grouped.map((event) => {
    const members = (event.ids || []).map((id) => byId.get(Number(id))).filter((item) => item && !seen.has(item.id));
    members.forEach((item) => seen.add(item.id));
    return { title: String(event.title || ""), impact: Number(event.impact) || 1, reason: String(event.reason || ""), items: members };
  }).filter((event) => event.title && event.items.length);

  // 전체를 한 번에 묶으면 같은 사건이 나뉠 때가 있어, 순위 상위 사건끼리 다시 비교한다.
  let events = rank(sorted, now);
  if (events.length > 1) {
    const pool = events.slice(0, MERGE_POOL);
    const { merges = [] } = await ask("merge", MERGE, {
      events: pool.map((event, e) => ({ e, title: event.title, reason: event.reason, articles: event.items.slice(0, 8).map((item) => item.title) })),
    });
    events = mergeEvents([...pool, ...events.slice(MERGE_POOL)], merges, now);
  }

  const chosen = events.slice(0, MAX_EVENTS);
  const built = [];
  for (const event of chosen) built.push({ event, reads: await readEvent(event, read, wait) });
  const results = await Promise.all(built.map(async ({ event, reads }) => {
    const { claims, dropped } = await claimsFor(event, reads, ask);
    return { event, reads, claims, dropped, card: await writeCard(event, claims, ask) };
  }));

  return {
    collapsed,
    events,
    results,
    relevant: seen.size,
  };
}
