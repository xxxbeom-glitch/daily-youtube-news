import { createHash } from "node:crypto";
import { articleKey } from "./lists.js";
import { ATTACH, CLAIMS, CLAIMS_LEAN, FIX, GROUP, MERGE, OVERLAP, REVIEW, VERIFY, WRITE } from "./prompts.js";

export const MAX_CARDS = 10;
export const CANDIDATES = 14;
export const READ_PER_EVENT = 3;
// 지금 방식은 후보를 다 만들고 원문을 AI가 베껴 쓴다. 절감 방식은 10장이 차면 멈추고 번호만 받는다.
export const BASELINE = { wave: CANDIDATES, pointers: false };
export const LEAN = { wave: 0, pointers: true };
const PER_TOPIC = 2;
const MERGE_POOL = 20;
const PARALLEL = 4;
const TRY_PER_EVENT = 6;
const DUPLICATE = 0.6;
const BODY_LIMIT = 9000;
const SHORT_PIECE = 15;
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
  // 중요도는 AI가 아니라 언론사가 페이지에 놓은 위치로 본다. 한 언론사는 높은 등급으로 한 번만 센다.
  const copies = event.items.flatMap((item) => item.copies);
  const top = new Set(copies.flatMap((copy) => copy.placement?.top || []));
  const major = new Set(copies.flatMap((copy) => copy.placement?.major || []).filter((outlet) => !top.has(outlet)));
  const parts = {
    top: top.size * 15,
    major: major.size * 8,
    outlets: Math.min(outlets.size, 6) * 6,
    bothRegions: regions.size > 1 ? 10 : 0,
    fresh: hours >= 0 && hours <= 6 ? 3 : 0,
  };
  return { outlets: [...outlets], parts, newest, placed: top.size + major.size, score: Object.values(parts).reduce((sum, value) => sum + value, 0) };
}

// 동점도 입력 순서에 기대지 않고 늘 같은 순위가 나오게 한다.
const byRank = (a, b) => b.score - a.score || b.parts.top - a.parts.top || b.items.length - a.items.length || b.newest - a.newest || a.title.localeCompare(b.title);

const rank = (events, now) => events.map((event) => ({ ...event, ...scoreEvent(event, now) })).sort(byRank);

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
      merged: [...(event.merged || []), ...parts.map((part) => part.title)],
    };
  });
  return rank(merged.filter((_, index) => !absorbed.has(index)), now);
}

// 같은 주제의 사건은 높은 순위부터 두 개까지 고른다. 주제가 없는 사건은 제한하지 않는다.
export function pickEvents(events, limit = CANDIDATES, perTopic = PER_TOPIC) {
  const used = new Map();
  const picked = [];
  for (const event of events) {
    if (picked.length >= limit) break;
    const topic = compact(event.topic);
    if (topic && (used.get(topic) || 0) >= perTopic) continue;
    if (topic) used.set(topic, (used.get(topic) || 0) + 1);
    picked.push(event);
  }
  return picked;
}

// 검사를 통과한 문장이 두 개는 있어야 카드로 보여 준다.
export const solidCard = (card) => Boolean(card) && card.lines.filter((line) => line.kind === "sentence" && line.passed).length >= 2;

// 후보를 넉넉히 만들어 두고, 살아남은 카드를 앞에서부터 정해진 수만큼 남긴다. 얕은 카드는 시험 기록으로만 둔다.
export function capCards(results, limit = MAX_CARDS) {
  let cards = 0;
  return results.filter((row) => {
    if (!solidCard(row.card)) return true;
    cards += 1;
    return cards <= limit;
  });
}

// 없어도 카드를 만들 수 있는 단계는 실패해도 빈 답으로 넘어간다.
const optional = (ask) => async (stage, instructions, payload) => {
  try {
    return await ask(stage, instructions, payload);
  } catch (error) {
    console.warn(`${stage} skipped: ${error.message}`);
    return {};
  }
};

// 한꺼번에 많이 부르면 AI 사용량 제한에 걸리므로 몇 개씩 나눠 처리한다.
async function mapLimited(rows, work) {
  const results = new Array(rows.length);
  let next = 0;
  const runner = async () => {
    while (next < rows.length) {
      const index = next;
      next += 1;
      results[index] = await work(rows[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, rows.length) }, runner));
  return results;
}

