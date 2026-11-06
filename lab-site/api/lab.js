import { get } from "@vercel/blob";
import { hasAccess } from "../lib/access.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!hasAccess(req.headers.cookie, process.env.BRIEF_ACCESS_TOKEN)) return res.status(401).json({ error: "locked" });
  const file = await get("lab/latest.json", { access: "private", useCache: false });
  if (!file || !file.stream) return res.status(404).json({ error: "empty" });
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).send(await new Response(file.stream).text());
}
