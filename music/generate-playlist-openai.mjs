import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const PROFILE_PATH = process.env.MUSIC_PROFILE_PATH || "music/profile.v1.json";
const STATE_PATH = process.env.MUSIC_STATE_PATH || ".music-state/history.json";
const YOUTUBE_CACHE_PATH = process.env.MUSIC_YOUTUBE_CACHE_PATH || ".music-state/youtube-cache.json";
const OUTPUT_DIR = process.env.MUSIC_OUTPUT_DIR || "music-output";
const OPENAI_MODEL = process.env.OPENAI_CURATOR_MODEL || "gpt-6-sol";
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "low";
const CATALOG_TARGET = Math.max(80, Math.min(140, Number(process.env.MUSIC_CATALOG_TARGET || 110)));
const RERANK_LIMIT = Math.max(30, Math.min(55, Number(process.env.MUSIC_RERANK_LIMIT || 48)));
const YOUTUBE_SEARCH_LIMIT = Math.max(20, Math.min(50, Number(process.env.YOUTUBE_SEARCH_LIMIT || 40)));
const CHECKPOINT_MAX_AGE_MS = 2 * 86400000;
const NEGATIVE_YOUTUBE_CACHE_MS = 7 * 86400000;
const DAY = 86400000;

const OPENAI = "https://api.openai.com/v1/responses";
const OPENAI_MODELS = "https://api.openai.com/v1/models";
const YT = "https://www.googleapis.com/youtube/v3";
const LB_ROOT = "https://api.listenbrainz.org";
const MB_ROOT = "https://musicbrainz.org/ws/2";
const APP_USER_AGENT = "daily-youtube-news-music/3.0 (https://github.com/xxxbeom-glitch/daily-youtube-news)";
const RULES_VERSION = "music-rules-v3-openai";
const PROMPT_VERSION = "music-prompts-v3-openai-1call";

let lastListenBrainzRequestAt = 0;
let lastMusicBrainzRequestAt = 0;

const norm = (v = "") => String(v)
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/\b(feat|featuring|ft)\.?\b.*$/i, " ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");

const titleNorm = (v = "") => norm(v)
  .replace(/\b(clean|explicit|radio edit|album version|single version|official audio)\b/g, " ")
  .trim()
  .replace(/\s+/g, " ");

const primaryKeys = (t) => [...new Set((t.primary_artists?.length ? t.primary_artists : [t.display_artist || ""]).map(norm).filter(Boolean))];
const trackKey = (t) => primaryKeys(t).sort().join("+") + "|" + titleNorm(t.title) + "|" + (t.version_type === "official_remix" ? "official_remix" : "original");
const albumKey = (t) => primaryKeys(t).sort().join("+") + "|" + norm(t.album || "unknown");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error("Missing required environment variable: " + name);
  return value;
}

function extractOutput(data) {
  if (typeof data.output_text === "string") return data.output_text;
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text") return content.text || "";
    }
  }
  return "";
}

const curatorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_id: { type: "string" },
          reject: { type: "boolean" },
          scene_fit: { type: "boolean" },
          taste_score: { type: "integer", minimum: 0, maximum: 100 },
          deep_cut_score: { type: "integer", minimum: 0, maximum: 100 },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          fame_tier: { type: "string", enum: ["famous", "less_known"] },
          risk_flags: {
            type: "array",
            maxItems: 4,
            items: {
              type: "string",
              enum: ["rage", "electronic_first", "too_soft", "ballad", "neo_soul_dominant", "kpop_scene", "none"]
            }
          }
        },
        required: [
          "candidate_id",
          "reject",
          "scene_fit",
          "taste_score",
          "deep_cut_score",
          "confidence",
          "fame_tier",
          "risk_flags"
        ]
      }
    }
  },
  required: ["results"]
};

