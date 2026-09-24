import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const PROFILE_PATH = process.env.MUSIC_PROFILE_PATH || "music/profile.v1.json";
const STATE_PATH = process.env.MUSIC_STATE_PATH || ".music-state/history.json";
const OUTPUT_DIR = process.env.MUSIC_OUTPUT_DIR || "music-output";
const GEMINI_PREFILTER_MODEL = process.env.GEMINI_PREFILTER_MODEL || "gemini-3.1-flash-lite";
const GEMINI_CURATOR_MODEL = process.env.GEMINI_CURATOR_MODEL || "gemini-3.6-flash";
const MAX_GEMINI_CALLS = Math.max(1, Math.min(5, Number(process.env.MAX_GEMINI_CALLS_PER_RUN || 5)));
const CATALOG_TARGET = Math.max(80, Math.min(160, Number(process.env.MUSIC_CATALOG_TARGET || 140)));
const CURATOR_LIMIT = Math.max(30, Math.min(60, Number(process.env.MUSIC_CURATOR_LIMIT || 50)));
const YOUTUBE_SEARCH_LIMIT = Math.max(35, Math.min(70, Number(process.env.YOUTUBE_SEARCH_LIMIT || 60)));
const DAY = 86400000;
const YT = "https://www.googleapis.com/youtube/v3";
const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const LB_ROOT = "https://api.listenbrainz.org";
const MB_ROOT = "https://musicbrainz.org/ws/2";
const RULES_VERSION = "music-rules-v2-gemini";
const PROMPT_VERSION = "music-prompts-v2-gemini";
const ALLOWED_GEMINI_MODELS = new Set(["gemini-3.1-flash-lite", "gemini-3.6-flash"]);
const MB_USER_AGENT = "daily-youtube-news-music/2.0 (https://github.com/xxxbeom-glitch/daily-youtube-news)";

let geminiCalls = 0;
const geminiUsage = [];
let lastMusicBrainzRequestAt = 0;

const norm = (v = "") => String(v).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/\b(feat|featuring|ft)\.?\b.*$/i, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const titleNorm = (v = "") => norm(v).replace(/\b(clean|explicit|radio edit|album version|single version|official audio)\b/g, " ").trim().replace(/\s+/g, " ");
const primaryKeys = (t) => [...new Set((t.primary_artists?.length ? t.primary_artists : [t.display_artist || ""]).map(norm).filter(Boolean))];
const trackKey = (t) => `${primaryKeys(t).sort().join("+")}|${titleNorm(t.title)}|${t.version_type === "official_remix" ? "official_remix" : "original"}`;
const albumKey = (t) => `${primaryKeys(t).sort().join("+")}|${norm(t.album || "unknown")}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}
function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function assertFreeTierEligibleModel(model) {
  if (!ALLOWED_GEMINI_MODELS.has(model)) throw new Error(`Gemini model blocked by cost policy: ${model}`);
}
async function fetchJson(url, options = {}, label = "request") {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${(await response.text()).slice(0,900)}`);
  return response.json();
}

const prefilterSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidate_id: { type: "string" },
          reject: { type: "boolean" },
          scene_fit: { type: "boolean" },
          genre_fit: { type: "integer", minimum: 0, maximum: 100 },
          dark: { type: "integer", minimum: 0, maximum: 100 },
          aggressive: { type: "integer", minimum: 0, maximum: 100 },
          bounce: { type: "integer", minimum: 0, maximum: 100 },
          groove: { type: "integer", minimum: 0, maximum: 100 },
          bass: { type: "integer", minimum: 0, maximum: 100 },
          hiphop_base: { type: "integer", minimum: 0, maximum: 100 },
          rage_risk: { type: "integer", minimum: 0, maximum: 100 },
          electronic_risk: { type: "integer", minimum: 0, maximum: 100 }
        },
        required: ["candidate_id","reject","scene_fit","genre_fit","dark","aggressive","bounce","groove","bass","hiphop_base","rage_risk","electronic_risk"]
      }
    }
  },
  required: ["results"]
};

const curatorSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidate_id: { type: "string" },
          reject: { type: "boolean" },
          taste_score: { type: "integer", minimum: 0, maximum: 100 },
          deep_cut_score: { type: "integer", minimum: 0, maximum: 100 },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          fame_tier: { type: "string", enum: ["famous", "less_known"] }
        },
        required: ["candidate_id","reject","taste_score","deep_cut_score","confidence","fame_tier"]
      }
    }
  },
  required: ["results"]
};

