const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };

export function decode(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

// 설명 안의 HTML은 이중으로 인코딩된 경우가 있어 태그 제거를 두 번 한다.
export const clean = (text) => decode(decode(text).replace(/<[^>]*>/g, " ")).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match ? match[1] : "";
}

function link(block) {
  const text = clean(tag(block, "link"));
  if (text) return text;
  const atom = block.match(/<link\b[^>]*href="([^"]+)"/i);
  return atom ? decode(atom[1]) : clean(tag(block, "guid"));
}

export function parseFeed(xml, feed) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const isGoogle = feed.url.includes("news.google.com");
  return blocks.map((block) => {
    const outlet = clean(tag(block, "source"));
    let title = clean(tag(block, "title"));
    if (isGoogle && outlet && title.endsWith(` - ${outlet}`)) title = title.slice(0, -outlet.length - 3).trim();
    // 구글 뉴스 설명은 제목과 언론사 이름뿐이라 근거로 치지 않는다.
    const desc = isGoogle ? "" : clean(tag(block, "description") || tag(block, "summary") || tag(block, "content:encoded"));
    const stamp = clean(tag(block, "pubDate") || tag(block, "dc:date") || tag(block, "published") || tag(block, "updated"));
    const time = stamp ? new Date(stamp).getTime() : NaN;
    return {
      title,
      desc: desc === title ? "" : desc,
      url: link(block),
      source: isGoogle && outlet ? outlet : feed.name,
      region: feed.region,
      lang: feed.lang,
      use: feed.use,
      card: feed.card || null,
      topic: feed.topic || null,
      publishedAt: Number.isFinite(time) ? time : null,
    };
  }).filter((item) => item.title && /^https?:\/\//.test(item.url));
}