async function callOpenAICurator(profile, genre, candidates) {
  const lane = genre === "hiphop" ? profile.hiphop : profile.rnb;
  const instructions = [
    "You are a compact subjective music reranker.",
    "Only judge the supplied candidate IDs. Never invent tracks or factual metadata.",
    "Do not claim to have listened to audio. If you do not know a track well, lower confidence instead of guessing.",
    "scene_fit means the primary artist is mainly identified with the U.S. or North-American hip-hop/R&B market.",
    "Exclude primary artists mainly identified with the Korean/K-pop industry. Ethnicity alone is never a reason to exclude.",
    "Prefer discoveries, album cuts and deep cuts over obvious representative hits.",
    "For hip-hop, strongly reject rage, hyperpop and electronic-first production.",
    "For R&B, require meaningful hip-hop drums/bass/rhythmic production and penalize sleepy ballads, acoustic-heavy or neo-soul-dominant tracks.",
    "A bright hip-hop track can fit when drums, bass and bounce are strong.",
    "Return exactly one result for every candidate_id.",
    "Positive taste signals: " + lane.positive.join("; "),
    "Negative taste signals: " + lane.negative.join("; ")
  ].join("\n");

  const compactCandidates = candidates.map((t) => ({
    candidate_id: t.candidate_id,
    artist: t.display_artist,
    title: t.title,
    album: t.album,
    release_year: t.release_year,
    tags: (t.tags || []).slice(0, 10),
    artist_countries: t.artist_countries || [],
    discovery_sources: t.discovery_sources || [],
    source_popularity: t.source_popularity || 0,
    deterministic_score: Number((t.deterministic_score || 0).toFixed(2))
  }));

  const body = {
    model: OPENAI_MODEL,
    store: false,
    instructions,
    input: JSON.stringify({
      genre,
      seeds: profile.seed_tracks[genre],
      production_only_seeds: profile.seed_tracks.production_only,
      favorite_artists: profile.favorite_artists,
      candidates: compactCandidates
    }),
    reasoning: { effort: OPENAI_REASONING_EFFORT },
    max_output_tokens: 5000,
    text: {
      format: {
        type: "json_schema",
        name: "music_rerank_v3",
        strict: true,
        schema: curatorSchema
      }
    }
  };

  const response = await fetch(OPENAI, {
    method: "POST",
    headers: {
      authorization: "Bearer " + requiredEnv("OPENAI_API_KEY"),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error("OpenAI " + OPENAI_MODEL + " failed (" + response.status + "): " + (await response.text()).slice(0, 1200));
  }

  const data = await response.json();
  const text = extractOutput(data);
  if (!text) throw new Error("OpenAI " + OPENAI_MODEL + " returned no structured output");

  return {
    parsed: JSON.parse(text),
    response_id: data.id || null,
    usage: data.usage || null
  };
}

async function throttledFetchJson(url, options, label, limiter) {
  const wait = 1100 - (Date.now() - limiter.last());
  if (wait > 0) await sleep(wait);

  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    limiter.mark();
    response = await fetch(url, options);
    if (response.ok) return response.json();

    if (![429, 503].includes(response.status) || attempt === 2) {
      throw new Error(label + " failed (" + response.status + "): " + (await response.text()).slice(0, 700));
    }

    const resetIn = Number(response.headers.get("x-ratelimit-reset-in") || 0);
    await sleep(Math.max(1200 * (attempt + 1), resetIn * 1000));
  }

  throw new Error(label + " failed");
}

async function listenBrainzJson(pathname, params = {}) {
  const url = new URL(LB_ROOT + "/" + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return throttledFetchJson(
    url,
    {
      headers: {
        Authorization: "Token " + requiredEnv("LISTENBRAINZ_TOKEN"),
        "User-Agent": APP_USER_AGENT,
        Accept: "application/json"
      }
    },
    "ListenBrainz " + pathname,
    {
      last: () => lastListenBrainzRequestAt,
      mark: () => { lastListenBrainzRequestAt = Date.now(); }
    }
  );
}

async function musicBrainzJson(pathname, params = {}) {
  const url = new URL(MB_ROOT + "/" + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  return throttledFetchJson(
    url,
    {
      headers: {
        "User-Agent": APP_USER_AGENT,
        Accept: "application/json"
      }
    },
    "MusicBrainz " + pathname,
    {
      last: () => lastMusicBrainzRequestAt,
      mark: () => { lastMusicBrainzRequestAt = Date.now(); }
    }
  );
}

async function findArtistMbid(name) {
  const data = await musicBrainzJson("artist/", {
    query: 'artist:"' + name.replace(/"/g, "") + '"',
    fmt: "json",
    limit: 5
  });
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
    const current = map.get(id) || {
      recording_mbid: id,
      total_listen_count: 0,
      sources: []
    };
    current.total_listen_count = Math.max(current.total_listen_count || 0, Number(node.total_listen_count || 0));
    if (source && !current.sources.includes(source)) current.sources.push(source);
    map.set(id, current);
  }

  for (const value of Object.values(node)) harvestRecordingRows(value, map, source);
}

function discoveryTags(genre) {
  return genre === "hiphop"
    ? ["trap", "drill", "southern hip hop", "boom bap", "gangsta rap", "club rap"]
    : ["contemporary r&b", "alternative r&b", "trap soul", "r&b", "hip hop soul", "urban contemporary"];
}

function neighborhoodSeeds(profile, genre) {
  const base = genre === "hiphop"
    ? ["Young Thug", "Drake", "Doechii", "Eminem", "Tyga", "Roddy Ricch"]
    : ["SZA", "The Weeknd", "Victoria Monét", "Bryson Tiller", "Frank Ocean", "Summer Walker"];

  const favorites = profile.favorite_artists || [];
  return [...new Set([...base, ...favorites])].slice(0, 9);
}

async function discoverRecordingRows(profile, genre) {
  const rows = new Map();

  for (const artistName of neighborhoodSeeds(profile, genre)) {
    try {
      const mbid = await findArtistMbid(artistName);
      if (!mbid) continue;

      const data = await listenBrainzJson("1/lb-radio/artist/" + mbid, {
        mode: "medium",
        max_similar_artists: 10,
        max_recordings_per_artist: 6,
        pop_begin: 3,
        pop_end: 80
      });

      harvestRecordingRows(data, rows, "artist:" + artistName);
    } catch (error) {
      console.warn("artist neighborhood source skipped", artistName, error instanceof Error ? error.message : error);
    }
  }

  for (const tag of discoveryTags(genre)) {
    try {
      const data = await listenBrainzJson("1/lb-radio/tags", {
        tag,
        pop_begin: 3,
        pop_end: 80,
        count: 100
      });
      harvestRecordingRows(data, rows, "tag:" + tag);
    } catch (error) {
      console.warn("tag source skipped", tag, error instanceof Error ? error.message : error);
    }
  }

  return [...rows.values()].sort((a, b) => {
    const aNeighborhood = a.sources.some((s) => s.startsWith("artist:")) ? 1 : 0;
    const bNeighborhood = b.sources.some((s) => s.startsWith("artist:")) ? 1 : 0;
    const sourceDelta = b.sources.length - a.sources.length;
    return bNeighborhood - aNeighborhood || sourceDelta || a.total_listen_count - b.total_listen_count;
  });
}

function releaseType(release) {
  const group = release?.["release-group"] || {};
  const primary = String(group["primary-type"] || "").toLowerCase();
  const secondary = (group["secondary-types"] || []).map((x) => String(x).toLowerCase());

  if (secondary.includes("compilation")) return "unknown";
  if (secondary.includes("mixtape/street")) return "mixtape";
  if (primary === "album") return "album";
  if (primary === "ep") return "ep";
  return "unknown";
}

function releaseYear(release) {
  const value = String(release?.date || release?.["release-group"]?.["first-release-date"] || "");
  const match = value.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

function artistCreditName(credit) {
  return credit?.name || credit?.artist?.name || "";
}

function youtubeIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0] || "";
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }

    if (/(^|\.)youtube\.com$/i.test(url.hostname) || /(^|\.)music\.youtube\.com$/i.test(url.hostname)) {
      if (url.pathname === "/watch") {
        const id = url.searchParams.get("v") || "";
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      const shortIndex = parts.findIndex((part) => ["shorts", "embed"].includes(part));
      if (shortIndex >= 0 && parts[shortIndex + 1] && /^[A-Za-z0-9_-]{11}$/.test(parts[shortIndex + 1])) {
        return parts[shortIndex + 1];
      }
    }
  } catch {
    return null;
  }

  return null;
}

function directYouTubeIds(recording) {
  const ids = [];
  for (const relation of recording.relations || []) {
    const target = relation?.url?.resource || relation?.target || "";
    const id = youtubeIdFromUrl(target);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 3);
}

function buildCatalogCandidate(recording, sourceRow) {
  const credits = recording["artist-credit"] || [];
  const primaryArtists = credits.map(artistCreditName).filter(Boolean);
  const displayArtist = credits.map((credit) => artistCreditName(credit) + (credit.joinphrase || "")).join("").trim() || primaryArtists.join(", ");
  const releases = recording.releases || [];

  const accepted = releases
    .filter((release) => ["album", "ep", "mixtape"].includes(releaseType(release)) && releaseYear(release));

  if (!recording.title || !displayArtist || !accepted.length) return null;

  accepted.sort((a, b) => releaseYear(a) - releaseYear(b));
  const chosen = accepted[0];
  const album = chosen?.["release-group"]?.title || chosen?.title || "";
  const year = releaseYear(chosen);
  const date = chosen?.date || String(year) + "-01-01";
  const hasSingleRelease = releases.some((release) => String(release?.["release-group"]?.["primary-type"] || "").toLowerCase() === "single");
  const tags = (recording.tags || [])
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
    .slice(0, 15)
    .map((tag) => tag.name)
    .filter(Boolean);
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
    direct_youtube_ids: directYouTubeIds(recording),
    evidence_urls: ["https://musicbrainz.org/recording/" + recording.id]
  };
}

