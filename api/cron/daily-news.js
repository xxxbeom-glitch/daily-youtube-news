import { getNewsWindow } from "../../lib/time.js";
import {
  addVideoToPlaylist,
  createPrivatePlaylist,
  deletePlaylist,
  findPlaylistByTitle,
  getVideoDetails,
  getYouTubeAccessToken,
  listMyPlaylists,
  listPlaylistVideoIds,
  listUploadedVideoIds,
} from "../../lib/youtube.js";
import { selectNewsVideos } from "../../lib/select.js";

const CHANNELS = ["jtbc_news", "newskbs"];
const MAX_PLAYLIST_ITEMS = 25;
const PLAYLIST_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.authorization === `Bearer ${secret}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePlaylistDate(value) {
  const match = String(value || "").match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function newsPlaylistDateFromTitle(title) {
  const match = String(title || "").match(/^오늘의 뉴스 - (\d{4}\.\d{2}\.\d{2})$/);
  return match ? parsePlaylistDate(match[1]) : null;
}

async function cleanupExpiredNewsPlaylists(token, currentPlaylistDate) {
  const currentDateMs = parsePlaylistDate(currentPlaylistDate);
  if (currentDateMs === null) return { deleted: [], warning: "Could not parse current playlist date" };

  const cutoffMs = currentDateMs - PLAYLIST_RETENTION_DAYS * DAY_MS;
  const playlists = await listMyPlaylists(token);
  const expired = playlists.filter((playlist) => {
    const playlistDateMs = newsPlaylistDateFromTitle(playlist.snippet?.title);
    return playlistDateMs !== null && playlistDateMs <= cutoffMs;
  });

  const deleted = [];
  for (const playlist of expired) {
    await deletePlaylist(token, playlist.id);
    deleted.push({ id: playlist.id, title: playlist.snippet?.title || "" });
  }

  return { deleted, warning: null };
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

    let cleanup = { deleted: [], warning: null };
    try {
      cleanup = await cleanupExpiredNewsPlaylists(token, window.playlistDate);
      if (cleanup.deleted.length) {
        console.log("expired news playlists deleted", {
          count: cleanup.deleted.length,
          titles: cleanup.deleted.map((item) => item.title),
        });
      }
    } catch (error) {
      cleanup.warning = error instanceof Error ? error.message : String(error);
      console.warn("playlist cleanup failed", cleanup.warning);
    }

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
        "JTBC News + KBS News | 전날 18:00 ~ 당일 09:00 KST | 15~25개 자동 선별 | 7일 후 자동 삭제",
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

    for (const video of selection.videos.slice(0, MAX_PLAYLIST_ITEMS)) {
      if (existingIds.size >= MAX_PLAYLIST_ITEMS) break;
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
      retention: {
        days: PLAYLIST_RETENTION_DAYS,
        deletedCount: cleanup.deleted.length,
        deletedTitles: cleanup.deleted.map((item) => item.title),
        warning: cleanup.warning,
      },
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
