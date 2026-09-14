import { getNewsWindow } from "../../lib/time.js";
import {
  addVideoToPlaylist,
  createPrivatePlaylist,
  findPlaylistByTitle,
  getVideoDetails,
  getYouTubeAccessToken,
  listPlaylistVideoIds,
  listUploadedVideoIds,
} from "../../lib/youtube.js";
import { selectNewsVideos } from "../../lib/select.js";

const CHANNELS = ["jtbc_news", "newskbs"];

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.authorization === `Bearer ${secret}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function addVideoWithRetry(token, playlistId, videoId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await addVideoToPlaylist(token, playlistId, videoId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isPropagation404 = message.includes("YouTube POST playlistItems failed (404)");
      if (!isPropagation404 || attempt === 2) throw error;
      await sleep(1500 * (attempt + 1));
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });

  try {
    const token = await getYouTubeAccessToken();
    const window = getNewsWindow();

    const channelResults = await Promise.all(
      CHANNELS.map((handle) => listUploadedVideoIds(handle, token, window.start, window.end)),
    );

    const allIds = [...new Set(channelResults.flatMap((channel) => channel.videoIds))];
    const details = await getVideoDetails(allIds, token);
    const candidates = details.filter((video) =>
      video.durationSeconds >= 120 &&
      video.durationSeconds <= 300 &&
      video.liveBroadcastContent === "none" &&
      video.privacyStatus === "public" &&
      !video.isLikelyShort,
    );

    const selection = await selectNewsVideos(candidates);
    console.log("news selection completed", {
      mode: selection.mode,
      candidateCount: candidates.length,
      selectedCount: selection.videos.length,
      warning: selection.warning || null,
    });

    let playlist = await findPlaylistByTitle(token, window.playlistTitle);
    let createdPlaylist = false;
    if (!playlist) {
      playlist = await createPrivatePlaylist(
        token,
        window.playlistTitle,
        "JTBC News + KBS News | 전날 18:00 ~ 당일 09:00 KST | 자동 선별 뉴스 컬렉션",
      );
      createdPlaylist = true;
      // YouTube can briefly return playlistNotFound immediately after creating a playlist.
      // Give the new playlist a moment to propagate before inserting items.
      await sleep(1500);
    }

    const playlistId = playlist.id;
    const existingIds = createdPlaylist
      ? new Set()
      : new Set(await listPlaylistVideoIds(token, playlistId));
    let added = 0;

    for (const video of selection.videos.slice(0, 15)) {
      if (existingIds.has(video.videoId)) continue;
      await addVideoWithRetry(token, playlistId, video.videoId);
      existingIds.add(video.videoId);
      added += 1;
    }

    return res.status(200).json({
      ok: true,
      playlistId,
      playlistUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
      playlistTitle: window.playlistTitle,
      privacyStatus: "private",
      window: {
        start: window.start.toISOString(),
        end: window.end.toISOString(),
      },
      candidateCount: candidates.length,
      selectedCount: selection.videos.length,
      playlistItemCount: existingIds.size,
      addedCount: added,
      selectionMode: selection.mode,
      warning: selection.warning || null,
      channels: channelResults.map((channel) => ({
        handle: channel.handle,
        channelTitle: channel.channelTitle,
        uploadsInWindow: channel.videoIds.length,
      })),
    });
  } catch (error) {
    console.error("daily-news cron failed", error instanceof Error ? error.message : error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
