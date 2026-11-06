import { put } from "@vercel/blob";
import { verifyActionsToken } from "../lib/oidc.js";

const write = (path, body) => put(path, body, {
  access: "private",
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: "application/json; charset=utf-8",
  cacheControlMaxAge: 60,
});

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    await verifyActionsToken(String(req.headers.authorization || "").replace(/^Bearer /, ""));
  } catch (error) {
    console.warn(`ingest rejected: ${error.message}`);
    return res.status(404).json({ error: "not found" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  const report = req.body;
  if (!report?.createdAt || !Array.isArray(report.results)) return res.status(400).json({ error: "bad report" });
  const body = JSON.stringify(report);
  await write(`lab/runs/${report.createdAt.replace(/[:.]/g, "-")}.json`, body);
  await write("lab/latest.json", body);
  return res.status(200).json({ saved: report.createdAt });
}