function staticRejectReasons(t, profile, genre) {
  const reasons = [];

  if (!profile.playlist.accepted_release_types.includes(t.release_type)) reasons.push("release_type");
  if (t.title_track) reasons.push("title_track");
  if (t.version_type === "official_remix" && !t.remix_materially_distinct) reasons.push("unverified_remix_distinction");
  if (t.version_type === "original" && ["single", "pre_release"].includes(t.single_status)) reasons.push("single_or_prerelease");
  if (genre === "hiphop" && t.release_year < profile.hiphop.minimum_release_year) reasons.push("pre_2010_hiphop");
  if (/\b(slowed|reverb|sped up|nightcore|remaster|live|acoustic|karaoke)\b/i.test(t.title)) reasons.push("bad_version_marker");

  return reasons;
}

async function collectCatalog(profile, genre) {
  const sourceRows = await discoverRecordingRows(profile, genre);
  if (sourceRows.length < CATALOG_TARGET) {
    throw new Error("Catalog discovery returned only " + sourceRows.length + " unique recording IDs");
  }

  const candidates = [];
  const rejected = [];

  for (const row of sourceRows) {
    if (candidates.length >= CATALOG_TARGET) break;

    try {
      const recording = await musicBrainzJson("recording/" + row.recording_mbid, {
        fmt: "json",
        inc: "artist-credits+artists+releases+release-groups+tags+url-rels"
      });

      const candidate = buildCatalogCandidate(recording, row);
      if (!candidate) {
        rejected.push({ recording_mbid: row.recording_mbid, reasons: ["missing_album_metadata"] });
        continue;
      }

      const reasons = staticRejectReasons(candidate, profile, genre);
      if (reasons.length) {
        rejected.push({
          recording_mbid: row.recording_mbid,
          artist: candidate.display_artist,
          title: candidate.title,
          reasons
        });
      } else {
        candidates.push(candidate);
      }
    } catch (error) {
      console.warn("catalog enrichment skipped", row.recording_mbid, error instanceof Error ? error.message : error);
    }
  }

  if (candidates.length < 65) {
    throw new Error("Only " + candidates.length + " catalog candidates survived factual filters");
  }

  return {
    candidates,
    rejected,
    source_count: sourceRows.length
  };
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
  const recentKeys = new Set(
    (state.recommended || [])
      .filter((item) => new Date(item.recommended_at).getTime() >= cutoff)
      .map((item) => item.track_key)
  );

  const kept = [];
  const rejected = [];

  for (const [index, raw] of candidates.entries()) {
    const t = { ...raw, candidate_id: "c" + (index + 1) };
    const reasons = [...staticRejectReasons(t, profile, genre)];

    if (seedBlocked(t, profile, genre)) reasons.push("seed_track");
    if (recentKeys.has(trackKey(t))) reasons.push("90_day_cooldown");
    if (!t.evidence_urls?.length) reasons.push("no_fact_evidence");

    if (reasons.length) {
      rejected.push({ ...t, reject_reasons: [...new Set(reasons)] });
    } else {
      kept.push(t);
    }
  }

  return { kept, rejected };
}

function eraBucket(t, now = new Date()) {
  const date = t.release_date ? new Date(t.release_date) : new Date(Date.UTC(t.release_year, 6, 1));
  if (Number.isNaN(date.getTime())) return "unknown";

  const years = Math.max(0, (now - date) / (365.25 * DAY));
  if (years <= 1) return "recent_12_months";
  if (years <= 5) return "one_to_five_years";
  if (years <= 10) return "six_to_ten_years";
  return "older_than_ten_years";
}

