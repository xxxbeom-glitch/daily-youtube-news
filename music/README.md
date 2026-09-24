# Manual music discovery engine (v1)

This directory contains the first manual-quality-test implementation for the personal YouTube Music discovery project.

## What is active now

- Manual GitHub Actions execution only. There is no music update schedule.
- One lane per run: `hiphop` or `rnb`.
- Research model: `gpt-5.6-terra` with OpenAI web search for a broad real-track candidate pool.
- Curator model: `gpt-5.6-sol` for subjective taste-fit scoring.
- Hard rules are enforced again in code after model output.
- YouTube output is restricted to Topic/Art Track or strict Official Audio matches.
- Music videos, VEVO videos, lyric videos, visualizers, live versions, remasters, slowed/reverb/sped-up/nightcore, fan uploads and unofficial remixes are rejected.
- The engine refuses to weaken hard rules merely to reach the target duration.
- Target playlist duration is 120 to 130 minutes.
- Permanent playlist naming, cover-art rules and automatic update cadence remain intentionally undecided.

## Execution design

The models do not get final authority over hard rules.

1. Research model discovers real candidate tracks and researched metadata using web search.
2. Deterministic hard filter applies scene, release, seed, remix, year, version and 90-day cooldown rules.
3. Curator model scores subjective fit and inferred musical traits. It is explicitly told it is not listening to audio.
4. YouTube verifier resolves the exact release and accepts only strict official-audio forms.
5. Deterministic optimizer enforces artist/album caps, 120-130 minute duration, recent-track ceiling and approximate era/fame balance.

This separates FACT, JUDGMENT and RULE responsibilities so an LLM claim alone cannot insert an unverified YouTube item.

## Personalization state in v1

The workflow uses an Actions cache at `.music-state/history.json` only as a prototype recommendation-history store. It records exact recommended versions and supports the 90-day cooldown between manual runs while that cache exists.

The cache is not the long-term personal database. GitHub caches can expire or be evicted. Before automatic updating is enabled, the approved event/history design should move to a private durable database. `music/personalization-schema.sql` documents that intended schema.

YouTube like/unlike feedback polling is not scheduled yet. The long-term design preserves an `ever_liked` positive preference even if the current YouTube like is later removed for UI cleanup. A missing like is neutral; only an explicit dislike should become a negative signal.

## Required GitHub Actions secrets

The manual workflow requires repository Actions secrets:

- `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`

GitHub Actions cannot read Vercel environment variables automatically, so these values must also exist as GitHub Actions secrets before the first real run. Never commit them to the repository.

## Quota note

The workflow resolves up to 40 tracks through YouTube search and then inserts final playlist items. Run one genre at a time; YouTube search and playlist insertion both consume API quota.

## Manual run

Open GitHub Actions -> `Music discovery playlist` -> `Run workflow`, choose `hiphop` or `rnb`, and leave `create_playlist=true` for the real test. A temporary timestamped title is used only when no title is supplied.

Each run uploads a JSON audit artifact containing hard-filter rejections, YouTube verification failures, selected tracks, model versions, model response IDs and curation scores.

## OpenAI v3 recommendation design

The active music workflow uses ListenBrainz as the main recommendation-candidate source and MusicBrainz for factual release metadata. Deterministic code applies hard rules and a cheap ranking before any LLM call.

Only the top compact candidate pool is sent to OpenAI once for subjective taste reranking. The workflow uses `gpt-5.6-sol` with low reasoning effort, no OpenAI web search, and no automatic expensive-model fallback.

After reranking, only shortlisted tracks are resolved against YouTube. Verified YouTube video IDs are cached in `.music-state/youtube-cache.json`, so repeat runs can avoid unnecessary `search.list` calls. YouTube quota exhaustion saves resume state instead of repeating OpenAI reranking.

Required secrets for the active workflow:

- `OPENAI_API_KEY`
- `LISTENBRAINZ_TOKEN`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`

Manual runs default to `create_playlist=false` for dry-run QA. Enable playlist creation only after reviewing the audit output.

Tagged push dry-runs use a 10-track test target.

For tagged 10-track QA runs, YouTube `search.list` is disabled; resolution uses cached IDs and MusicBrainz-linked YouTube videos/playlists first, then a GPT-5.6 Luna web locator for unresolved exact YouTube watch URLs.

Failed QA runs upload a resolver audit so unresolved YouTube-ID paths can be inspected without consuming search quota.

Per-track Luna lookup forces web search for unresolved exact YouTube watch URLs and stops after the test target is verified.

Broad web lookup may use non-YouTube index pages only to discover the canonical YouTube watch URL; final acceptance still requires YouTube API video verification.