// 해외 기사부터, 언론사가 겹치지 않게, 국내외가 섞이게, 속보보다 내용이 있어 보이는 기사를 먼저 고른다.
export function readingOrder(items) {
  const domestic = (item) => Number(item.region !== "overseas");
  const ranked = [...items].sort((a, b) => domestic(a) - domestic(b) || Number(RETRACTED.test(a.title)) - Number(RETRACTED.test(b.title)) || b.desc.length - a.desc.length);
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

const UNITS = { tn: 1e12, trillion: 1e12, bn: 1e9, billion: 1e9, mn: 1e6, million: 1e6 };

function koreanAmount(value) {
  const parts = [[1e12, "조"], [1e8, "억"], [1e4, "만"]];
  let rest = value;
  let text = "";
  for (const [size, name] of parts) {
    const count = Math.floor(rest / size);
    if (count) text += `${count}${name}`;
    rest -= count * size;
  }
  return rest ? `${text}${rest}` : text;
}

// 영어 금액 단위는 AI가 아니라 코드가 바꾼다. 계산 실수가 숫자 대조를 통과하지 못하게 하기 위해서다.
export function koreanUnits(text) {
  return String(text || "")
    .replace(/((?:US)?\$\s?)?(\d[\d,]*(?:\.\d+)?)\s?(tn|trillion|bn|billion|mn|million)\b(?:\s?(달러|dollars?))?/gi, (_, dollar, number, unit, word) => {
      const value = Math.round(Number(number.replace(/,/g, "")) * UNITS[unit.toLowerCase()]);
      return `${koreanAmount(value)}${dollar || word ? "달러" : ""}`;
    })
    .replace(/(\d+\.\d+)조/g, (_, number) => koreanAmount(Math.round(Number(number) * 1e12)))
    .replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, "$1달러")
    .replace(/\bgallons?\b/gi, "갤런")
    .replace(/\bbasis points?\b/gi, "베이시스포인트");
}

