import { getYouTubeAccessToken } from "../lib/youtube.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const token = await getYouTubeAccessToken();
    const url = new URL("https://www.googleapis.com/youtube/v3/channels");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "1");

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ ok: false, error: data });

    const channel = data.items?.[0];
    if (!channel) return res.status(404).json({ ok: false, error: "No authorized YouTube channel" });

    res.setHeader("cache-control", "no-store");
    return res.status(200).json({
      ok: true,
      channelId: channel.id,
      channelTitle: channel.snippet?.title || "",
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