async function geminiJson({ model, system, input, schema, thinkingLevel, maxOutputTokens }) {
  assertFreeTierEligibleModel(model);
  geminiCalls += 1;
  if (geminiCalls > MAX_GEMINI_CALLS) throw new Error(`Gemini call budget exceeded: ${geminiCalls} > ${MAX_GEMINI_CALLS}`);

  const url = `${GEMINI_ROOT}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      maxOutputTokens,
      thinkingConfig: { thinkingLevel }
    }
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": requiredEnv("GEMINI_API_KEY"), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0,1200);
    if (response.status === 429) throw new Error(`Gemini quota/rate limit reached; stopped with no paid fallback: ${detail}`);
    throw new Error(`Gemini ${model} failed (${response.status}): ${detail}`);
  }
  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("").trim();
  if (!text) throw new Error(`Gemini ${model} returned no structured output`);
  geminiUsage.push({ model, usage: data.usageMetadata || null });
  return JSON.parse(text);
}

async function geminiCredentialTest() {
  for (const model of [GEMINI_PREFILTER_MODEL, GEMINI_CURATOR_MODEL]) {
    assertFreeTierEligibleModel(model);
    const response = await fetch(`${GEMINI_ROOT}/models/${encodeURIComponent(model)}`, {
      headers: { "x-goog-api-key": requiredEnv("GEMINI_API_KEY") }
    });
    if (!response.ok) throw new Error(`Gemini model access check failed for ${model} (${response.status}): ${(await response.text()).slice(0,500)}`);
  }
}

async function googleToken() {
  const body = new URLSearchParams({
    client_id: requiredEnv("GOOGLE_CLIENT_ID"),
    client_secret: requiredEnv("GOOGLE_CLIENT_SECRET"),
    refresh_token: requiredEnv("YOUTUBE_REFRESH_TOKEN"),
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`Google token refresh failed (${response.status}): ${(await response.text()).slice(0,500)}`);
  return (await response.json()).access_token;
}
async function ytGet(pathname, token, params = {}) {
  const url = new URL(`${YT}/${pathname}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`YouTube GET ${pathname} failed (${response.status}): ${(await response.text()).slice(0,700)}`);
  return response.json();
}
async function ytPost(pathname, token, params, body) {
  const url = new URL(`${YT}/${pathname}`);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`YouTube POST ${pathname} failed (${response.status}): ${(await response.text()).slice(0,700)}`);
  return response.json();
}
async function ytDelete(pathname, token, params = {}) {
  const url = new URL(`${YT}/${pathname}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  const response = await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`YouTube DELETE ${pathname} failed (${response.status}): ${(await response.text()).slice(0,700)}`);
}

async function musicBrainzJson(pathname, params = {}) {
  const wait = 1100 - (Date.now() - lastMusicBrainzRequestAt);
  if (wait > 0) await sleep(wait);
  const url = new URL(`${MB_ROOT}/${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  lastMusicBrainzRequestAt = Date.now();
  const response = await fetch(url, { headers: { "user-agent": MB_USER_AGENT, accept: "application/json" } });
  if (!response.ok) throw new Error(`MusicBrainz failed (${response.status}) for ${pathname}: ${(await response.text()).slice(0,500)}`);
  return response.json();
}
async function findArtistMbid(name) {
  const data = await musicBrainzJson("artist/", { query: `artist:"${name.replace(/"/g, "")}"`, fmt: "json", limit: 5 });
  const artists = data.artists || [];
  const exact = artists.find((artist) => norm(artist.name) === norm(name));
  return (exact || artists[0])?.id || null;
}
function harvestRecordingRows(node, map, source) {
  if (Array.isArray(node)) {
    for (const item of node) harvestRecordingRows(item, map, source);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.recording_mbid === "string") {
    const id = node.recording_mbid;
    const current = map.get(id) || { recording_mbid: id, total_listen_count: 0, sources: [] };
    current.total_listen_count = Math.max(current.total_listen_count || 0, Number(node.total_listen_count || 0));
    if (source && !current.sources.includes(source)) current.sources.push(source);
    map.set(id, current);
  }
  for (const value of Object.values(node)) harvestRecordingRows(value, map, source);
}
async function listenBrainzJson(pathname, params = {}) {
  const url = new URL(`${LB_ROOT}/${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
    else url.searchParams.set(key, String(value));
  }
  return fetchJson(url, { headers: { "user-agent": MB_USER_AGENT, accept: "application/json" } }, "ListenBrainz");
}
function discoveryTags(genre) {
  return genre === "hiphop"
    ? ["trap", "drill", "southern hip hop", "boom bap", "gangsta rap", "club rap"]
    : ["contemporary r&b", "alternative r&b", "trap soul", "r&b", "hip hop soul", "urban contemporary"];
}
function neighborhoodSeeds(genre) {
  return genre === "hiphop"
    ? ["Young Thug", "Drake", "Doechii", "Eminem", "Tyga", "Roddy Ricch"]
    : ["SZA", "The Weeknd", "Victoria Monét", "Bryson Tiller", "Frank Ocean", "Summer Walker"];
}
async function discoverRecordingRows(genre) {
  const rows = new Map();
  for (const artistName of neighborhoodSeeds(genre)) {
    try {
      const mbid = await findArtistMbid(artistName);
      if (!mbid) continue;
      const data = await listenBrainzJson(`1/lb-radio/artist/${mbid}`, {
        mode: "medium",
        max_similar_artists: 10,
        max_recordings_per_artist: 6,
        pop_begin: 3,
        pop_end: 80
      });
      harvestRecordingRows(data, rows, `artist:${artistName}`);
    } catch (error) {
      console.warn("artist neighborhood source skipped", artistName, error instanceof Error ? error.message : error);
    }
  }
  for (const tag of discoveryTags(genre)) {
    try {
      const data = await listenBrainzJson("1/lb-radio/tags", { tag, pop_begin: 3, pop_end: 80, count: 100 });
      harvestRecordingRows(data, rows, `tag:${tag}`);
    } catch (error) {
      console.warn("tag source skipped", tag, error instanceof Error ? error.message : error);
    }
  }
  return [...rows.values()].sort((a,b) => {
    const aNeighborhood = a.sources.some((s) => s.startsWith("artist:")) ? 1 : 0;
    const bNeighborhood = b.sources.some((s) => s.startsWith("artist:")) ? 1 : 0;
    return bNeighborhood - aNeighborhood || a.total_listen_count - b.total_listen_count;
  });
}
function releaseType(release) {
  const group = release?.["release-group"] || {};
  const primary = String(group["primary-type"] || "").toLowerCase();
  const secondary = (group["secondary-types"] || []).map((x) => String(x).toLowerCase());
  if (secondary.includes("mixtape/street")) return "mixtape";
  if (primary === "album") return "album";
  if (primary === "ep") return "ep";
  return "unknown";
}
function releaseYear(release) {
  const match = String(release?.date || release?.["release-group"]?.["first-release-date"] || "").match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}
function artistCreditName(credit) {
  return credit?.name || credit?.artist?.name || "";
}
function buildCatalogCandidate(recording, sourceRow) {
  const credits = recording["artist-credit"] || [];
  const primaryArtists = credits.map(artistCreditName).filter(Boolean);
  const displayArtist = credits.map((credit) => `${artistCreditName(credit)}${credit.joinphrase || ""}`).join("").trim() || primaryArtists.join(", ");
  const releases = recording.releases || [];
  const accepted = releases.filter((release) => ["album","ep","mixtape"].includes(releaseType(release)) && releaseYear(release));
  if (!recording.title || !displayArtist || !accepted.length) return null;
  accepted.sort((a,b) => releaseYear(a) - releaseYear(b));
  const chosen = accepted[0];
  const album = chosen?.["release-group"]?.title || chosen?.title || "";
  const year = releaseYear(chosen);
  const date = chosen?.date || `${year}-01-01`;
  const hasSingleRelease = releases.some((release) => String(release?.["release-group"]?.["primary-type"] || "").toLowerCase() === "single");
  const tags = (recording.tags || []).sort((a,b) => Number(b.count || 0) - Number(a.count || 0)).slice(0,15).map((tag) => tag.name).filter(Boolean);
  const countries = [...new Set(credits.map((credit) => credit?.artist?.country).filter(Boolean))];
  const versionType = /\bremix\b/i.test(recording.title) ? "official_remix" : "original";
  return {
    recording_mbid: recording.id,
    display_artist: displayArtist,
    primary_artists: primaryArtists,
    featured_artists: [],
    title: recording.title,
    album,
    release_date: date,
    release_year: year,
    release_type: releaseType(chosen),
    version_type: versionType,
    remix_materially_distinct: false,
    single_status: hasSingleRelease ? "single" : "album_cut",
    title_track: titleNorm(recording.title) === titleNorm(album),
    tags,
    artist_countries: countries,
    source_popularity: sourceRow.total_listen_count || 0,
    discovery_sources: sourceRow.sources || [],
    evidence_urls: [`https://musicbrainz.org/recording/${recording.id}`]
  };
}
function staticRejectReasons(t, profile, genre) {
  const reasons = [];
  if (!profile.playlist.accepted_release_types.includes(t.release_type)) reasons.push("release_type");
  if (t.title_track) reasons.push("title_track");
  if (t.version_type === "official_remix" && !t.remix_materially_distinct) reasons.push("unverified_remix_distinction");
  if (t.version_type === "original" && ["single","pre_release"].includes(t.single_status)) reasons.push("single_or_prerelease");
  if (genre === "hiphop" && t.release_year < profile.hiphop.minimum_release_year) reasons.push("pre_2010_hiphop");
  if (/\b(slowed|reverb|sped up|nightcore|remaster|live|acoustic|karaoke)\b/i.test(t.title)) reasons.push("bad_version_marker");
  return reasons;
}
async function collectCatalog(profile, genre) {
  const sourceRows = await discoverRecordingRows(genre);
  if (sourceRows.length < CATALOG_TARGET) throw new Error(`Catalog discovery returned only ${sourceRows.length} unique recording IDs`);
  const candidates = [];
  const rejected = [];
  for (const row of sourceRows) {
    if (candidates.length >= CATALOG_TARGET) break;
    try {
      const recording = await musicBrainzJson(`recording/${row.recording_mbid}`, {
        fmt: "json",
        inc: "artist-credits+artists+releases+release-groups+tags"
      });
      const candidate = buildCatalogCandidate(recording, row);
      if (!candidate) { rejected.push({ recording_mbid: row.recording_mbid, reasons: ["missing_album_metadata"] }); continue; }
      const reasons = staticRejectReasons(candidate, profile, genre);
      if (reasons.length) rejected.push({ recording_mbid: row.recording_mbid, artist: candidate.display_artist, title: candidate.title, reasons });
      else candidates.push(candidate);
    } catch (error) {
      console.warn("catalog enrichment skipped", row.recording_mbid, error instanceof Error ? error.message : error);
    }
  }
  if (candidates.length < 70) throw new Error(`Only ${candidates.length} catalog candidates survived factual filters`);
  return { candidates, rejected, source_count: sourceRows.length };
}
function seedBlocked(t, profile, genre) {
  if (t.version_type === "official_remix") return false;
  return (profile.seed_tracks?.[genre] || []).some((seed) =>
    titleNorm(t.title) === titleNorm(seed.title) &&
    primaryKeys(t).some((artist) => artist.includes(norm(seed.artist)) || norm(seed.artist).includes(artist))
  );
}
function hardFilter(candidates, profile, genre, state) {
  const cutoff = Date.now() - profile.playlist.cooldown_days * DAY;
  const recentKeys = new Set((state.recommended || []).filter((item) => new Date(item.recommended_at).getTime() >= cutoff).map((item) => item.track_key));
  const kept = [];
  const rejected = [];
  for (const [index, raw] of candidates.entries()) {
    const t = { ...raw, candidate_id: `c${index + 1}` };
    const reasons = [...staticRejectReasons(t, profile, genre)];
    if (seedBlocked(t, profile, genre)) reasons.push("seed_track");
    if (recentKeys.has(trackKey(t))) reasons.push("90_day_cooldown");
    if (!t.evidence_urls?.length) reasons.push("no_fact_evidence");
    if (reasons.length) rejected.push({ ...t, reject_reasons: [...new Set(reasons)] });
    else kept.push(t);
  }
  return { kept, rejected };
}
function candidatePayload(t) {
  return {
    candidate_id: t.candidate_id,
    artist: t.display_artist,
    title: t.title,
    album: t.album,
    release_year: t.release_year,
    tags: t.tags,
    artist_countries: t.artist_countries,
    source_popularity: t.source_popularity,
    discovery_sources: t.discovery_sources
  };
}
async function prefilterCandidates(profile, genre, candidates) {
  const lane = genre === "hiphop" ? profile.hiphop : profile.rnb;
  const system = `You are a low-cost music taste classifier. Judge only the supplied candidates; never invent songs or metadata. scene_fit means the primary artist is mainly identified with the U.S./North-American hip-hop or R&B market. Exclude primary artists mainly identified with the Korean/K-pop industry; ethnicity alone is not a reason to exclude. For hip-hop strongly penalize rage, hyperpop and electronic-first production. For R&B require a meaningful hip-hop rhythmic/production base. Seeds are taste signals, not songs to insert. Positive traits: ${lane.positive.join("; ")}. Negative traits: ${lane.negative.join("; ")}.`;
  const byId = new Map();
  for (let i = 0; i < candidates.length; i += 50) {
    const chunk = candidates.slice(i, i + 50);
    const parsed = await geminiJson({
      model: GEMINI_PREFILTER_MODEL,
      system,
      input: { genre, seeds: profile.seed_tracks[genre], favorites: profile.favorite_artists, candidates: chunk.map(candidatePayload) },
      schema: prefilterSchema,
      thinkingLevel: "minimal",
      maxOutputTokens: 7000
    });
    const allowedIds = new Set(chunk.map((t) => t.candidate_id));
    for (const result of parsed.results || []) if (allowedIds.has(result.candidate_id)) byId.set(result.candidate_id, result);
  }
  return candidates.map((t) => ({ ...t, prefilter: byId.get(t.candidate_id) })).filter((t) => t.prefilter);
}
function prefilterScore(t, genre) {
  const p = t.prefilter;
  let score = p.genre_fit + 0.18 * p.bass + 0.16 * p.bounce + 0.12 * p.groove;
  if (genre === "hiphop") score += 0.12 * p.aggressive + 0.08 * p.dark - 0.35 * p.rage_risk - 0.2 * p.electronic_risk;
  else score += 0.24 * p.hiphop_base + 0.12 * p.groove + 0.08 * p.dark;
  return score;
}
function applyPrefilter(items, genre) {
  return items.filter((t) => {
    const p = t.prefilter;
    if (p.reject || !p.scene_fit || p.genre_fit < 45) return false;
    if (genre === "hiphop" && (p.rage_risk >= 55 || p.electronic_risk >= 60)) return false;
    if (genre === "rnb" && p.hiphop_base < 45) return false;
    return true;
  }).sort((a,b) => prefilterScore(b,genre) - prefilterScore(a,genre));
}
async function curateCandidates(profile, genre, candidates) {
  const lane = genre === "hiphop" ? profile.hiphop : profile.rnb;
  const system = `You are the final subjective curator. Only score supplied candidate IDs; do not invent or correct factual metadata and do not claim to have listened to audio. Prefer discovery, album/deep-cut value, and fit with the user's explicit seeds and preferences over obvious hits. Return compact scores only. Positive traits: ${lane.positive.join("; ")}. Negative traits: ${lane.negative.join("; ")}.`;
  const parsed = await geminiJson({
    model: GEMINI_CURATOR_MODEL,
    system,
    input: {
      genre,
      seeds: profile.seed_tracks[genre],
      production_only_seeds: profile.seed_tracks.production_only,
      favorites: profile.favorite_artists,
      candidates: candidates.map((t) => ({ ...candidatePayload(t), prefilter: t.prefilter }))
    },
    schema: curatorSchema,
    thinkingLevel: "low",
    maxOutputTokens: 6500
  });
  const allowedIds = new Set(candidates.map((t) => t.candidate_id));
  const byId = new Map((parsed.results || []).filter((r) => allowedIds.has(r.candidate_id)).map((r) => [r.candidate_id, r]));
  return candidates.map((t) => ({ ...t, curation: byId.get(t.candidate_id) })).filter((t) => t.curation && !t.curation.reject).sort((a,b) => {
    const sa = a.curation.taste_score + 0.35 * a.curation.deep_cut_score + 0.15 * a.curation.confidence;
    const sb = b.curation.taste_score + 0.35 * b.curation.deep_cut_score + 0.15 * b.curation.confidence;
    return sb - sa;
  });
}
function balancedShortlist(items, profile, limit = CURATOR_LIMIT) {
  const out = [];
  const artistCounts = new Map();
  const albums = new Set();
  const famousTarget = Math.ceil(limit * profile.playlist.famous_artist_share);
  for (const t of items) {
    const keys = primaryKeys(t);
    if (keys.some((key) => (artistCounts.get(key) || 0) >= profile.playlist.max_tracks_per_primary_artist)) continue;
    if (albums.has(albumKey(t))) continue;
    if (t.curation.fame_tier === "famous" && out.filter((x) => x.curation.fame_tier === "famous").length >= famousTarget) continue;
    out.push(t);
    for (const key of keys) artistCounts.set(key, (artistCounts.get(key) || 0) + 1);
    albums.add(albumKey(t));
    if (out.length >= limit) break;
  }
  if (out.length < limit) {
    for (const t of items) {
      if (out.includes(t)) continue;
      const keys = primaryKeys(t);
      if (keys.some((key) => (artistCounts.get(key) || 0) >= profile.playlist.max_tracks_per_primary_artist)) continue;
      if (albums.has(albumKey(t))) continue;
      out.push(t);
      for (const key of keys) artistCounts.set(key, (artistCounts.get(key) || 0) + 1);
      albums.add(albumKey(t));
      if (out.length >= limit) break;
    }
  }
  return out;
}

function isoSeconds(value = "") {
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  return match ? Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0) : null;
}
function artistMatch(t, text) {
  const normalized = norm(text);
  return primaryKeys(t).some((artist) => normalized.includes(artist) || artist.split(" ").filter(Boolean).every((part) => normalized.includes(part)));
}
function classifyOfficialAudio(t, v) {
  const text = `${v.title}\n${v.description}\n${v.channelTitle}`;
  const low = text.toLowerCase();
  if (/official music video|music video|\bvevo\b|lyric video|visualizer|\blive\b|performance|concert|slowed|reverb|sped.?up|nightcore|karaoke|remaster|reaction/.test(low)) return { ok: false, reason: "non_audio_content" };
  if (t.version_type === "official_remix" && !/remix/i.test(text)) return { ok: false, reason: "remix_not_matched" };
  if (t.version_type === "original" && /\bremix\b/i.test(v.title)) return { ok: false, reason: "unexpected_remix" };
  const ytTitle = titleNorm(v.title);
  const wanted = titleNorm(t.title);
  const titleOk = ytTitle.includes(wanted) || wanted.includes(ytTitle.replace(/ official audio/g, ""));
  if (!titleOk || !artistMatch(t, text)) return { ok: false, reason: "title_or_artist_mismatch" };
  if (/ - topic$/i.test(v.channelTitle) || /provided to youtube by/i.test(v.description)) return { ok: true, type: "art_track" };
  if (/official audio/i.test(v.title) && artistMatch(t, v.channelTitle)) return { ok: true, type: "official_audio" };
  return { ok: false, reason: "not_verified_official_audio" };
}
async function resolveYouTube(t, token) {
  const q = `${t.display_artist} ${t.title}`;
  const search = await ytGet("search", token, { part: "snippet", q, type: "video", videoCategoryId: 10, maxResults: 15 });
  const ids = (search.items || []).map((item) => item.id?.videoId).filter(Boolean);
  if (!ids.length) return null;
  const details = await ytGet("videos", token, { part: "snippet,contentDetails,statistics,status", id: ids.join(",") });
  const ranked = [];
  for (const item of details.items || []) {
    const v = {
      videoId: item.id,
      title: item.snippet?.title || "",
      description: item.snippet?.description || "",
      channelTitle: item.snippet?.channelTitle || "",
      durationSeconds: isoSeconds(item.contentDetails?.duration),
      publishedAt: item.snippet?.publishedAt || "",
      viewCount: Number(item.statistics?.viewCount || 0)
    };
    if (!Number.isFinite(v.durationSeconds) || v.durationSeconds < 60 || v.durationSeconds > 720) continue;
    const classification = classifyOfficialAudio(t, v);
    if (classification.ok) ranked.push({ ...v, audioType: classification.type });
  }
  ranked.sort((a,b) => (a.audioType === "art_track" ? -1 : 0) - (b.audioType === "art_track" ? -1 : 0) || a.viewCount - b.viewCount);
  return ranked[0] || null;
}
function eraBucket(t, now = new Date()) {
  const d = t.release_date ? new Date(t.release_date) : new Date(Date.UTC(t.release_year, 6, 1));
  if (Number.isNaN(d.getTime())) return "unknown";
  const years = Math.max(0, (now - d) / (365.25 * DAY));
  if (years <= 1) return "recent_12_months";
  if (years <= 5) return "one_to_five_years";
  if (years <= 10) return "six_to_ten_years";
  return "older_than_ten_years";
}
function finalScore(t, profile, current, totalSeconds) {
  let score = t.curation.taste_score + 0.3 * t.curation.deep_cut_score + 0.1 * t.curation.confidence;
  const famous = current.filter((x) => x.curation.fame_tier === "famous").length;
  if (t.curation.fame_tier === "famous" && famous / Math.max(1, current.length + 1) > profile.playlist.famous_artist_share + 0.08) score -= 18;
  const bucket = eraBucket(t);
  const target = Object.fromEntries(profile.era_mix.map((x) => [x.bucket, x.share]));
  const count = current.filter((x) => eraBucket(x) === bucket).length;
  if ((count + 1) / Math.max(1, current.length + 1) > (target[bucket] || 0) + 0.12) score -= 12;
  if (bucket === "recent_12_months" && (count + 1) / Math.max(1, current.length + 1) > 0.10) score -= 25;
  if (totalSeconds + t.youtube.durationSeconds > profile.playlist.max_duration_minutes * 60) score -= 1000;
  return score;
}
function optimizeMaybe(resolved, profile) {
  const min = profile.playlist.min_duration_minutes * 60;
  const pool = [...resolved];
  const selected = [];
  const artistCounts = new Map();
  const albums = new Set();
  let seconds = 0;
  while (pool.length && seconds < min) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const t = pool[i];
      const keys = primaryKeys(t);
      if (keys.some((key) => (artistCounts.get(key) || 0) >= profile.playlist.max_tracks_per_primary_artist)) continue;
      if (albums.has(albumKey(t))) continue;
      const score = finalScore(t, profile, selected, seconds);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0 || bestScore < -500) break;
    const [t] = pool.splice(best, 1);
    selected.push(t);
    seconds += t.youtube.durationSeconds;
    for (const key of primaryKeys(t)) artistCounts.set(key, (artistCounts.get(key) || 0) + 1);
    albums.add(albumKey(t));
  }
  if (seconds < min) return null;
  return { selected, total_seconds: seconds, total_minutes: Number((seconds / 60).toFixed(1)) };
}
async function createPlaylist(token, title, description) {
  return ytPost("playlists", token, { part: "snippet,status" }, { snippet: { title, description }, status: { privacyStatus: "private" } });
}
async function addVideo(token, playlistId, videoId) {
  for (let i = 0; i < 3; i += 1) {
    try { return await ytPost("playlistItems", token, { part: "snippet" }, { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }); }
    catch (error) { if (i === 2) throw error; await sleep(1200 * (i + 1)); }
  }
}
async function deletePlaylist(token, playlistId) { await ytDelete("playlists", token, { id: playlistId }); }
function kstStamp() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}.${value.month}.${value.day} ${value.hour}${value.minute}`;
}
function checkpointPath(genre) { return path.join(path.dirname(STATE_PATH), `inflight-${genre}.json`); }
async function saveCheckpoint(genre, data) { await writeJson(checkpointPath(genre), data); }
async function loadCheckpoint(genre, profile) {
  const checkpoint = await readJson(checkpointPath(genre), null);
  if (!checkpoint) return null;
  if (checkpoint.profile_version !== profile.version || checkpoint.rules_version !== RULES_VERSION) return null;
  if (Date.now() - new Date(checkpoint.updated_at || checkpoint.created_at || 0).getTime() > DAY) return null;
  return checkpoint;
}
async function clearCheckpoint(genre) {
  try { await fs.unlink(checkpointPath(genre)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}
async function writeSummary(run) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [
    `## Gemini music discovery ${run.genre}`,
    "",
    run.playlist_url ? `Playlist: ${run.playlist_url}` : "Playlist not created",
    `Total: ${run.total_minutes} min / ${run.selected.length} tracks`,
    `Gemini calls: ${run.gemini_calls}`,
    "",
    "| # | Artist | Track | Album | Audio |",
    "|---:|---|---|---|---|",
    ...run.selected.map((t,i) => `| ${i+1} | ${t.display_artist} | ${t.title} | ${t.album} | ${t.youtube.audioType} |`)
  ];
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}
async function credentialTest() {
  await geminiCredentialTest();
  const token = await googleToken();
  const channel = await ytGet("channels", token, { part: "snippet", mine: true, maxResults: 1 });
  if (!channel.items?.length) throw new Error("Google OAuth succeeded but YouTube returned no authorized channel");
  console.log("credential smoke test passed: Gemini model access + Google OAuth + YouTube");
}
async function selfTest() {
  const profile = await readJson(PROFILE_PATH);
  assert.equal(profile.hiphop.minimum_release_year, 2010);
  assert.equal(profile.rnb.minimum_release_year, null);
  assert.equal(profile.playlist.famous_artist_share, 0.30);
  assert.equal(profile.playlist.cooldown_days, 90);
  assert.equal(profile.playlist.max_tracks_per_album, 1);
  assertFreeTierEligibleModel(GEMINI_PREFILTER_MODEL);
  assertFreeTierEligibleModel(GEMINI_CURATOR_MODEL);
  const base = { display_artist: "Ace Hood", primary_artists: ["Ace Hood"], title: "Bugatti", version_type: "original" };
  assert.notEqual(trackKey(base), trackKey({ ...base, version_type: "official_remix" }));
  assert.equal(classifyOfficialAudio(base, { title: "Ace Hood - Bugatti (Official Music Video)", description: "", channelTitle: "AceHoodVEVO" }).ok, false);
  assert.equal(classifyOfficialAudio(base, { title: "Bugatti", description: "Provided to YouTube by Universal Music Group", channelTitle: "Ace Hood - Topic" }).ok, true);
  console.log("gemini music self-test passed");
}

