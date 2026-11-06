import { setCookie, tokenMatches } from "../lib/access.js";

export default function handler(req, res) {
  const secret = process.env.BRIEF_ACCESS_TOKEN;
  if (!tokenMatches(req.query.token, secret)) return res.status(404).send("Not found");
  res.setHeader("Set-Cookie", setCookie(secret));
  res.setHeader("Cache-Control", "no-store");
  return res.redirect(302, "/");
}
