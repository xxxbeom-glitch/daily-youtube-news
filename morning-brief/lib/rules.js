// 카드 규칙: AI 출력을 프로그램이 확인하는 부분. 수치는 설계 문서와 같다.
export const BLOCK_MAX = 140;
export const BLOCK_MIN_LATER = 60;
export const MAX_BLOCKS = 3;
export const TITLE_MAX = 20;
export const TOTAL_CARDS = 12;
export const MARKET_MAX = 6;
export const COMPANY_MAX = 4;
export const NEWS_MIN = 6;
export const OVERSEAS_MAX = 5;
export const SOURCES_MAX = 5;
export const HEADLINES_MAX = 30;
export const COMPANY_CATEGORIES = ["반도체", "빅테크", "AI 기업"];
const FIXED_CATEGORIES = ["미국 시황", "시장과 정치", "환율·원자재"];
export const MARKET_ORDER = [...FIXED_CATEGORIES, ...COMPANY_CATEGORIES];

const sentences = (text) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

// 문장 경계에서 나눈다. 앞은 140자 이하, 뒤는 60자 이상이면서 가장 균형 잡힌 지점을 고른다.
function splitAtSentence(text) {
  const parts = sentences(text);
  let best = null;
  for (let i = 1; i < parts.length; i += 1) {
    const head = parts.slice(0, i).join(" ");
    const tail = parts.slice(i).join(" ");
    if (head.length > BLOCK_MAX || tail.length < BLOCK_MIN_LATER) continue;
    const gap = Math.abs(head.length - tail.length);
    if (!best || gap < best.gap) best = { head, tail, gap };
  }
  return best ? [best.head, best.tail] : null;
}

function fitBlock(block) {
  if (block.length <= BLOCK_MAX) return [block];
  const split = splitAtSentence(block);
  if (split && split[1].length <= BLOCK_MAX) return split;
  const kept = [];
  for (const sentence of sentences(block)) {
    if ([...kept, sentence].join(" ").length > BLOCK_MAX) break;
    kept.push(sentence);
  }
  return kept.length ? [kept.join(" ")] : [];
}

export function normalizeBlocks(input) {
  const blocks = (input || []).map((b) => String(b || "").trim()).filter(Boolean);
  if (!blocks.length) return [];
  const whole = blocks.join(" ");
  if (whole.length <= BLOCK_MAX) return [whole];

  const out = [];
  for (const block of blocks.flatMap(fitBlock)) {
    if (out.length && block.length < BLOCK_MIN_LATER) {
      const merged = `${out[out.length - 1]} ${block}`;
      if (merged.length <= BLOCK_MAX) {
        out[out.length - 1] = merged;
      } else {
        const split = splitAtSentence(merged);
        if (split) out.splice(out.length - 1, 1, ...split);
      }
      continue;
    }
    out.push(block);
  }
  return out.slice(0, MAX_BLOCKS);
}

export const titleTooLong = (title) => String(title || "").length > TITLE_MAX;

export const distinctOutlets = (items) => new Set(items.map((item) => item.source)).size;

// 카드 근거: 설명이 있는 기사 1건 이상, 또는 서로 다른 언론사 제목 3건 이상.
export const hasEvidence = (items) => items.some((item) => item.desc) || distinctOutlets(items) >= 3;

// 언론사가 겹치지 않게 최대 5개. 해외와 국내를 번갈아 골라 섞는다.
export function pickSources(items) {
  const seen = new Set();
  const unique = items.filter((item) => {
    if (seen.has(item.source)) return false;
    seen.add(item.source);
    return true;
  });
  const home = unique.filter((item) => item.region === "domestic");
  const abroad = unique.filter((item) => item.region !== "domestic");
  const mixed = [];
  while (mixed.length < SOURCES_MAX && (home.length || abroad.length)) {
    const first = abroad.shift();
    if (first) mixed.push(first);
    const second = home.shift();
    if (second && mixed.length < SOURCES_MAX) mixed.push(second);
  }
  return mixed.map((item) => ({ name: item.source, url: item.url }));
}

