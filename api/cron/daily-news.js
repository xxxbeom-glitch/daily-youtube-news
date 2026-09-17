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
const WEATHER_SOURCES = [
  { handle: "newskbs", broadcaster: "KBS", preferredCaster: "박소연" },
  { handle: "yonhapnewstv23", broadcaster: "연합뉴스TV", preferredCaster: "이소연" },
];
const WEATHER_MIN_SECONDS = 60;
const WEATHER_MAX_SECONDS = 300;
const MAX_PLAYLIST_ITEMS = 10;
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

async function withRetry(operation, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

function kstDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function getMorningWeatherWindow(now = new Date()) {
  const { year, month, day } = kstDateParts(now);
  const startMs = Date.UTC(year, month - 1, day, -5, 0, 0, 0); // 04:00 KST
  const latestEndMs = Date.UTC(year, month - 1, day, 1, 0, 0, 0); // 10:00 KST
  return {
    start: new Date(startMs),
    end: new Date(Math.min(now.getTime(), latestEndMs)),
  };
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

function previousNewsPlaylistTitle(currentPlaylistDate) {
  const currentDateMs = parsePlaylistDate(currentPlaylistDate);
  if (currentDateMs === null) return null;
  const date = new Date(currentDateMs - DAY_MS).toISOString().slice(0, 10).replace(/-/g, ".");
  return `오늘의 뉴스 - ${date}`;
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

async function selectMorningWeather(token) {
  const window = getMorningWeatherWindow();
  if (window.end.getTime() <= window.start.getTime()) {
    return {
      video: null,
      mode: "none",
      candidateCount: 0,
      warning: "Morning weather window has not started yet",
      window,
    };
  }

  const settled = await Promise.allSettled(
    WEATHER_SOURCES.map((source) =>
      listUploadedVideoIds(source.handle, token, window.start, window.end, {
        query: "날씨",
        maxPages: 2,
      }),
    ),
  );

  const sourceResults = [];
  const warnings = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      sourceResults.push({ ...WEATHER_SOURCES[index], ...result.value });
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      warnings.push(`${WEATHER_SOURCES[index].broadcaster}: ${message}`);
    }
  });

  const allIds = [...new Set(sourceResults.flatMap((source) => source.videoIds))];
  if (!allIds.length) {
    return {
      video: null,
      mode: "none",
      candidateCount: 0,
      warning: warnings.join(" | ") || null,
      window,
    };
  }

  const details = await getVideoDetails(allIds, token);
  const sourceByChannelId = new Map(sourceResults.map((source) => [source.channelId, source]));
  const candidates = details
    .filter((video) =>
      video.durationSeconds >= WEATHER_MIN_SECONDS &&
      video.durationSeconds <= WEATHER_MAX_SECONDS &&
      video.liveBroadcastContent === "none" &&
      video.privacyStatus === "public" &&
      !video.isLikelyShort &&
      /(날씨|기상)/.test(video.title),
    )
    .map((video) => ({ video, source: sourceByChannelId.get(video.channelId) }))
    .filter((item) => item.source)
    .sort((a, b) => new Date(b.video.publishedAt) - new Date(a.video.publishedAt));

  const preferred = candidates.filter(({ video, source }) => {
    const metadata = `${video.title}\n${video.description}`;
    return metadata.includes(source.preferredCaster);
  });

  if (preferred.length) {
    const chosen = preferred[0];
    return {
      video: chosen.video,
      mode: "preferred-caster",
      broadcaster: chosen.source.broadcaster,
      caster: chosen.source.preferredCaster,
      candidateCount: candidates.length,
      warning: warnings.join(" | ") || null,
      window,
    };
  }

  const kbsFallback = candidates.find(({ source }) => source.handle === "newskbs");
  if (kbsFallback) {
    return {
      video: kbsFallback.video,
      mode: "kbs-fallback",
      broadcaster: "KBS",
      caster: null,
      candidateCount: candidates.length,
      warning: warnings.join(" | ") || null,
      window,
    };
  }

  return {
    video: null,
    mode: "none",
    candidateCount: candidates.length,
    warning: warnings.join(" | ") || null,
    window,
  };
}

function isFreshWUnboxing(video, kbsChannelId, previousIds) {
  return Boolean(
    video &&
    video.channelId === kbsChannelId &&
    /W\s*언박싱/i.test(video.title) &&
    video.liveBroadcastContent === "none" &&
    video.privacyStatus === "public" &&
    !video.isLikelyShort &&
    !previousIds.has(video.videoId)
  );
}

function ensureRequiredWUnboxing(videos, wVideo) {
  if (!wVideo) return videos;
  if (videos.some((video) => video.videoId === wVideo.videoId)) return videos;

  const required = {
    ...wVideo,
    selectionCategory: "사회",
    selectionScore: 50,
    selectionReason: "required KBS W 언박싱",
  };
  const result = [...videos];
  const insertAt = result.findIndex((video) => (video.selectionScore ?? 0) < required.selectionScore);
  result.splice(insertAt >= 0 ? insertAt : result.length, 0, required);

  while (result.length > MAX_PLAYLIST_ITEMS) {
    const removable = result.findLastIndex((video) => video.videoId !== wVideo.videoId);
    if (removable < 0) break;
    result.splice(removable, 1);
  }
  return result;
}

