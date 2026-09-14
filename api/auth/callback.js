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

async function getAuthorizedChannel(accessToken) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("mine", "true");
  url.searchParams.set("maxResults", "1");

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) return null;
  const data = await response.json();
  const channel = data.items?.[0];
  if (!channel) return null;

  return {
    id: channel.id,
    title: channel.snippet?.title || "(이름 없음)",
    thumbnail:
      channel.snippet?.thumbnails?.default?.url ||
      channel.snippet?.thumbnails?.medium?.url ||
      "",
  };
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

  const channel = data.access_token ? await getAuthorizedChannel(data.access_token) : null;
  const channelHtml = channel
    ? `<div style="display:flex;gap:14px;align-items:center;padding:14px 16px;border:1px solid #ddd;border-radius:12px;margin:20px 0">
        ${channel.thumbnail ? `<img src="${escapeHtml(channel.thumbnail)}" alt="" width="48" height="48" style="border-radius:50%">` : ""}
        <div><div style="font-size:14px;color:#666">연결된 YouTube 채널</div><strong style="font-size:20px">${escapeHtml(channel.title)}</strong><div style="font-size:12px;color:#777;margin-top:4px">${escapeHtml(channel.id)}</div></div>
      </div>`
    : `<p><strong>연결된 YouTube 채널을 확인하지 못했습니다.</strong></p>`;

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.status(200).send(`<!doctype html>
<html lang="ko"><meta charset="utf-8"><title>YouTube OAuth 완료</title>
<body style="font-family:system-ui;max-width:760px;margin:48px auto;line-height:1.6;padding:0 20px">
<h1>YouTube OAuth 완료</h1>
${channelHtml}
<p>위 채널이 <strong>머스크형</strong>인지 먼저 확인하세요. 맞을 때만 아래 refresh token을 Vercel의 <code>YOUTUBE_REFRESH_TOKEN</code> 환경 변수에 저장하세요.</p>
<textarea readonly style="width:100%;height:140px">${escapeHtml(data.refresh_token)}</textarea>
<p>refresh token은 민감한 값입니다. 채팅이나 GitHub에 보내지 마세요.</p>
</body></html>`);
}
