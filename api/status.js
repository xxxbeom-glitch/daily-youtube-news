import { getNewsWindow } from "../lib/time.js";
import { findPlaylistByTitle, getYouTubeAccessToken, listPlaylistVideoIds } from "../lib/youtube.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const statusSecret = process.env.STATUS_SECRET;
  if (statusSecret && req.query.token !== statusSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const token = await getYouTubeAccessToken();
    const window = getNewsWindow();
    const playlist = await findPlaylistByTitle(token, window.playlistTitle);

    if (!playlist) {
      return res.status(404).json({
        ok: false,
        ready: false,
        playlistTitle: window.playlistTitle,
      });
    }

    const ids = await listPlaylistVideoIds(token, playlist.id);
    return res.status(200).json({
      ok: true,
      ready: true,
      playlistTitle: window.playlistTitle,
      playlistUrl: `https://www.youtube.com/playlist?list=${playlist.id}`,
      itemCount: ids.length,
      privacyStatus: playlist.status?.privacyStatus || "private",
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