// 대문자 약어(AI, PCE, S&P)는 두고, 한글로 쓸 수 있는 영어 이름만 찾는다.
export const latinNames = (text) => (String(text).match(/[A-Za-z][A-Za-z&.'-]*[A-Za-z]/g) || [])
  .filter((word) => !/^[A-Z&.]+$/.test(word) && !/^(?:bp|tn|bn)$/i.test(word));

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

// 약어의 마침표로 잘린 짧은 조각은 이웃 문장에 붙인다.
export function sentenceList(body) {
  const list = [];
  let carry = "";
  for (const piece of String(body).split(/(?<=[.!?…])\s+/)) {
    const text = carry ? `${carry} ${piece}` : piece;
    carry = text.length < SHORT_PIECE ? text : "";
    if (!carry && text) list.push(text);
  }
  if (carry && list.length) list[list.length - 1] += ` ${carry}`;
  else if (carry) list.push(carry);
  return list;
}

export const numberedBody = (list) => list.map((line, index) => `[${index + 1}] ${line}`).join(" ");

// 두 방식을 비교할 때 언론사 페이지를 다시 읽지 않고 같은 본문을 쓴다.
export function onceEach(read) {
  const seen = new Map();
  return (url) => {
    if (!seen.has(url)) seen.set(url, read(url));
    return seen.get(url);
  };
}

function pickedQuote(claim, article) {
  const rows = (claim.q || []).map((n) => article.lines[Number(n) - 1]);
  return rows.length && rows.every(Boolean) ? rows.join(" ") : "";
}

async function claimsFor(event, reads, ask, pointers) {
  const articles = reads.filter((r) => r.status === "ok").map((r, index) => {
    const body = r.body.slice(0, BODY_LIMIT);
    return { a: index + 1, id: r.id, s: r.source, t: r.title, body, lines: pointers ? sentenceList(body) : [] };
  });
  if (!articles.length) return { claims: [], dropped: [] };
  const sent = articles.map(({ a, s, t, body, lines }) => ({ a, s, t, body: pointers ? numberedBody(lines) : body }));
  const { claims = [] } = await ask("claims", pointers ? CLAIMS_LEAN : CLAIMS, { event: event.title, articles: sent });
  const counts = new Map();
  const kept = [];
  const dropped = [];
  for (const claim of claims) {
    const article = articles.find((item) => item.a === Number(claim.a));
    if (!article) continue;
    counts.set(article.a, (counts.get(article.a) || 0) + 1);
    const quote = pointers ? pickedQuote(claim, article) : claim.quote;
    const entry = { ...claim, quote, text: koreanUnits(claim.text), id: `a${article.a}-${counts.get(article.a)}`, s: article.s, articleId: article.id };
    const found = pointers ? Boolean(quote) : quoteFound(quote, article.body);
    (found ? kept : dropped).push(entry);
  }
  return { claims: kept, dropped };
}

const evidence = (cited) => cited.map(({ text, quote, speaker, status }) => ({ claim: text, quote, speaker, status }));

function withCitations(line, claims) {
  const cited = claims.filter((claim) => (line.claims || []).includes(claim.id));
  return { ...line, cited, numbers: missingNumbers(line.text, cited), names: latinNames(line.text) };
}

async function checkLines(lines, event, ask) {
  if (!lines.length) return [];
  const { results = [] } = await ask("verify", VERIFY, {
    event: event.title,
    lines: lines.map(({ k, kind, text, cited }) => ({ k, kind, text, evidence: evidence(cited) })),
  });
  return lines.map((line) => {
    const result = results.find((row) => Number(row.k) === line.k);
    const problems = [];
    if (!line.cited.length) problems.push("근거 주장 없음");
    if (line.numbers.length) problems.push(`근거에 없는 숫자: ${line.numbers.join(", ")}`);
    if (result?.ok === false) problems.push(result.reason || "근거와 맞지 않음");
    if (!result) problems.push("검사 결과 없음");
    if (line.kind === "doubt" && !/요\?\s*$/.test(line.text)) problems.push("해요체 물음이 아님");
    return { ...line, problems, passed: !problems.length };
  });
}

// 틀린 문장은 바로 버리지 않고 근거에 맞게 한 번 고쳐 다시 검사한다. 그래도 틀리면 뺀다.
async function repairLines(lines, claims, event, ask) {
  const failed = lines.filter((line) => line.cited.length && (!line.passed || line.names.length));
  if (!failed.length) return lines;
  const { lines: fixes = [] } = await ask("fix", FIX, {
    event: event.title,
    lines: failed.map(({ k, kind, text, problems, names, cited }) => ({
      k, kind, text, evidence: evidence(cited),
      problems: names.length ? [...problems, `영어 이름을 한글로 바꿀 것: ${names.join(", ")}`] : problems,
    })),
  });
  const revised = fixes.filter((row) => row.text).map((row) => {
    const line = lines.find((item) => item.k === Number(row.k));
    return line && withCitations({ ...line, text: koreanUnits(row.text), before: line.text, beforeProblems: line.problems }, claims);
  }).filter(Boolean);
  const rechecked = await checkLines(revised, event, ask);
  // 표기만 고친 문장이 재검사에서 틀리면 통과했던 원래 문장을 쓴다.
  return lines.map((line) => {
    const row = rechecked.find((item) => item.k === line.k);
    return row && (row.passed || !line.passed) ? row : line;
  });
}

async function writeCard(event, claims, ask) {
  if (claims.length < 2) return null;
  const card = await ask("write", WRITE, {
    event: event.title,
    claims: claims.map(({ id, s, text, speaker, status }) => ({ id, s, text, speaker, status })),
  });
  const lines = [...(card.sentences || []).map((line) => ({ ...line, kind: "sentence" })), ...(card.doubts || []).map((line) => ({ ...line, kind: "doubt" }))]
    .map((line, k) => withCitations({ ...line, text: koreanUnits(line.text), k }, claims));
  const repaired = await repairLines(await checkLines(lines, event, ask), claims, event, ask);
  return {
    title: koreanUnits(card.title),
    lines: repaired.map(({ kind, text, claims: ids, problems, passed, before, beforeProblems }) => ({ kind, text, claims: ids || [], problems, passed, before, beforeProblems })),
  };
}

// 앞 카드와 되풀이되는 문장을 뒤 카드에서 뺀다. 첫 문장은 사건을 소개하므로 남기고, 새 사실이 두 문장도 안 남으면 카드를 뺀다.
export function removeRepeats(results, drops) {
  return results.map((row, c) => {
    if (!row.card || c === 0) return row;
    const gone = new Set(drops.filter((drop) => Number(drop.c) === c).map((drop) => Number(drop.k)).filter((k) => k > 0 && row.card.lines[k]?.kind !== "doubt"));
    if (!gone.size) return row;
    const lines = row.card.lines.filter((_, k) => !gone.has(k));
    const removed = row.card.lines.filter((_, k) => gone.has(k));
    const sentences = lines.filter((line) => line.kind === "sentence" && line.passed).length;
    if (sentences < 2) return { ...row, card: null, repeated: row.card };
    return { ...row, card: { ...row.card, lines, removed } };
  });
}

async function trimRepeats(results, ask) {
  const cards = results.flatMap((row, c) => (solidCard(row.card) ? [{ c, title: row.card.title, lines: row.card.lines.map(({ text, kind }, k) => ({ k, kind, text })) }] : []));
  if (cards.length < 2) return results;
  const { drop = [] } = await optional(ask)("overlap", OVERLAP, { cards });
  return removeRepeats(results, drop);
}

const REVIEW_ISSUES = new Set(["off_topic", "shallow", "unclear", "duplicate", "korea"]);
const fingerprint = (url) => createHash("sha256").update(articleKey(url)).digest("hex").slice(0, 8);

// 다 만든 카드를 읽어 문제 종류만 표시한다. 카드는 바꾸지 않는다.
async function reviewCards(results, ask) {
  const cards = results.filter((row) => solidCard(row.card)).map((row, c) => ({ c, title: row.card.title, lines: row.card.lines.filter((line) => line.passed).map((line) => line.text) }));
  if (!cards.length) return { flags: [] };
  const { flags = [] } = await optional(ask)("review", REVIEW, { cards });
  return { flags };
}

// 공개 로그용 요약이다. 글자는 넣지 않고 개수와 기사 주소 지문만 남긴다.
export function qualitySummary(results, review = { flags: [] }) {
  const solid = results.filter((row) => solidCard(row.card));
  const lines = solid.flatMap((row) => row.card.lines);
  const kept = lines.filter((line) => line.passed);
  const flags = {};
  const flagged = [];
  for (const { c, issue } of review.flags) {
    const name = REVIEW_ISSUES.has(issue) ? issue : "other";
    flags[name] = (flags[name] || 0) + 1;
    if (Number.isInteger(Number(c))) flagged.push([Number(c), name]);
  }
  return {
    cards: solid.length,
    thin: results.filter((row) => row.card && !solidCard(row.card)).length,
    noCard: results.filter((row) => !row.card).length,
    oneOutlet: solid.filter((row) => row.event.outlets.length === 1).length,
    failedLines: results.flatMap((row) => row.card?.lines || []).filter((line) => !line.passed).length,
    doubts: kept.filter((line) => line.kind === "doubt").length,
    english: kept.filter((line) => latinNames(line.text).length).length,
    claims: solid.flatMap((row) => row.claims || []).length,
    claimsUsed: solid.reduce((sum, row) => sum + new Set(row.card.lines.filter((line) => line.passed).flatMap((line) => line.claims || [])).size, 0),
    flags,
    flagged,
    ranks: solid.map((row) => row.event.items.map((item) => fingerprint(item.url))),
  };
}

export async function runLab({ items, ask, read, now, wait = async () => {}, profile = BASELINE }) {
  const collapsed = collapseDuplicates(items).map((item, index) => ({ ...item, id: index + 1 }));
  const { events: grouped = [] } = await ask("group", GROUP, {
    items: collapsed.map((item) => ({ n: item.id, s: item.source, t: item.title, d: item.desc.slice(0, 200) })),
  });
  // 한 번에 350건을 보면 관련 기사를 놓치므로, 남은 기사 중 미국 소식으로 보이는 것을 사건에 다시 붙여 본다.
  const placed = new Set(grouped.flatMap((event) => (event.ids || []).map(Number)));
  const rest = collapsed.filter((item) => !placed.has(item.id) && (item.region === "overseas" || US_HINT.test(item.title)));
  if (rest.length && grouped.length) {
    const { assign = [] } = await optional(ask)("attach", ATTACH, {
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
    return { title: String(event.title || ""), reason: String(event.reason || ""), items: members };
  }).filter((event) => event.title && event.items.length);

  // 전체를 한 번에 묶으면 같은 사건이 나뉠 때가 있어, 순위 상위 사건끼리 다시 비교한다.
  let events = rank(sorted, now);
  if (events.length > 1) {
    const pool = events.slice(0, MERGE_POOL);
    const { merges = [], topics = [] } = await optional(ask)("merge", MERGE, {
      events: pool.map((event, e) => ({ e, title: event.title, reason: event.reason, articles: event.items.slice(0, 8).map((item) => item.title) })),
    });
    const labelled = pool.map((event, e) => ({ ...event, topic: String(topics.find((row) => Number(row.e) === e)?.topic || "") }));
    events = mergeEvents([...labelled, ...events.slice(MERGE_POOL)], merges, now);
  }

  const chosen = pickEvents(events);
  const build = async (rows) => {
    const built = [];
    for (const event of rows) built.push({ event, reads: await readEvent(event, read, wait) });
    return mapLimited(built, async ({ event, reads }) => {
      // 한 사건이 실패하면 그 사건만 비우고, 다음 순위 사건이 자리를 채운다.
      try {
        const { claims, dropped } = await claimsFor(event, reads, ask, profile.pointers);
        return { event, reads, claims, dropped, card: await writeCard(event, claims, ask) };
      } catch (error) {
        console.warn(`card skipped: ${error.message}`);
        return { event, reads, claims: [], dropped: [], card: null };
      }
    });
  };
  // 모자란 장수만큼만 다음 후보를 만든다.
  let written = [];
  let next = 0;
  while (next < chosen.length) {
    const need = MAX_CARDS - written.filter((row) => solidCard(row.card)).length;
    if (need <= 0) break;
    const size = Math.max(need, profile.wave);
    written = await trimRepeats([...written, ...await build(chosen.slice(next, next + size))], ask);
    next += size;
  }
  const results = capCards(written);

  return {
    collapsed,
    events,
    results,
    review: await reviewCards(results, ask),
    relevant: seen.size,
  };
}
