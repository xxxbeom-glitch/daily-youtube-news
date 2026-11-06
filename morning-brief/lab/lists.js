import { clean } from "../lib/rss.js";

const US_TITLE = /미국|美|뉴욕|월가|나스닥|S&P|다우|연준|파월|FOMC|트럼프|관세|엔비디아|테슬라|애플|아마존|마이크로소프트|메타|알파벳|구글|베선트|국채|달러|빅테크|고용|CPI|PCE|실업률|\bFed\b|Powell|\bDow\b|Nasdaq|Trump|Bessent|Nvidia|Tesla|Apple|Amazon|Microsoft|Alphabet|Google|Meta\b|\bAI\b|U\.S\.|\bUS\b|America/;
// 일반 단어는 제목 맨 앞에서 대문자로 시작하므로 대소문자를 가리지 않는다. 약어는 "us"가 걸리지 않게 위에 둔다.
const US_WORDS = /federal reserve|wall street|\bstocks?\b|\btariffs?\b|\btreasury\b|\btreasuries\b|\binflation\b|\bpayrolls?\b|\bjobs report\b|\bunemployment\b|\bearnings\b/i;

// 같은 기사인지 볼 때는 추적값, www, 끝 슬래시를 무시한다.
export function articleKey(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return hostname.replace(/^www\./, "") + pathname.replace(/\/$/, "");
  } catch {
    return String(url);
  }
}

// 언론사가 robots.txt에 밝힌 공개 기사 목록을 읽는다. 소개글은 없다.
export function parseSitemap(xml, outlet) {
  return [...String(xml).matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, block]) => {
    const url = clean(block.match(/<loc>([\s\S]*?)<\/loc>/)?.[1]);
    const title = clean(block.match(/<(?:news|n):title>([\s\S]*?)<\/(?:news|n):title>/)?.[1]);
    const time = new Date(clean(block.match(/<(?:news|n):publication_date>([\s\S]*?)<\/(?:news|n):publication_date>/)?.[1])).getTime();
    return { title, desc: "", url, source: outlet.name, region: outlet.region, lang: outlet.lang, use: "lab", via: "list", publishedAt: Number.isFinite(time) ? time : null };
  }).filter((item) => item.title && /^https?:\/\//.test(item.url));
}

export const usCandidate = (item) => US_TITLE.test(item.title) || US_WORDS.test(item.title);

// 공개 로그에 남길 개수만 모은다. 기사 제목이나 내용은 넣지 않는다.
export function countSummary(items, log) {
  const outlets = {};
  for (const item of items) outlets[item.source] = (outlets[item.source] || 0) + 1;
  return {
    outlets,
    listCandidates: log.filter((row) => row.via === "목록").reduce((sum, row) => sum + (row.kept || 0), 0),
    placed: items.filter((item) => item.placement.top.length + item.placement.major.length).length,
    pageFailures: log.filter((row) => row.via === "편집 위치" && row.status !== "ok").length,
  };
}
