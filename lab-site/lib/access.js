import { createHash, timingSafeEqual } from "node:crypto";

export const COOKIE = "lab";
const digest = (text) => createHash("sha256").update(String(text)).digest("hex");

export function tokenMatches(token, secret) {
  if (!secret || !token) return false;
  return timingSafeEqual(Buffer.from(digest(token)), Buffer.from(digest(secret)));
}

export const cookieValue = (secret) => digest(`cookie:${secret}`);

export function hasAccess(cookieHeader, secret) {
  if (!secret) return false;
  const pair = String(cookieHeader || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!pair) return false;
  const value = Buffer.from(pair.slice(COOKIE.length + 1));
  const expected = Buffer.from(cookieValue(secret));
  return value.length === expected.length && timingSafeEqual(value, expected);
}

export const setCookie = (secret) => `${COOKIE}=${cookieValue(secret)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`;