async function main() {
  if (process.argv.includes("--credential-test")) { await credentialTest(); return; }
  if (process.argv.includes("--self-test")) { await selfTest(); return; }

  const profile = await readJson(PROFILE_PATH);
  const state = await readJson(STATE_PATH, { version: 1, recommended: [] });
  const genre = process.env.GENRE || "hiphop";
  if (!["hiphop","rnb"].includes(genre)) throw new Error("GENRE must be hiphop or rnb");
  assertFreeTierEligibleModel(GEMINI_PREFILTER_MODEL);
  assertFreeTierEligibleModel(GEMINI_CURATOR_MODEL);

  let checkpoint = await loadCheckpoint(genre, profile);
  if (!checkpoint) checkpoint = {
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    genre,
    profile_version: profile.version,
    rules_version: RULES_VERSION,
    prompt_version: PROMPT_VERSION,
    stage: "start"
  };

  let catalog;
  if (checkpoint.catalog?.candidates?.length) {
    catalog = checkpoint.catalog;
    console.log("resuming saved catalog", catalog.candidates.length);
  } else {
    catalog = await collectCatalog(profile, genre);
    checkpoint = { ...checkpoint, stage: "catalog", catalog, updated_at: new Date().toISOString() };
    await saveCheckpoint(genre, checkpoint);
  }

  const hard = hardFilter(catalog.candidates, profile, genre, state);
  if (hard.kept.length < 60) throw new Error(`Only ${hard.kept.length} candidates survived hard filters`);

  let prefiltered;
  if (checkpoint.prefiltered?.length) {
    prefiltered = checkpoint.prefiltered;
    console.log("resuming saved Gemini prefilter", prefiltered.length);
  } else {
    const tagged = await prefilterCandidates(profile, genre, hard.kept);
    prefiltered = applyPrefilter(tagged, genre);
    if (prefiltered.length < CURATOR_LIMIT) throw new Error(`Only ${prefiltered.length} candidates survived Gemini prefilter`);
    checkpoint = { ...checkpoint, stage: "prefilter", prefiltered, updated_at: new Date().toISOString() };
    await saveCheckpoint(genre, checkpoint);
  }

  let curated;
  if (checkpoint.curated?.length) {
    curated = checkpoint.curated;
    console.log("resuming saved Gemini curation", curated.length);
  } else {
    curated = await curateCandidates(profile, genre, prefiltered.slice(0, CURATOR_LIMIT));
    if (curated.length < 35) throw new Error(`Only ${curated.length} candidates survived final Gemini curation`);
    checkpoint = { ...checkpoint, stage: "curated", curated, gemini_usage: geminiUsage, updated_at: new Date().toISOString() };
    await saveCheckpoint(genre, checkpoint);
  }

  const shortlist = balancedShortlist(curated, profile, CURATOR_LIMIT);
  const token = await googleToken();
  const resolved = checkpoint.resolved || [];
  const attempted = new Set(checkpoint.attempted_candidate_ids || []);
  const youtubeRejected = checkpoint.youtube_rejected || [];
  let optimized = optimizeMaybe(resolved, profile);
  let searches = attempted.size;

  for (const t of shortlist) {
    if (optimized || searches >= YOUTUBE_SEARCH_LIMIT) break;
    if (attempted.has(t.candidate_id)) continue;
    const youtube = await resolveYouTube(t, token);
    searches += 1;
    attempted.add(t.candidate_id);
    if (youtube) resolved.push({ ...t, youtube });
    else youtubeRejected.push({ candidate_id: t.candidate_id, artist: t.display_artist, title: t.title });
    if (searches % 5 === 0) {
      checkpoint = { ...checkpoint, stage: "youtube", resolved, attempted_candidate_ids: [...attempted], youtube_rejected: youtubeRejected, updated_at: new Date().toISOString() };
      await saveCheckpoint(genre, checkpoint);
    }
    if (resolved.length >= 30) optimized = optimizeMaybe(resolved, profile);
  }

  checkpoint = { ...checkpoint, stage: "youtube", resolved, attempted_candidate_ids: [...attempted], youtube_rejected: youtubeRejected, updated_at: new Date().toISOString() };
  await saveCheckpoint(genre, checkpoint);

  if (!optimized) {
    const possibleMinutes = resolved.reduce((sum,t) => sum + t.youtube.durationSeconds, 0) / 60;
    throw new Error(`Verified pool could not satisfy 120 minutes within ${searches} YouTube searches; verified raw duration ${possibleMinutes.toFixed(1)} min. Saved checkpoint; next run will resume without repeating Gemini.`);
  }

  const create = String(process.env.CREATE_PLAYLIST || "true").toLowerCase() === "true";
  let playlist = null;
  let title = process.env.PLAYLIST_TITLE?.trim();
  if (!title) title = `Discovery Test - ${genre === "hiphop" ? "Hip-Hop" : "R&B"} - ${kstStamp()}`;

  if (create) {
    playlist = await createPlaylist(token, title, `Manual Gemini discovery test | profile ${profile.version} | ${RULES_VERSION} | no automatic updates`);
    await sleep(1200);
    try {
      for (const t of optimized.selected) await addVideo(token, playlist.id, t.youtube.videoId);
    } catch (error) {
      try { await deletePlaylist(token, playlist.id); } catch (rollbackError) { console.error("playlist rollback failed", rollbackError instanceof Error ? rollbackError.message : rollbackError); }
      throw error;
    }
  }

  const run = {
    ok: true,
    started_at: checkpoint.created_at,
    finished_at: new Date().toISOString(),
    genre,
    profile_version: profile.version,
    rules_version: RULES_VERSION,
    prompt_version: PROMPT_VERSION,
    models: { prefilter: GEMINI_PREFILTER_MODEL, curator: GEMINI_CURATOR_MODEL },
    gemini_calls: geminiCalls,
    gemini_usage: geminiUsage.length ? geminiUsage : checkpoint.gemini_usage || [],
    catalog_source_count: catalog.source_count,
    catalog_candidates: catalog.candidates.length,
    hard_kept: hard.kept.length,
    prefiltered: prefiltered.length,
    curated: curated.length,
    youtube_searches: searches,
    youtube_verified: resolved.length,
    youtube_rejected: youtubeRejected,
    playlist_id: playlist?.id || null,
    playlist_url: playlist ? `https://music.youtube.com/playlist?list=${playlist.id}` : null,
    playlist_title: title,
    total_seconds: optimized.total_seconds,
    total_minutes: optimized.total_minutes,
    selected: optimized.selected
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `${genre}-gemini-${Date.now()}.json`);
  await writeJson(outPath, run);

  if (create) {
    state.recommended ||= [];
    for (const t of optimized.selected) state.recommended.push({
      track_key: trackKey(t),
      recommended_at: run.finished_at,
      genre,
      playlist_id: playlist.id,
      artist: t.display_artist,
      title: t.title,
      album: t.album,
      version_type: t.version_type,
      video_id: t.youtube.videoId,
      model: GEMINI_CURATOR_MODEL,
      profile_version: profile.version,
      rules_version: RULES_VERSION,
      prompt_version: PROMPT_VERSION,
      traits: t.prefilter,
      taste_score: t.curation.taste_score
    });
    await writeJson(STATE_PATH, state);
  }

  await clearCheckpoint(genre);
  await writeSummary(run);
  console.log("gemini usage", JSON.stringify(run.gemini_usage));
  console.log(JSON.stringify({ ok: true, genre, playlistUrl: run.playlist_url, totalMinutes: run.total_minutes, tracks: run.selected.length, geminiCalls: run.gemini_calls, audit: outPath }, null, 2));
}

main().catch(async (error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
