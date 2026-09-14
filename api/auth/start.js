function originFromRequest(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).send("GOOGLE_CLIENT_ID is not configured");

  const setupSecret = process.env.SETUP_SECRET;
  if (setupSecret && req.query.setup !== setupSecret) {
    return res.status(401).send("Invalid setup secret");
  }

  const redirectUri = `${originFromRequest(req)}/api/auth/callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/youtube");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  if (setupSecret) authUrl.searchParams.set("state", setupSecret);

  return res.redirect(authUrl.toString());
}