function desiredTagWords(genre) {
  return genre === "hiphop"
    ? ["trap", "drill", "southern", "hip hop", "hip-hop", "rap", "boom bap", "gangsta"]
    : ["r&b", "rnb", "contemporary", "alternative r&b", "trap soul", "hip hop soul", "urban"];
}

function applyDeterministicScores(candidates, profile, genre) {
  const popularitySorted = [...candidates]
    .sort((a, b) => Number(a.source_popularity || 0) - Number(b.source_popularity || 0));
  const popularityRank = new Map(popularitySorted.map((t, i) => [trackKey(t), i / Math.max(1, popularitySorted.length - 1)]));
  const favoriteKeys = new Set((profile.favorite_artists || []).map(norm));
  const wantedTags = desiredTagWords(genre).map(norm);

  return candidates.map((t) => {
    const sources = t.discovery_sources || [];
    const artistSources = sources.filter((s) => s.startsWith("artist:"));
    const tagSources = sources.filter((s) => s.startsWith("tag:"));
    const tags = (t.tags || []).map(norm);
    const wantedHits = wantedTags.filter((wanted) => tags.some((tag) => tag.includes(wanted) || wanted.includes(tag))).length;
    const favoriteArtist = primaryKeys(t).some((artist) => favoriteKeys.has(artist));
    const percentile = popularityRank.get(trackKey(t)) ?? 0.5;

    let novelty = 0;
    if (percentile >= 0.10 && percentile <= 0.60) novelty = 20;
    else if (percentile > 0.60 && percentile <= 0.80) novelty = 12;
    else if (percentile < 0.10) novelty = 8;
    else novelty = 2;

    const score =
      Math.min(28, artistSources.length * 14) +
      Math.min(18, tagSources.length * 6) +
      Math.min(18, sources.length * 4) +
      Math.min(20, wantedHits * 4) +
      novelty +
      (favoriteArtist ? 10 : 0) +
      (t.direct_youtube_ids?.length ? 4 : 0);

    return {
      ...t,
      deterministic_score: score,
      popularity_percentile: percentile
    };
  }).sort((a, b) => b.deterministic_score - a.deterministic_score);
}

function selectRerankPool(items, profile, limit) {
  const targetShares = Object.fromEntries(profile.era_mix.map((x) => [x.bucket, x.share]));
  const buckets = new Map();
  for (const item of items) {
    const bucket = eraBucket(item);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(item);
  }

  const selected = [];
  const selectedKeys = new Set();
  const artistCounts = new Map();
  const albumCounts = new Map();

  function canTake(t) {
    const artists = primaryKeys(t);
    if (artists.some((artist) => (artistCounts.get(artist) || 0) >= 3)) return false;
    if ((albumCounts.get(albumKey(t)) || 0) >= 2) return false;
    return true;
  }

  function take(t) {
    selected.push(t);
    selectedKeys.add(trackKey(t));
    for (const artist of primaryKeys(t)) artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
    albumCounts.set(albumKey(t), (albumCounts.get(albumKey(t)) || 0) + 1);
  }

  for (const [bucket, share] of Object.entries(targetShares)) {
    const desired = Math.max(1, Math.round(limit * share));
    const pool = buckets.get(bucket) || [];
    let taken = 0;

    for (const t of pool) {
      if (taken >= desired || selected.length >= limit) break;
      if (selectedKeys.has(trackKey(t)) || !canTake(t)) continue;
      take(t);
      taken += 1;
    }
  }

  for (const t of items) {
    if (selected.length >= limit) break;
    if (selectedKeys.has(trackKey(t)) || !canTake(t)) continue;
    take(t);
  }

  return selected;
}

function mergeCuration(candidates, results, genre) {
  const byId = new Map(results.map((r) => [r.candidate_id, r]));

  return candidates
    .map((t) => ({ ...t, curation: byId.get(t.candidate_id) }))
    .filter((t) => t.curation)
    .filter((t) => !t.curation.reject && t.curation.scene_fit)
    .filter((t) => {
      const flags = new Set(t.curation.risk_flags || []);
      if (flags.has("kpop_scene")) return false;
      if (genre === "hiphop" && (flags.has("rage") || flags.has("electronic_first"))) return false;
      if (genre === "rnb" && (flags.has("ballad") || flags.has("neo_soul_dominant"))) return false;
      return true;
    })
    .sort((a, b) => curationScore(b) - curationScore(a));
}

function curationScore(t) {
  const c = t.curation;
  let score = c.taste_score + 0.30 * c.deep_cut_score + 0.10 * c.confidence + 0.08 * (t.deterministic_score || 0);
  if (c.confidence < 45) score -= 20;
  else if (c.confidence < 60) score -= 8;
  return score;
}

function balancedShortlist(items, profile, limit = RERANK_LIMIT) {
  const out = [];
  const artists = new Map();
  const albums = new Set();
  const famousTarget = Math.ceil(limit * profile.playlist.famous_artist_share);

  function allowed(t) {
    const keys = primaryKeys(t);
    if (keys.some((key) => (artists.get(key) || 0) >= profile.playlist.max_tracks_per_primary_artist)) return false;
    if (albums.has(albumKey(t))) return false;

    if (
      t.curation.fame_tier === "famous" &&
      out.filter((x) => x.curation.fame_tier === "famous").length >= famousTarget
    ) {
      return false;
    }

    return true;
  }

  function add(t) {
    out.push(t);
    for (const key of primaryKeys(t)) artists.set(key, (artists.get(key) || 0) + 1);
    albums.add(albumKey(t));
  }

  for (const t of items) {
    if (out.length >= limit) break;
    if (!allowed(t)) continue;
    add(t);
  }

  if (out.length < limit) {
    for (const t of items) {
      if (out.length >= limit) break;
      if (out.includes(t)) continue;

      const keys = primaryKeys(t);
      if (keys.some((key) => (artists.get(key) || 0) >= profile.playlist.max_tracks_per_primary_artist)) continue;
      if (albums.has(albumKey(t))) continue;
      add(t);
    }
  }

  return out;
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

  if (!response.ok) {
    throw new Error("Google token refresh failed (" + response.status + "): " + (await response.text()).slice(0, 500));
  }

  return (await response.json()).access_token;
}