function limitNewsQueue(videos, limit, requiredVideoId) {
  if (limit <= 0) return [];
  const limited = videos.slice(0, limit);
  if (!requiredVideoId || limited.some((video) => video.videoId === requiredVideoId)) return limited;

  const required = videos.find((video) => video.videoId === requiredVideoId);
  if (!required) return limited;
  if (limited.length < limit) limited.push(required);
  else limited[limited.length - 1] = required;
  return limited;
}

async function addVideoWithRetry(token, playlistId, videoId, position) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await addVideoToPlaylist(token, playlistId, videoId, position);
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

    const weatherPromise = withRetry(() => selectMorningWeather(token), 3)
      .catch((error) => ({
        video: null,
        mode: "error",
        candidateCount: 0,
        warning: error instanceof Error ? error.message : String(error),
        window: getMorningWeatherWindow(),
      }));

    const channelResults = await Promise.all(
      CHANNELS.map((handle) => listUploadedVideoIds(handle, token, window.start, window.end)),
    );

    const allIds = [...new Set(channelResults.flatMap((channel) => channel.videoIds))];
    const details = await getVideoDetails(allIds, token);

    let previousIds = new Set();
    let wWarning = null;
    const previousTitle = previousNewsPlaylistTitle(window.playlistDate);
    if (previousTitle) {
      try {
        const previousPlaylist = await withRetry(() => findPlaylistByTitle(token, previousTitle), 3);
        if (previousPlaylist) {
          previousIds = new Set(await withRetry(() => listPlaylistVideoIds(token, previousPlaylist.id), 3));
        }
      } catch (error) {
        wWarning = error instanceof Error ? error.message : String(error);
        console.warn("W 언박싱 previous-playlist check failed; skipping forced inclusion", wWarning);
        previousIds = null;
      }
    }

    const kbsChannelId = channelResults.find((channel) => channel.handle === "newskbs")?.channelId;
    const wCandidates = previousIds
      ? details
          .filter((video) => isFreshWUnboxing(video, kbsChannelId, previousIds))
          .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      : [];
    const wUnboxing = wCandidates[0] || null;

    const candidates = details.filter((video) =>
      (
        video.durationSeconds >= 120 &&
        video.durationSeconds <= 300 &&
        video.liveBroadcastContent === "none" &&
        video.privacyStatus === "public" &&
        !video.isLikelyShort
      ) || video.videoId === wUnboxing?.videoId,
    );

    const [selection, weather] = await Promise.all([
      selectNewsVideos(candidates),
      weatherPromise,
    ]);
    const orderedNews = ensureRequiredWUnboxing(selection.videos, wUnboxing);

    console.log("news selection completed", {
      mode: selection.mode,
      candidateCount: candidates.length,
      selectedCount: orderedNews.length,
      warning: selection.warning || null,
    });
    console.log("morning weather selection completed", {
      mode: weather.mode,
      broadcaster: weather.broadcaster || null,
      caster: weather.caster || null,
      title: weather.video?.title || null,
      candidateCount: weather.candidateCount,
      warning: weather.warning || null,
    });
    console.log("W 언박싱 selection completed", {
      found: Boolean(wUnboxing),
      title: wUnboxing?.title || null,
      videoId: wUnboxing?.videoId || null,
      previousPlaylistTitle: previousTitle,
      warning: wWarning,
    });

    let playlist = await findPlaylistByTitle(token, window.playlistTitle);
    let createdPlaylist = false;
    if (!playlist) {
      playlist = await createPrivatePlaylist(
        token,
        window.playlistTitle,
        "첫 영상: KBS/연합뉴스TV 아침 날씨 | KBS W 언박싱 신규 영상은 필수 포함 | 이후 JTBC News + KBS News 중요도순 자동 선별 | 전체 최대 10개 | 7일 후 자동 삭제",
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
    let newsAdded = 0;
    let weatherAdded = 0;

    if (weather.video && existingIds.size < MAX_PLAYLIST_ITEMS && !existingIds.has(weather.video.videoId)) {
      await addVideoWithRetry(token, playlistId, weather.video.videoId, 0);
      existingIds.add(weather.video.videoId);
      weatherAdded = 1;
    }

    const availableNewsSlots = Math.max(0, MAX_PLAYLIST_ITEMS - existingIds.size);
    const newsQueue = limitNewsQueue(orderedNews, availableNewsSlots, wUnboxing?.videoId);
    for (const video of newsQueue) {
      if (existingIds.size >= MAX_PLAYLIST_ITEMS) break;
      if (existingIds.has(video.videoId)) continue;
      await addVideoWithRetry(token, playlistId, video.videoId);
      existingIds.add(video.videoId);
      newsAdded += 1;
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
      selectedCount: orderedNews.length,
      playlistItemCount: existingIds.size,
      addedCount: newsAdded + weatherAdded,
      newsAddedCount: newsAdded,
      selectionMode: selection.mode,
      warning: selection.warning || null,
      weather: {
        found: Boolean(weather.video),
        mode: weather.mode,
        broadcaster: weather.broadcaster || null,
        caster: weather.caster || null,
        title: weather.video?.title || null,
        videoId: weather.video?.videoId || null,
        addedCount: weatherAdded,
        candidateCount: weather.candidateCount,
        window: {
          start: weather.window?.start?.toISOString?.() || null,
          end: weather.window?.end?.toISOString?.() || null,
        },
        warning: weather.warning || null,
      },
      wUnboxing: {
        found: Boolean(wUnboxing),
        title: wUnboxing?.title || null,
        videoId: wUnboxing?.videoId || null,
        previousPlaylistTitle: previousTitle,
        skippedIfAlreadyUsedYesterday: true,
        warning: wWarning,
      },
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
