import { load } from "cheerio";
import { USER_AGENT, robotsAllows } from "./article.js";
import { articleKey } from "./lists.js";

const TOP_RANK = 5;
const MAJOR_RANK = 12;
const MIN_TITLE = 12;
const SECTIONS = { "sub-top": "top", "주요기사": "major" };

function links($, page) {
  const pattern = new RegExp(page.link);
  const seen = new Map();
  $("a[href]").each((_, node) => {
    const link = $(node);
    const href = link.attr("href");
    if (href.includes("#") || !pattern.test(href) || link.closest("nav,header,footer").length) return;
    if (link.text().replace(/\s+/g, " ").trim().length < MIN_TITLE) return;
    const key = articleKey(new URL(href, page.url).href);
    seen.set(key, [...(seen.get(key) || []), link.attr("data-section") || ""]);
  });
  return [...seen.entries()].map(([key, sections]) => ({ key, sections }));
}

// 언론사가 페이지에 놓은 위치를 등급으로 바꾼다. 칸 이름이 없으면 위에서부터의 순서로 본다.
export function parsePlacements(html, page) {
  const rows = links(load(html), page);
  if (page.mode === "labels") {
    return rows.flatMap(({ key, sections }) => {
      const tiers = sections.map((section) => SECTIONS[section]).filter(Boolean);
      if (!tiers.length) return [];
      return [{ key, outlet: page.outlet, tier: tiers.includes("top") ? "top" : "major" }];
    });
  }
  return rows.slice(0, MAJOR_RANK).map(({ key }, index) => ({ key, outlet: page.outlet, tier: index < TOP_RANK ? "top" : "major" }));
}

export function mergePlacements(items, placements) {
  return items.map((item) => {
    const rows = placements.filter((row) => row.key === articleKey(item.url));
    const top = [...new Set(rows.filter((row) => row.tier === "top").map((row) => row.outlet))];
    const major = [...new Set(rows.filter((row) => row.tier === "major").map((row) => row.outlet))].filter((outlet) => !top.includes(outlet));
    return { ...item, placement: { top, major } };
  });
}

// 막히거나 실패한 페이지는 재시도 없이 건너뛰고 상태만 남긴다.
export async function readPlacements(pages, { fetcher = fetch, wait = async () => {} } = {}) {
  const headers = { "user-agent": USER_AGENT };
  const robots = new Map();
  const placements = [];
  const log = [];
  for (const page of pages) {
    const { origin, pathname } = new URL(page.url);
    try {
      if (!robots.has(origin)) {
        const response = await fetcher(`${origin}/robots.txt`, { headers, signal: AbortSignal.timeout(10000) });
        robots.set(origin, response.ok ? await response.text() : "");
      }
      if (!robotsAllows(robots.get(origin), pathname)) {
        log.push({ name: page.outlet, via: "편집 위치", status: "robots" });
        continue;
      }
      const response = await fetcher(page.url, { headers, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows = parsePlacements(await response.text(), page);
      placements.push(...rows);
      log.push({ name: page.outlet, via: "편집 위치", status: "ok", received: rows.length });
    } catch (error) {
      log.push({ name: page.outlet, via: "편집 위치", status: "failed", error: error.message });
    }
    await wait();
  }
  return { placements, log };
}