async function ytGet(pathname, token, params = {}) {
  const url = new URL(YT + "/" + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: { authorization: "Bearer " + token }
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 900);
    const error = new Error("YouTube GET " + pathname + " failed (" + response.status + "): " + detail);
    error.status = response.status;
    error.isQuota = response.status === 429 || /quota|rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(detail);
    throw error;
  }

  return response.json();
}

async function ytPost(pathname, token, params, body) {
  const url = new URL(YT + "/" + pathname);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error("YouTube POST " + pathname + " failed (" + response.status + "): " + (await response.text()).slice(0, 700));
  }

  return response.json();
}

async function ytDelete(pathname, token, params = {}) {
  const url = new URL(YT + "/" + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: "DELETE",
    headers: { authorization: "Bearer " + token }
  });

  if (!response.ok) {
    throw new Error("YouTube DELETE " + pathname + " failed (" + response.status + "): " + (await response.text()).slice(0, 700));
  }
}

function isoSeconds(value = "") {
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  return match
    ? Number(match[1] || 0) * 86400 +
        Number(match[2] || 0) * 3600 +
        Number(match[3] || 0) * 60 +
        Number(match[4] || 0)
    : null;
}

function artistMatch(t, text) {
  const normalized = norm(text);
  return primaryKeys(t).some((artist) =>
    normalized.includes(artist) ||
    artist.split(" ").filter(Boolean).every((part) => normalized.includes(part))
  );
}

function classifyOfficialAudio(t, v) {
  const text = v.title + "\n" + v.description + "\n" + v.channelTitle;
  const low = text.toLowerCase();

  if (/official music video|music video|\bvevo\b|lyric video|visualizer|\blive\b|performance|concert|slowed|reverb|sped.?up|nightcore|karaoke|remaster|reaction/.test(low)) {
    return { ok: false, reason: "non_audio_content" };
  }

  if (t.version_type === "official_remix" && !/remix/i.test(text)) {
    return { ok: false, reason: "remix_not_matched" };
  }

  if (t.version_type === "original" && /\bremix\b/i.test(v.title)) {
    return { ok: false, reason: "unexpected_remix" };
  }

  const ytTitle = titleNorm(v.title);
  const wanted = titleNorm(t.title);
  const titleOk = ytTitle.includes(wanted) || wanted.includes(ytTitle.replace(/ official audio/g, ""));

  if (!titleOk || !artistMatch(t, text)) {
    return { ok: false, reason: "title_or_artist_mismatch" };
  }

  if (/ - topic$/i.test(v.channelTitle) || /provided to youtube by/i.test(v.description)) {
    return { ok: true, type: "art_track" };
  }

  if (/official audio/i.test(v.title) && artistMatch(t, v.channelTitle)) {
    return { ok: true, type: "official_audio" };
  }

  return { ok: false, reason: "not_verified_official_audio" };
}

function videoObject(item) {
  return {
    videoId: item.id,
    title: item.snippet?.title || "",
    description: item.snippet?.description || "",
    channelTitle: item.snippet?.channelTitle || "",
    durationSeconds: isoSeconds(item.contentDetails?.duration),
    publishedAt: item.snippet?.publishedAt || "",
    viewCount: Number(item.statistics?.viewCount || 0)
  };
}

async function getVideoDetails(token, ids) {
  const map = new Map();
  const unique = [...new Set(ids.filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)))];

  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const data = await ytGet("videos", token, {
      part: "snippet,contentDetails,statistics,status",
      id: chunk.join(",")
    });

    for (const item of data.items || []) {
      map.set(item.id, videoObject(item));
    }
  }

  return map;
}

function chooseOfficialAudio(t, videos) {
  const ranked = [];

  for (const v of videos) {
    if (!v || !Number.isFinite(v.durationSeconds) || v.durationSeconds < 60 || v.durationSeconds > 720) continue;
    const classification = classifyOfficialAudio(t, v);
    if (classification.ok) ranked.push({ ...v, audioType: classification.type });
  }

  ranked.sort((a, b) => {
    const typeA = a.audioType === "art_track" ? 0 : 1;
    const typeB = b.audioType === "art_track" ? 0 : 1;
    return typeA - typeB || b.viewCount - a.viewCount;
  });

  return ranked[0] || null;
}

async function resolveYouTubeSearch(t, token) {
  const query = [
    t.display_artist,
    t.title,
    t.version_type === "official_remix" ? "remix" : ""
  ].filter(Boolean).join(" ");

  const search = await ytGet("search", token, {
    part: "snippet",
    q: query,
    type: "video",
    videoCategoryId: 10,
    maxResults: 10
  });

  const ids = (search.items || []).map((item) => item.id?.videoId).filter(Boolean);
  if (!ids.length) return null;

  const details = await getVideoDetails(token, ids);
  return chooseOfficialAudio(t, ids.map((id) => details.get(id)));
}

function freshNegativeCache(entry) {
  if (!entry?.missed_at) return false;
  return Date.now() - new Date(entry.missed_at).getTime() < NEGATIVE_YOUTUBE_CACHE_MS;
}

