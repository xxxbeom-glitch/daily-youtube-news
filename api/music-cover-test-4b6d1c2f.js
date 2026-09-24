import { getYouTubeAccessToken } from "../lib/youtube.js";

const PLAYLIST_ID = "PLKpZZfH-ClqY";
const EXPIRES_AT = Date.parse("2026-09-24T02:30:00Z");

const COVER_PROMPTS = [
  "Square album-cover artwork for a daily music playlist: dreamy neon city at dawn, wet road reflections, soft violet and coral sky, cinematic, minimal, no logos, no artist names, no text",
  "Square album-cover artwork for a daily music playlist: abstract glass shapes floating over a deep blue gradient, subtle light leaks, refined editorial design, minimal, no logos, no artist names, no text",
  "Square album-cover artwork for a daily music playlist: quiet night drive through a futuristic city, soft cyan and magenta lights, tasteful cinematic photography, no logos, no artist names, no text",
  "Square album-cover artwork for a daily music playlist: hazy sunrise over mountains and a distant city, warm peach and lavender atmosphere, elegant modern cover art, no logos, no artist names, no text",
];

async function generateCover() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");

  const prompt = COVER_PROMPTS[Math.floor(Math.random() * COVER_PROMPTS.length)];
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1-mini",
      prompt,
      size: "1024x1024",
      quality: "low",
      output_format: "jpeg",
      output_compression: 75,
      n: 1,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI image generation failed (${response.status}): ${text.slice(0, 700)}`);
  }

  const data = JSON.parse(text);
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image data");

  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length) throw new Error("Generated cover image is empty");

  return { bytes, prompt };
}

async function uploadPlaylistCover(token, bytes) {
  const metadata = JSON.stringify({
    snippet: {
      playlistId: PLAYLIST_ID,
      type: "hero",
    },
  });

  const start = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/playlistImages?uploadType=resumable&part=snippet",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(bytes.length),
        "x-upload-content-type": "image/jpeg",
      },
      body: metadata,
    },
  );

  const startText = await start.text();
  if (!start.ok) {
    throw new Error(`YouTube playlistImages session failed (${start.status}): ${startText.slice(0, 700)}`);
  }

  const uploadUrl = start.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube upload session returned no Location header");

  const upload = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "image/jpeg",
      "content-length": String(bytes.length),
    },
    body: bytes,
  });

  const uploadText = await upload.text();
  if (!upload.ok) {
    throw new Error(`YouTube playlist image upload failed (${upload.status}): ${uploadText.slice(0, 700)}`);
  }

  return uploadText ? JSON.parse(uploadText) : null;
}

async function verifyPlaylistCover(token) {
  const playlistImagesUrl = new URL("https://www.googleapis.com/youtube/v3/playlistImages");
  playlistImagesUrl.searchParams.set("part", "snippet");
  playlistImagesUrl.searchParams.set("parent", PLAYLIST_ID);

  const imagesResponse = await fetch(playlistImagesUrl, {
    headers: { authorization: `Bearer ${token}` },
  });
  const imagesText = await imagesResponse.text();

  const playlistUrl = new URL("https://www.googleapis.com/youtube/v3/playlists");
  playlistUrl.searchParams.set("part", "snippet,status");
  playlistUrl.searchParams.set("id", PLAYLIST_ID);
  const playlistResponse = await fetch(playlistUrl, {
    headers: { authorization: `Bearer ${token}` },
  });
  const playlistText = await playlistResponse.text();

  return {
    playlistImages: {
      ok: imagesResponse.ok,
      status: imagesResponse.status,
      body: imagesText ? JSON.parse(imagesText) : null,
    },
    playlist: {
      ok: playlistResponse.ok,
      status: playlistResponse.status,
      body: playlistText ? JSON.parse(playlistText) : null,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (Date.now() > EXPIRES_AT) return res.status(410).json({ error: "Test route expired" });

  try {
    const token = await getYouTubeAccessToken();

    if (req.query?.verify === "1") {
      const verified = await verifyPlaylistCover(token);
      return res.status(200).json({
        ok: true,
        playlistId: PLAYLIST_ID,
        youtubeMusicUrl: `https://music.youtube.com/playlist?list=${PLAYLIST_ID}`,
        verified,
      });
    }

    const { bytes, prompt } = await generateCover();
    const uploaded = await uploadPlaylistCover(token, bytes);
    const verified = await verifyPlaylistCover(token);

    return res.status(200).json({
      ok: true,
      playlistId: PLAYLIST_ID,
      youtubeMusicUrl: `https://music.youtube.com/playlist?list=${PLAYLIST_ID}`,
      generatedBytes: bytes.length,
      prompt,
      uploaded,
      verified,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
