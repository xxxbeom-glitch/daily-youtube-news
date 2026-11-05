import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { test } from "node:test";
import { cookieValue, hasAccess, setCookie, tokenMatches } from "../lib/access.js";
import { AUDIENCE, ISSUER, REPOSITORY, WORKFLOW_REF, verifyActionsToken } from "../lib/oidc.js";

test("토큰과 쿠키를 확인한다", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abd", "abc"), false);
  assert.equal(tokenMatches("abc", undefined), false);
  assert.equal(hasAccess(`x=1; brief=${cookieValue("abc")}`, "abc"), true);
  assert.equal(hasAccess("brief=nope", "abc"), false);
  assert.equal(hasAccess(`brief=${cookieValue("abc")}`, undefined), false);
  assert.match(setCookie("abc"), /HttpOnly; Secure; SameSite=Lax/);
});

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = async () => ({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" }] });
const NOW = 1_800_000_000_000;
const good = {
  iss: ISSUER, aud: AUDIENCE, repository: REPOSITORY, ref: "refs/heads/main", workflow_ref: WORKFLOW_REF,
  exp: NOW / 1000 + 300, nbf: NOW / 1000 - 10,
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function sign(claims, key = privateKey) {
  const body = `${b64({ alg: "RS256", kid: "k1" })}.${b64(claims)}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key).toString("base64url")}`;
}

test("이 저장소 main의 워크플로 토큰만 통과한다", async () => {
  const check = (claims, key) => verifyActionsToken(sign(claims, key), { jwks, now: NOW });
  assert.equal((await check(good)).repository, REPOSITORY);
  await assert.rejects(check({ ...good, repository: "someone/fork" }), /bad repository/);
  await assert.rejects(check({ ...good, ref: "refs/heads/feature" }), /bad ref/);
  await assert.rejects(check({ ...good, aud: "other" }), /bad audience/);
  await assert.rejects(check({ ...good, workflow_ref: `${REPOSITORY}/.github/workflows/x.yml@refs/heads/main` }), /bad workflow/);
  await assert.rejects(check({ ...good, exp: NOW / 1000 - 1 }), /expired/);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await assert.rejects(check(good, other), /bad signature/);
  await assert.rejects(verifyActionsToken("x", { jwks, now: NOW }), /malformed/);
});
