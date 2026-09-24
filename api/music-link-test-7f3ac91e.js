import {
  addVideoToPlaylist,
  createPrivatePlaylist,
  findPlaylistByTitle,
  getVideoDetails,
  getYouTubeAccessToken,
  listPlaylistVideoIds,
} from "../lib/youtube.js";

const PLAYLIST_TITLE = "YouTube Music 연결 테스트 - 2026.09.24";
const TEST_VIDEO_IDS = [
  "4NRXx6U8ABQ",
  "TUVcZfQe-Kw",
];
const EXPIRES_AT = Date.parse("2026-09-24T01:00:00Z");

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (Date.now() > EXPIRES_AT) return res.status(410).json({ error: "Test route expired" });

  try {
    const token = await getYouTubeAccessToken();
    const details = await getVideoDetails(TEST_VIDEO_IDS, token);
    const usable = details.filter((video) =>
      video.privacyStatus === "public" &&
      video.liveBroadcastContent === "none"
    );

    if (!usable.length) {
      return res.status(502).json({ ok: false, error: "No usable test music videos found" });
    }

    let playlist = await findPlaylistByTitle(token, PLAYLIST_TITLE);
    let created = false;
    if (!playlist) {
      playlist = await createPrivatePlaylist(
        token,
        PLAYLIST_TITLE,
        "YouTube Music 연결 확인용 비공개 테스트 플레이리스트",
      );
      created = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    const existing = created
      ? new Set()
      : new Set(await listPlaylistVideoIds(token, playlist.id));

    const added = [];
    for (const video of usable.slice(0, 2)) {
      if (existing.has(video.videoId)) continue;
      await addVideoToPlaylist(token, playlist.id, video.videoId);
      existing.add(video.videoId);
      added.push({ videoId: video.videoId, title: video.title });
    }

    return res.status(200).json({
      ok: true,
      playlistId: playlist.id,
      playlistTitle: PLAYLIST_TITLE,
      youtubeUrl: `https://www.youtube.com/playlist?list=${playlist.id}`,
      youtubeMusicUrl: `https://music.youtube.com/playlist?list=${playlist.id}`,
      created,
      added,
      songs: usable.slice(0, 2).map((video) => ({
        videoId: video.videoId,
        title: video.title,
        channelTitle: video.channelTitle,
      })),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
