import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePlacements, parsePlacements, readPlacements } from "../lab/placements.js";

const labels = { outlet: "매일경제", url: "https://www.mk.co.kr/news/world", mode: "labels", link: "/news/[a-z]+/\\d{6,}" };
const order = { outlet: "가디언", url: "https://www.theguardian.com/us/business", mode: "order", link: "/20\\d\\d/[a-z]{3}/\\d\\d/" };
const mk = (id, section) => `<a data-section="${section}" href="https://www.mk.co.kr/news/world/${id}">충분히 긴 기사 제목입니다 ${id}</a>`;

test("칸 이름이 있는 페이지는 윗칸과 주요기사만 읽는다", () => {
  const html = [mk(1000001, "sub-top"), mk(1000002, "주요기사"), mk(1000003, "많이 본 기사"), mk(1000004, "최신기사")].join("");
  assert.deepEqual(parsePlacements(html, labels).map(({ key, tier }) => [key, tier]), [
    ["mk.co.kr/news/world/1000001", "top"],
    ["mk.co.kr/news/world/1000002", "major"],
  ]);
});

test("같은 기사가 두 칸에 있으면 높은 등급만 남고 안내 링크는 뺀다", () => {
  const html = `${mk(1000002, "주요기사")}${mk(1000002, "sub-top")}<a data-section="sub-top" href="https://www.mk.co.kr/news/world/1000009#stock_story">충분히 긴 안내 링크입니다</a>`;
  assert.deepEqual(parsePlacements(html, labels).map(({ tier }) => tier), ["top"]);
});

test("칸 이름이 없는 페이지는 순서로 등급을 정하고 메뉴는 뺀다", () => {
  const link = (n) => `<a href="/business/2026/nov/06/story-${n}">충분히 긴 기사 제목입니다 ${n}</a>`;
  const html = `<nav>${link(99)}</nav>${Array.from({ length: 14 }, (_, n) => link(n + 1)).join("")}`;
  const rows = parsePlacements(html, order);
  assert.equal(rows.length, 12);
  assert.equal(rows[0].key, "theguardian.com/business/2026/nov/06/story-1");
  assert.deepEqual([rows[4].tier, rows[5].tier], ["top", "major"]);
});

test("기사에 언론사별 위치를 달고 한 언론사의 높은 등급만 센다", () => {
  const items = [{ url: "https://www.mk.co.kr/news/world/1?x=1" }, { url: "https://a.example/2" }];
  const rows = mergePlacements(items, [
    { key: "mk.co.kr/news/world/1", outlet: "매일경제", tier: "major" },
    { key: "mk.co.kr/news/world/1", outlet: "매일경제", tier: "top" },
  ]);
  assert.deepEqual(rows[0].placement, { top: ["매일경제"], major: [] });
  assert.deepEqual(rows[1].placement, { top: [], major: [] });
});

test("막힌 페이지는 열지 않고 실패한 페이지만 건너뛴다", async () => {
  const opened = [];
  const fetcher = async (url) => {
    opened.push(url);
    if (url.endsWith("/robots.txt")) return { ok: true, text: async () => "User-agent: *\nDisallow: /blocked" };
    if (url.endsWith("/broken")) return { ok: false, status: 500 };
    return { ok: true, text: async () => mk(1000001, "sub-top") };
  };
  const site = "https://www.mk.co.kr";
  const { placements, log } = await readPlacements([
    { ...labels, url: `${site}/blocked` }, { ...labels, url: `${site}/broken` }, { ...labels, url: `${site}/ok` },
  ], { fetcher });
  assert.equal(opened.includes(`${site}/blocked`), false);
  assert.equal(placements.length, 1);
  assert.deepEqual(log.map((row) => row.status), ["robots", "failed", "ok"]);
});
