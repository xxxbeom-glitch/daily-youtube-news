import { clean } from "../lib/rss.js";

const US_TITLE = /미국|美|뉴욕|월가|나스닥|S&P|다우|연준|파월|FOMC|트럼프|관세|엔비디아|테슬라|애플|아마존|마이크로소프트|메타|알파벳|구글|베선트|국채|달러|빅테크|고용|CPI|PCE|실업률|\bFed\b|Federal Reserve|Powell|Wall Street|stocks?\b|\bDow\b|Nasdaq|tariffs?|Treasury|Treasuries|inflation|payrolls?|jobs report|unemployment|earnings|Trump|Bessent|Nvidia|Tesla|Apple|Amazon|Microsoft|Alphabet|Google|Meta\b|\bAI\b|U\.S\.|\bUS\b|America/;

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

export const usCandidate = (item) => US_TITLE.test(item.title);
