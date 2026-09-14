const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function getYouTubeAccessToken() {
  const body = new URLSearchParams({
    client_id: requiredEnv("GOOGLE_CLIENT_ID"),
    client_secret: requiredEnv("GOOGLE_CLIENT_SECRET"),
    refresh_token: requiredEnv("YOUTUBE_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token refresh failed (${response.status}): ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  if (!data.access_token) throw new Error("Google token refresh returned no access_token");
  return data.access_token;
}

async function youtubeGet(path, token, params = {}) {
  const url = new URL(`${YOUTUBE_API}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`YouTube GET ${path} failed (${response.status}): ${text.slice(0, 800)}`);
  }
  return response.json();
}

async function youtubePost(path, token, params, body) {
  const url = new URL(`${YOUTUBE_API}/${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`YouTube POST ${path} failed (${response.status}): ${text.slice(0, 800)}`);
  }
  return response.json();
}

async function youtubeDelete(path, token, params = {}) {
  const url = new URL(`${YOUTUBE_API}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`YouTube DELETE ${path} failed (${response.status}): ${text.slice(0, 800)}`);
  }
}

export async function getUploadsPlaylistId(handle, token) {
  const data = await youtubeGet("channels", token, {
    part: "contentDetails,snippet",
    forHandle: handle.replace(/^@/, ""),
    maxResults: 1,
  });

  const channel = data.items?.[0];
  if (!channel) throw new Error(`YouTube channel not found for handle: ${handle}`);

  return {
    channelId: channel.id,
    channelTitle: channel.snippet?.title || handle,
    uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads,
  };
}

export async function listUploadedVideoIds(handle, token, start, end, options = {}) {
  const channel = await getUploadsPlaylistId(handle, token);
  const ids = [];
  let pageToken;
  let pageCount = 0;
  const maxPages = Math.max(1, Math.min(Number(options.maxPages || 4), 4));

  // Some large broadcaster channels expose an uploads playlist ID that can return
  // playlistNotFound via playlistItems.list. Search the channel directly by ID and
  // publication window instead; this is reliable for public news uploads.
  do {
    const data = await youtubeGet("search", token, {
      part: "snippet",
      channelId: channel.channelId,
      type: "video",
      order: "date",
      q: options.query || undefined,
      publishedAfter: start.toISOString(),
      publishedBefore: end.toISOString(),
      maxResults: 50,
      pageToken,
    });
    pageCount += 1;

    for (const item of data.items || []) {
      const videoId = item.id?.videoId;
      if (videoId) ids.push(videoId);
    }

    pageToken = data.nextPageToken;
  } while (pageToken && pageCount < maxPages);

  return {
    handle,
    ...channel,
    videoIds: [...new Set(ids)],
  };
}

function parseIsoDurationSeconds(value = "") {
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return null;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function looksLikeShort(video) {
  const text = `${video.snippet?.title || ""}\n${video.snippet?.description || ""}`.toLowerCase();
  return /(^|\s|#)shorts?(\s|#|$)/i.test(text) || text.includes("#쇼츠") || text.includes("#shorts");
}

export async function getVideoDetails(videoIds, token) {
  const unique = [...new Set(videoIds)];
  const results = [];

  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const data = await youtubeGet("videos", token, {
      part: "snippet,contentDetails,status",
      id: batch.join(","),
      maxResults: 50,
    });

    for (const item of data.items || []) {
      const durationSeconds = parseIsoDurationSeconds(item.contentDetails?.duration);
      results.push({
        videoId: item.id,
        title: item.snippet?.title || "",
        description: item.snippet?.description || "",
        channelId: item.snippet?.channelId || "",
        channelTitle: item.snippet?.channelTitle || "",
        publishedAt: item.snippet?.publishedAt || "",
        liveBroadcastContent: item.snippet?.liveBroadcastContent || "none",
        durationSeconds,
        privacyStatus: item.status?.privacyStatus,
        embeddable: item.status?.embeddable,
        isLikelyShort: looksLikeShort(item),
      });
    }
  }

  return results;
}

export async function listMyPlaylists(token) {
  const playlists = [];
  let pageToken;
  let pages = 0;

  do {
    const data = await youtubeGet("playlists", token, {
      part: "snippet,contentDetails,status",
      mine: true,
      maxResults: 50,
      pageToken,
    });
    playlists.push(...(data.items || []));
    pageToken = data.nextPageToken;
    pages += 1;
  } while (pageToken && pages < 20);

  return playlists;
}

export async function findPlaylistByTitle(token, title) {
  const playlists = await listMyPlaylists(token);
  return playlists.find((item) => item.snippet?.title === title) || null;
}

export async function createPrivatePlaylist(token, title, description) {
  return youtubePost(
    "playlists",
    token,
    { part: "snippet,status" },
    {
      snippet: { title, description },
      status: { privacyStatus: "private" },
    },
  );
}

export async function deletePlaylist(token, playlistId) {
  await youtubeDelete("playlists", token, { id: playlistId });
}

export async function listPlaylistVideoIds(token, playlistId) {
  const ids = [];
  let pageToken;
  do {
    const data = await youtubeGet("playlistItems", token, {
      part: "contentDetails",
      playlistId,
      maxResults: 50,
      pageToken,
    });
    for (const item of data.items || []) {
      if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

export async function addVideoToPlaylist(token, playlistId, videoId, position) {
  const snippet = {
    playlistId,
    resourceId: { kind: "youtube#video", videoId },
  };
  if (Number.isInteger(position) && position >= 0) snippet.position = position;

  return youtubePost(
    "playlistItems",
    token,
    { part: "snippet" },
    { snippet },
  );
}
