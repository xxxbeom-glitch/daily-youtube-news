import { BlobNotFoundError, del, head, list, put } from "@vercel/blob";
import { verifyActionsToken } from "../lib/oidc.js";

const KEEP_DAYS = 14;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const write = (path, body) => put(path, body, {
  access: "private",
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: "application/json; charset=utf-8",
  cacheControlMaxAge: 60,
});

async function uploadedAt(path) {
  try {
    return (await head(path)).uploadedAt;
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
}

async function removeOld(today) {
  const limit = new Date(new Date(`${today}T00:00:00Z`).getTime() - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
  const { blobs } = await list({ prefix: "briefings/" });
  const old = blobs.filter((blob) => {
    const day = blob.pathname.slice("briefings/".length, "briefings/".length + 10);
    return DATE.test(day) && day < limit;
  });
  if (old.length) await del(old.map((blob) => blob.url));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    await verifyActionsToken(String(req.headers.authorization || "").replace(/^Bearer /, ""));
  } catch (error) {
    console.warn(`ingest rejected: ${error.message}`);
    return res.status(404).json({ error: "not found" });
  }
  if (req.method === "GET") {
    const date = String(req.query.date || "");
    if (!DATE.test(date)) return res.status(400).json({ error: "bad date" });
    return res.status(200).json({ uploadedAt: await uploadedAt(`briefings/${date}.json`) });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  const brief = req.body;
  if (!DATE.test(brief?.date || "") || !Array.isArray(brief.cards) || !brief.cards.length) {
    return res.status(400).json({ error: "bad briefing" });
  }
  const body = JSON.stringify(brief);
  await write(`briefings/${brief.date}.json`, body);
  await write("briefings/latest.json", body);
  await removeOld(brief.date);
  return res.status(200).json({ saved: brief.date, cards: brief.cards.length });
}
