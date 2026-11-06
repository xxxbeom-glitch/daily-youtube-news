import { createPublicKey, createVerify } from "node:crypto";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "morning-brief-lab";
const REPOSITORY = "xxxbeom-glitch/daily-youtube-news";
const REF = "refs/heads/lab/us-economy";
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/brief-lab.yml@${REF}`;

const part = (text) => JSON.parse(Buffer.from(text, "base64url").toString("utf8"));

async function fetchJwks() {
  const response = await fetch(`${ISSUER}/.well-known/jwks`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`JWKS ${response.status}`);
  return response.json();
}

// 시험 브랜치의 시험 워크플로가 보낸 요청만 받는다.
export async function verifyActionsToken(token) {
  const [head, body, signature] = String(token || "").split(".");
  if (!head || !body || !signature) throw new Error("malformed token");
  const header = part(head);
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  const { keys } = await fetchJwks();
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("unknown key");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${head}.${body}`);
  if (!verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature, "base64url"))) {
    throw new Error("bad signature");
  }
  const claims = part(body);
  const seconds = Date.now() / 1000;
  if (claims.iss !== ISSUER) throw new Error("bad issuer");
  if (claims.aud !== AUDIENCE) throw new Error("bad audience");
  if (!(claims.exp > seconds) || claims.nbf > seconds + 60) throw new Error("expired");
  if (claims.repository !== REPOSITORY) throw new Error("bad repository");
  if (claims.ref !== REF) throw new Error("bad ref");
  if (claims.workflow_ref !== WORKFLOW_REF) throw new Error("bad workflow");
  return claims;
}