// 시황 구역 장수 제한. cards는 { category, items }를 가진다.
export function limitMarketCards(cards, { marketOpen, majorOutlets }) {
  const major = new Set(majorOutlets);
  const majorCount = (card) => new Set(card.items.map((i) => i.source).filter((s) => major.has(s))).size;
  const usable = cards.filter((c) => MARKET_ORDER.includes(c.category) && hasEvidence(c.items)
    && (marketOpen || !FIXED_CATEGORIES.includes(c.category)));
  const fixed = FIXED_CATEGORIES.map((category) => usable.find((c) => c.category === category)).filter(Boolean);
  const companies = usable.filter((c) => COMPANY_CATEGORIES.includes(c.category))
    .sort((a, b) => distinctOutlets(b.items) - distinctOutlets(a.items));
  const kept = [];
  for (const card of companies) {
    if (kept.length >= COMPANY_MAX || fixed.length + kept.length >= MARKET_MAX) break;
    if (kept.length >= 2 && majorCount(card) < 3) continue;
    kept.push(card);
  }
  return [...fixed, ...kept];
}

// 같은 분야가 3건 연속되지 않게 한다. lib/select.js의 orderByImportanceWithDiversity와 같은 규칙.
export function orderWithDiversity(list) {
  const remaining = [...list];
  const ordered = [];
  while (remaining.length) {
    let index = 0;
    const [a, b] = ordered.slice(-2);
    if (b && a.category === b.category) {
      const other = remaining.findIndex((c) => c.category !== a.category);
      if (other >= 0) index = other;
    }
    ordered.push(remaining.splice(index, 1)[0]);
  }
  return ordered;
}

// 관심 주제 먼저, 그 안에서 중요도순.
export const byInterest = (a, b) => Number(b.interest) - Number(a.interest) || b.importance - a.importance;

export function limitOverseas(list, max = OVERSEAS_MAX) {
  let count = 0;
  return list.filter((card) => {
    if (card.scope !== "overseas") return true;
    count += 1;
    return count <= max;
  });
}

// 코스피는 급락·급등 제목이 5곳 이상의 언론사에서 나온 날만 다룬다.
export function kospiIsBigNews(items) {
  const hits = items.filter((i) => /코스피|KOSPI/i.test(i.title) && /급락|급등|폭락|폭등|서킷|사이드카/.test(i.title));
  return distinctOutlets(hits) >= 5;
}
export const isKospiCluster = (items) => items.filter((i) => /코스피|KOSPI/i.test(i.title)).length * 2 >= items.length;

export const kstDate = (date = new Date()) => new Date(date.getTime() + 9 * 3600e3).toISOString().slice(0, 10);

export const kstIso = (date = new Date()) => `${new Date(date.getTime() + 9 * 3600e3).toISOString().slice(0, 19)}+09:00`;

// 수집 구간 시작: 전날 18:00 KST.
export const windowStart = (now = new Date()) => new Date(new Date(`${kstDate(now)}T18:00:00+09:00`).getTime() - 86400e3);

// 뉴욕증시 마감 기사가 들어가기 전에 만든 파일은 그날 아침 브리핑으로 치지 않는다.
export const isMorningFile = (uploadedAt, date) => Boolean(uploadedAt) && new Date(uploadedAt) >= new Date(`${date}T06:00:00+09:00`);

// 한국 아침 기준으로 전날(미국 현지 날짜)에 뉴욕증시가 열렸는지 확인한다.
export function marketWasOpen(now, holidays) {
  const us = new Date(new Date(`${kstDate(now)}T00:00:00Z`).getTime() - 86400e3);
  const weekday = us.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !holidays.includes(us.toISOString().slice(0, 10));
}
