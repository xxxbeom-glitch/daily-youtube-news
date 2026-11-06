import { clean } from "./rss.js";

const ENDPOINT = "https://naverapihub.apigw.ntruss.com/search/v1/news";
const PER_QUERY = 100;

// 네이버 응답에는 언론사 이름이 없어 원문 주소로 알아낸다. 목록에 없는 곳의 기사는 쓰지 않는다.
const OUTLETS = {
  "yna.co.kr": "연합뉴스", "newsis.com": "뉴시스", "news1.kr": "뉴스1",
  "chosun.com": "조선일보", "joongang.co.kr": "중앙일보", "donga.com": "동아일보",
  "hani.co.kr": "한겨레", "khan.co.kr": "경향신문", "hankookilbo.com": "한국일보",
  "seoul.co.kr": "서울신문", "kmib.co.kr": "국민일보", "munhwa.com": "문화일보", "segye.com": "세계일보",
  "mk.co.kr": "매일경제", "hankyung.com": "한국경제", "sedaily.com": "서울경제",
  "mt.co.kr": "머니투데이", "edaily.co.kr": "이데일리", "asiae.co.kr": "아시아경제",
  "fnnews.com": "파이낸셜뉴스", "heraldcorp.com": "헤럴드경제",
  "kbs.co.kr": "KBS", "imbc.com": "MBC", "sbs.co.kr": "SBS", "jtbc.co.kr": "JTBC",
  "ytn.co.kr": "YTN", "ichannela.com": "채널A", "tvchosun.com": "TV조선", "mbn.co.kr": "MBN",
};

export function outletName(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i += 1) {
    const name = OUTLETS[parts.slice(i).join(".")];
    if (name) return name;
  }
  return "";
}

export const naverFeed = (topic) => {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ query: topic.query, display: String(PER_QUERY), sort: "date" }).toString();
  return {
    name: `네이버 ${topic.name}`,
    url: url.toString(),
    region: "domestic",
    lang: "ko",
    use: "topic",
    card: topic.card,
    topic: topic.name,
    naver: true,
    limit: PER_QUERY,
  };
};

// 검색어 강조 태그는 단어 중간에 붙으므로 공백 없이 지운다.
const plain = (text) => clean(String(text || "").replace(/<\/?b>/gi, ""));

export function parseNaver(body, feed) {
  return (body.items || []).map((row) => {
    const url = row.originallink || row.link || "";
    const title = plain(row.title);
    const desc = plain(row.description);
    const time = new Date(row.pubDate).getTime();
    return {
      title,
      desc: desc === title ? "" : desc,
      url,
      source: outletName(url),
      region: feed.region,
      lang: feed.lang,
      use: feed.use,
      card: feed.card,
      topic: feed.topic,
      via: "naver",
      publishedAt: Number.isFinite(time) ? time : null,
    };
  }).filter((item) => item.title && item.source && /^https?:\/\//.test(item.url));
}

export async function fetchNaver(feed, keys, fetcher) {
  const response = await fetcher(feed.url, {
    headers: { "X-NCP-APIGW-API-KEY-ID": keys.id, "X-NCP-APIGW-API-KEY": keys.secret },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseNaver(await response.json(), feed);
}

// 키 두 개가 모두 있을 때만 네이버 수집을 켠다.
export function naverKeys(env = process.env) {
  const id = env.NAVER_API_KEY_ID;
  const secret = env.NAVER_API_KEY;
  return id && secret ? { id, secret } : null;
}
