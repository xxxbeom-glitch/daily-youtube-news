import { load } from "cheerio";

export const USER_AGENT = "Mozilla/5.0 (compatible; morning-brief/1.0)";
const MIN_BODY = 300;
const PAYWALL = /구독자 전용|유료 회원|유료회원|로그인 후 (?:이용|열람)|프리미엄 회원|Subscribe to (?:continue|read)|subscribers only|Become a member|CNBC Investing Club|Pro subscribers/i;

// 언론사별 본문 위치. 없으면 구조화 데이터와 일반 규칙으로 찾는다.
const BODY_SELECTORS = {
  "mk.co.kr": [".news_cnt_detail_wrap"],
  "hankyung.com": ["#articletxt", ".article-body"],
  "kbs.co.kr": ["#cont_newstext", ".detail-body"],
  "jtbc.co.kr": ["#ijam_content", "[class*=article_content]", "[class*=articleContent]", "article"],
  "cnbc.com": [".ArticleBody-articleBody", ".group"],
  "theguardian.com": ["[data-gu-name=body]", "#maincontent"],
  "npr.org": ["#storytext"],
  "bbc.com": ["article"],
  "bbc.co.uk": ["article"],
};
const NOISE = "script,style,noscript,iframe,figure,figcaption,aside,nav,footer,form,button,.ad,.ads,[class*=banner],[class*=related],[class*=Related],[class*=recommend],[class*=share],[class*=copyright],[data-component=links-block],[data-component=tags]";

const squeeze = (text) => String(text || "").replace(/\s+/g, " ").trim();

function fromStructuredData($) {
  let best = "";
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.articleBody === "string" && value.articleBody.length > best.length) best = value.articleBody;
    Object.values(value).forEach(walk);
  };
  $("script[type='application/ld+json']").each((_, node) => {
    try { walk(JSON.parse($(node).text())); } catch { /* 깨진 구조화 데이터는 건너뛴다. */ }
  });
  return squeeze(load(`<div>${best}</div>`).text());
}

function fromSelectors($, host) {
  const key = Object.keys(BODY_SELECTORS).find((name) => host === name || host.endsWith(`.${name}`));
  for (const selector of BODY_SELECTORS[key] || []) {
    const parts = $(selector).toArray().map((node) => {
      const copy = $(node).clone();
      copy.find(NOISE).remove();
      copy.find("br").replaceWith(" ");
      copy.find("p,div,li").append(" ");
      return squeeze(copy.text());
    });
    const text = parts.join(" ");
    if (text.length >= MIN_BODY) return text;
  }
  return "";
}

// JTBC는 화면을 스크립트로 그려서 본문이 페이지 안의 데이터 칸에 들어 있다.
function fromPageData(html) {
  const values = [...html.matchAll(/articleInnerTextContent\\*":\s*\\*"([\s\S]*?)\\*",\\*"[a-zA-Z]/g)].map((match) => match[1]);
  const longest = values.sort((a, b) => b.length - a.length)[0];
  if (!longest) return "";
  const text = longest.replace(/\\+n/g, " ").replace(/\\+"/g, '"').replace(/\\+u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return squeeze(load(`<div>${text}</div>`).text());
}

function fromParagraphs($) {
  const scope = $("article").length ? $("article") : $("body");
  return scope.find("p").toArray().map((node) => squeeze($(node).text())).filter((text) => text.length > 30).join(" ");
}

export function extractBody(html, url) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const $ = load(html);
  const candidates = [
    { how: "언론사별 위치", text: fromSelectors($, host) },
    { how: "구조화 데이터", text: fromStructuredData($) },
    { how: "페이지 데이터", text: fromPageData(html) },
    { how: "문단 모음", text: fromParagraphs($) },
  ];
  const picked = candidates.find((candidate) => candidate.text.length >= MIN_BODY) || { how: "없음", text: "" };
  return { ...picked, paywall: PAYWALL.test($("body").text()) };
}

function robotsGroups(text) {
  const groups = [];
  let current = null;
  let agentLine = false;
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.replace(/#.*/, "").trim().match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "user-agent") {
      if (!agentLine) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      agentLine = true;
    } else {
      agentLine = false;
      if (current && value && (key === "allow" || key === "disallow")) current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return groups;
}

const pathPattern = (path) => new RegExp(`^${path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}`);

// 우리 프로그램에 적용되는 일반 규칙(*)으로 판단한다. 가장 긴 규칙이 이긴다.
export function robotsAllows(text, path) {
  const rules = robotsGroups(text).filter((group) => group.agents.includes("*")).flatMap((group) => group.rules);
  let best = null;
  for (const rule of rules) {
    if (!pathPattern(rule.path).test(path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

// 막히면 재시도나 우회를 하지 않고 상태만 남긴다.
export function articleReader(fetcher = fetch) {
  const robots = new Map();
  const headers = { "user-agent": USER_AGENT };
  async function robotsFor(origin) {
    if (!robots.has(origin)) {
      robots.set(origin, fetcher(`${origin}/robots.txt`, { headers, signal: AbortSignal.timeout(10000) })
        .then((response) => (response.ok ? response.text() : ""))
        .catch(() => ""));
    }
    return robots.get(origin);
  }
  return async function read(url) {
    const target = new URL(url);
    if (!robotsAllows(await robotsFor(target.origin), target.pathname + target.search)) return { status: "robots", body: "" };
    try {
      const response = await fetcher(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!response.ok) return { status: "blocked", http: response.status, body: "" };
      const { how, text, paywall } = extractBody(await response.text(), response.url || url);
      if (paywall && text.length < 1500) return { status: "paywall", how, body: "" };
      if (text.length < MIN_BODY) return { status: "no-body", how, body: "" };
      return { status: "ok", how, body: text };
    } catch (error) {
      return { status: "failed", error: error.name, body: "" };
    }
  };
}