async function resolveYouTubePool(candidates, token, profile, cache, onProgress) {
  cache.version ||= 1;
  cache.entries ||= {};

  const candidateByKey = new Map(candidates.map((t) => [trackKey(t), t]));
  const candidateIds = new Map();

  for (const t of candidates) {
    const key = trackKey(t);
    const cachedId = cache.entries[key]?.video_id;
    const ids = [
      ...(cachedId ? [cachedId] : []),
      ...(t.direct_youtube_ids || [])
    ];
    candidateIds.set(t.candidate_id, [...new Set(ids)]);
  }

  const initialIds = [...new Set([...candidateIds.values()].flat())];
  const initialDetails = initialIds.length ? await getVideoDetails(token, initialIds) : new Map();
  const resolved = [];
  const resolvedKeys = new Set();

  for (const t of candidates) {
    const ids = candidateIds.get(t.candidate_id) || [];
    const match = chooseOfficialAudio(t, ids.map((id) => initialDetails.get(id)));
    if (!match) continue;

    const key = trackKey(t);
    resolved.push({ ...t, youtube: match });
    resolvedKeys.add(key);
    cache.entries[key] = {
      video_id: match.videoId,
      audio_type: match.audioType,
      title: match.title,
      channel_title: match.channelTitle,
      duration_seconds: match.durationSeconds,
      verified_at: new Date().toISOString()
    };
  }

  let optimized = optimizeMaybe(resolved, profile);
  let searches = 0;
  let quotaExhausted = false;

  for (const t of candidates) {
    if (optimized || searches >= YOUTUBE_SEARCH_LIMIT) break;

    const key = trackKey(t);
    if (resolvedKeys.has(key)) continue;
    if (freshNegativeCache(cache.entries[key])) continue;

    try {
      const youtube = await resolveYouTubeSearch(t, token);
      searches += 1;

      if (youtube) {
        resolved.push({ ...t, youtube });
        resolvedKeys.add(key);
        cache.entries[key] = {
          video_id: youtube.videoId,
          audio_type: youtube.audioType,
          title: youtube.title,
          channel_title: youtube.channelTitle,
          duration_seconds: youtube.durationSeconds,
          verified_at: new Date().toISOString()
        };
      } else {
        cache.entries[key] = {
          missed_at: new Date().toISOString()
        };
      }

      await writeJson(YOUTUBE_CACHE_PATH, cache);
      if (onProgress) await onProgress({ resolved, searches, quotaExhausted: false });

      if (resolved.length >= 28) optimized = optimizeMaybe(resolved, profile);
    } catch (error) {
      if (error?.isQuota) {
        quotaExhausted = true;
        await writeJson(YOUTUBE_CACHE_PATH, cache);
        if (onProgress) await onProgress({ resolved, searches, quotaExhausted: true });
        break;
      }
      throw error;
    }
  }

  const rejected = candidates
    .filter((t) => !resolvedKeys.has(trackKey(t)))
    .map((t) => ({
      candidate_id: t.candidate_id,
      artist: t.display_artist,
      title: t.title,
      negative_cache: freshNegativeCache(cache.entries[trackKey(t)])
    }));

  return {
    resolved,
    rejected,
    optimized: optimized || optimizeMaybe(resolved, profile),
    searches,
    quotaExhausted
  };
}

function finalScore(t, profile, current, totalSeconds) {
  let score = curationScore(t);
  const famous = current.filter((x) => x.curation.fame_tier === "famous").length;

  if (
    t.curation.fame_tier === "famous" &&
    famous / Math.max(1, current.length + 1) > profile.playlist.famous_artist_share + 0.08
  ) {
    score -= 18;
  }

  const bucket = eraBucket(t);
  const target = Object.fromEntries(profile.era_mix.map((x) => [x.bucket, x.share]));
  const count = current.filter((x) => eraBucket(x) === bucket).length;

  if ((count + 1) / Math.max(1, current.length + 1) > (target[bucket] || 0) + 0.12) score -= 12;
  if (bucket === "recent_12_months" && (count + 1) / Math.max(1, current.length + 1) > 0.10) score -= 25;
  if (totalSeconds + t.youtube.durationSeconds > profile.playlist.max_duration_minutes * 60) score -= 1000;

  return score;
}

function optimizeMaybe(resolved, profile) {
  const minimum = profile.playlist.min_duration_minutes * 60;
  const pool = [...resolved];
  const selected = [];
  const artistCounts = new Map();
  const albums = new Set();
  let seconds = 0;

  while (pool.length && seconds < minimum) {
    let best = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i += 1) {
      const t = pool[i];
      const keys = primaryKeys(t);

      if (keys.some((key) => (artistCounts.get(key) || 0) >= profile.playlist.max_tracks_per_primary_artist)) continue;
      if (albums.has(albumKey(t))) continue;

      const score = finalScore(t, profile, selected, seconds);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }

    if (best < 0 || bestScore < -500) break;

    const [t] = pool.splice(best, 1);
    selected.push(t);
    seconds += t.youtube.durationSeconds;

    for (const key of primaryKeys(t)) artistCounts.set(key, (artistCounts.get(key) || 0) + 1);
    albums.add(albumKey(t));
  }

  if (seconds < minimum) return null;

  return {
    selected,
    total_seconds: seconds,
    total_minutes: Number((seconds / 60).toFixed(1))
  };
}

async function createPlaylist(token, title, description) {
  return ytPost(
    "playlists",
    token,
    { part: "snippet,status" },
    {
      snippet: { title, description },
      status: { privacyStatus: "private" }
    }
  );
}

async function addVideo(token, playlistId, videoId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await ytPost(
        "playlistItems",
        token,
        { part: "snippet" },
        {
          snippet: {
            playlistId,
            resourceId: {
              kind: "youtube#video",
              videoId
            }
          }
        }
      );
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(1200 * (attempt + 1));
    }
  }
}

async function deletePlaylist(token, playlistId) {
  await ytDelete("playlists", token, { id: playlistId });
}

function kstStamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return value.year + "." + value.month + "." + value.day + " " + value.hour + value.minute;
}

function checkpointPath(genre) {
  return path.join(path.dirname(STATE_PATH), "inflight-" + genre + "-openai-v3.json");
}

async function saveCheckpoint(genre, data) {
  await writeJson(checkpointPath(genre), data);
}

async function loadCheckpoint(genre, profile) {
  const checkpoint = await readJson(checkpointPath(genre), null);
  if (!checkpoint) return null;
  if (checkpoint.profile_version !== profile.version || checkpoint.rules_version !== RULES_VERSION) return null;

  const updated = new Date(checkpoint.updated_at || checkpoint.created_at || 0).getTime();
  if (!Number.isFinite(updated) || Date.now() - updated > CHECKPOINT_MAX_AGE_MS) return null;

  return checkpoint;
}

async function clearCheckpoint(genre) {
  try {
    await fs.unlink(checkpointPath(genre));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeSummary(run) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;

  const lines = [
    "## OpenAI music discovery " + run.genre,
    "",
    run.playlist_url ? "Playlist: " + run.playlist_url : "Dry run: playlist not created",
    "Total: " + run.total_minutes + " min / " + run.selected.length + " tracks",
    "OpenAI calls: " + run.openai_calls,
    "YouTube search calls: " + run.youtube_searches,
    "",
    "| # | Artist | Track | Album | Audio |",
    "|---:|---|---|---|---|",
    ...run.selected.map((t, i) =>
      "| " + (i + 1) + " | " + t.display_artist + " | " + t.title + " | " + t.album + " | " + t.youtube.audioType + " |"
    )
  ];

  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

async function credentialTest() {
  const openai = await fetch(OPENAI_MODELS + "/" + encodeURIComponent(OPENAI_MODEL), {
    headers: { authorization: "Bearer " + requiredEnv("OPENAI_API_KEY") }
  });
  if (!openai.ok) {
    throw new Error("OpenAI model access check failed (" + openai.status + "): " + (await openai.text()).slice(0, 500));
  }

  const listenBrainz = await fetch(LB_ROOT + "/1/validate-token", {
    headers: {
      Authorization: "Token " + requiredEnv("LISTENBRAINZ_TOKEN"),
      "User-Agent": APP_USER_AGENT,
      Accept: "application/json"
    }
  });
  if (!listenBrainz.ok) {
    throw new Error("ListenBrainz token check failed (" + listenBrainz.status + "): " + (await listenBrainz.text()).slice(0, 500));
  }
  const tokenInfo = await listenBrainz.json();
  if (!tokenInfo.valid) throw new Error("ListenBrainz token is not valid");

  const token = await googleToken();
  const channel = await ytGet("channels", token, {
    part: "snippet",
    mine: true,
    maxResults: 1
  });
  if (!channel.items?.length) {
    throw new Error("Google OAuth succeeded but YouTube returned no authorized channel");
  }

  console.log("credential smoke test passed: OpenAI + ListenBrainz + Google OAuth + YouTube");
}

async function selfTest() {
  const profile = await readJson(PROFILE_PATH);

  assert.equal(profile.hiphop.minimum_release_year, 2010);
  assert.equal(profile.rnb.minimum_release_year, null);
  assert.equal(profile.playlist.famous_artist_share, 0.30);
  assert.equal(profile.playlist.cooldown_days, 90);
  assert.equal(profile.playlist.max_tracks_per_album, 1);

  const base = {
    display_artist: "Ace Hood",
    primary_artists: ["Ace Hood"],
    title: "Bugatti",
    version_type: "original"
  };

  assert.notEqual(trackKey(base), trackKey({ ...base, version_type: "official_remix" }));
  assert.equal(
    classifyOfficialAudio(base, {
      title: "Ace Hood - Bugatti (Official Music Video)",
      description: "",
      channelTitle: "AceHoodVEVO"
    }).ok,
    false
  );
  assert.equal(
    classifyOfficialAudio(base, {
      title: "Bugatti",
      description: "Provided to YouTube by Universal Music Group",
      channelTitle: "Ace Hood - Topic"
    }).ok,
    true
  );
  assert.equal(youtubeIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeIdFromUrl("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");

  console.log("openai music self-test passed");
}

async function main() {
  if (process.argv.includes("--credential-test")) {
    await credentialTest();
    return;
  }

  if (process.argv.includes("--self-test")) {
    await selfTest();
    return;
  }

  const profile = await readJson(PROFILE_PATH);
  const state = await readJson(STATE_PATH, { version: 1, recommended: [] });
  const youtubeCache = await readJson(YOUTUBE_CACHE_PATH, { version: 1, entries: {} });
  const genre = process.env.GENRE || "hiphop";

  if (!["hiphop", "rnb"].includes(genre)) {
    throw new Error("GENRE must be hiphop or rnb");
  }

  let checkpoint = await loadCheckpoint(genre, profile);
  if (!checkpoint) {
    checkpoint = {
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      genre,
      profile_version: profile.version,
      rules_version: RULES_VERSION,
      prompt_version: PROMPT_VERSION,
      stage: "start"
    };
  }

  let catalog;
  if (checkpoint.catalog?.candidates?.length) {
    catalog = checkpoint.catalog;
    console.log("resuming saved factual catalog", catalog.candidates.length);
  } else {
    catalog = await collectCatalog(profile, genre);
    checkpoint = {
      ...checkpoint,
      stage: "catalog",
      catalog,
      updated_at: new Date().toISOString()
    };
    await saveCheckpoint(genre, checkpoint);
  }

  const hard = hardFilter(catalog.candidates, profile, genre, state);
  if (hard.kept.length < 50) {
    throw new Error("Only " + hard.kept.length + " candidates survived hard filters");
  }

  const deterministic = applyDeterministicScores(hard.kept, profile, genre);
  const rerankPool = selectRerankPool(deterministic, profile, RERANK_LIMIT);

  let curated;
  let openaiUsage = checkpoint.openai_usage || null;
  let openaiResponseId = checkpoint.openai_response_id || null;
  let openaiCalls = 0;

  if (checkpoint.curated?.length) {
    curated = checkpoint.curated;
    console.log("resuming saved OpenAI rerank", curated.length);
  } else {
    const rerank = await callOpenAICurator(profile, genre, rerankPool);
    openaiCalls = 1;
    openaiUsage = rerank.usage;
    openaiResponseId = rerank.response_id;

    curated = mergeCuration(rerankPool, rerank.parsed.results || [], genre);
    if (curated.length < 30) {
      throw new Error("Only " + curated.length + " candidates survived OpenAI rerank");
    }

    checkpoint = {
      ...checkpoint,
      stage: "curated",
      curated,
      openai_usage: openaiUsage,
      openai_response_id: openaiResponseId,
      updated_at: new Date().toISOString()
    };
    await saveCheckpoint(genre, checkpoint);
  }

  const shortlist = balancedShortlist(curated, profile, Math.min(RERANK_LIMIT, curated.length));
  const token = await googleToken();

  const resolution = await resolveYouTubePool(
    shortlist,
    token,
    profile,
    youtubeCache,
    async ({ resolved, searches, quotaExhausted }) => {
      checkpoint = {
        ...checkpoint,
        stage: "youtube",
        youtube_progress: {
          resolved,
          searches,
          quota_exhausted: quotaExhausted
        },
        updated_at: new Date().toISOString()
      };
      await saveCheckpoint(genre, checkpoint);
    }
  );

  checkpoint = {
    ...checkpoint,
    stage: "youtube",
    youtube_progress: {
      resolved: resolution.resolved,
      searches: resolution.searches,
      quota_exhausted: resolution.quotaExhausted
    },
    updated_at: new Date().toISOString()
  };
  await saveCheckpoint(genre, checkpoint);
  await writeJson(YOUTUBE_CACHE_PATH, youtubeCache);

  if (!resolution.optimized) {
    const possibleMinutes = resolution.resolved.reduce((sum, t) => sum + t.youtube.durationSeconds, 0) / 60;
    const suffix = resolution.quotaExhausted
      ? " YouTube search quota was exhausted; checkpoint saved for resume."
      : " Checkpoint saved for resume.";

    throw new Error(
      "Verified pool could not satisfy 120 minutes. Verified raw duration " +
      possibleMinutes.toFixed(1) +
      " min after " +
      resolution.searches +
      " new YouTube searches." +
      suffix
    );
  }

  const optimized = resolution.optimized;
  const create = String(process.env.CREATE_PLAYLIST || "false").toLowerCase() === "true";
  let playlist = null;
  let title = process.env.PLAYLIST_TITLE?.trim();

  if (!title) {
    title = "Discovery Test - " + (genre === "hiphop" ? "Hip-Hop" : "R&B") + " - " + kstStamp();
  }

  if (create) {
    playlist = await createPlaylist(
      token,
      title,
      "OpenAI v3 discovery | profile " + profile.version + " | " + RULES_VERSION + " | one LLM rerank"
    );

    await sleep(1200);

    try {
      for (const t of optimized.selected) {
        await addVideo(token, playlist.id, t.youtube.videoId);
      }
    } catch (error) {
      try {
        await deletePlaylist(token, playlist.id);
      } catch (rollbackError) {
        console.error("playlist rollback failed", rollbackError instanceof Error ? rollbackError.message : rollbackError);
      }
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
    model: OPENAI_MODEL,
    reasoning_effort: OPENAI_REASONING_EFFORT,
    openai_calls: openaiCalls,
    openai_response_id: openaiResponseId,
    openai_usage: openaiUsage,
    catalog_source_count: catalog.source_count,
    catalog_candidates: catalog.candidates.length,
    hard_kept: hard.kept.length,
    rerank_pool: rerankPool.length,
    curated: curated.length,
    shortlist: shortlist.length,
    youtube_searches: resolution.searches,
    youtube_verified: resolution.resolved.length,
    youtube_rejected: resolution.rejected,
    playlist_id: playlist?.id || null,
    playlist_url: playlist ? "https://music.youtube.com/playlist?list=" + playlist.id : null,
    playlist_title: title,
    total_seconds: optimized.total_seconds,
    total_minutes: optimized.total_minutes,
    selected: optimized.selected
  };

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, genre + "-openai-v3-" + Date.now() + ".json");
  await writeJson(outPath, run);

  if (create) {
    state.recommended ||= [];

    for (const t of optimized.selected) {
      state.recommended.push({
        track_key: trackKey(t),
        recommended_at: run.finished_at,
        genre,
        playlist_id: playlist.id,
        artist: t.display_artist,
        title: t.title,
        album: t.album,
        version_type: t.version_type,
        video_id: t.youtube.videoId,
        model: OPENAI_MODEL,
        profile_version: profile.version,
        rules_version: RULES_VERSION,
        prompt_version: PROMPT_VERSION,
        taste_score: t.curation.taste_score,
        deep_cut_score: t.curation.deep_cut_score,
        confidence: t.curation.confidence
      });
    }

    await writeJson(STATE_PATH, state);
  }

  await clearCheckpoint(genre);
  await writeSummary(run);

  console.log("openai usage", JSON.stringify(run.openai_usage));
  console.log(JSON.stringify({
    ok: true,
    genre,
    playlistUrl: run.playlist_url,
    totalMinutes: run.total_minutes,
    tracks: run.selected.length,
    openaiCalls: run.openai_calls,
    youtubeSearches: run.youtube_searches,
    audit: outPath
  }, null, 2));
}

main().catch(async (error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
