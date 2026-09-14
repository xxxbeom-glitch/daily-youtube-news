function originFromRequest(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const setupSecret = process.env.SETUP_SECRET;
  if (setupSecret && req.query.state !== setupSecret) {
    return res.status(401).send("OAuth state mismatch");
  }

  const code = req.query.code;
  if (!code) return res.status(400).send(`OAuth error: ${escapeHtml(req.query.error || "missing code")}`);

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).send("Google OAuth client is not configured");

  const redirectUri = `${originFromRequest(req)}/api/auth/callback`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: String(code),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await response.json();
  if (!response.ok) {
    return res.status(500).send(`<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`);
  }

  if (!data.refresh_token) {
    return res.status(500).send("No refresh token was returned. Re-run authorization and ensure prompt=consent.");
  }

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.status(200).send(`<!doctype html>
<html lang="ko"><meta charset="utf-8"><title>YouTube OAuth 완료</title>
<body style="font-family:system-ui;max-width:760px;margin:48px auto;line-height:1.6">
<h1>YouTube OAuth 완료</h1>
<p>아래 값은 민감한 <strong>refresh token</strong>입니다. 채팅에 보내지 말고 Vercel의 <code>YOUTUBE_REFRESH_TOKEN</code> 환경 변수에만 저장하세요.</p>
<textarea readonly style="width:100%;height:140px">${escapeHtml(data.refresh_token)}</textarea>
<p>저장한 뒤 이 페이지는 닫아도 됩니다.</p>
</body></html>`);
}
