# Independent audio briefing architecture

## Non-negotiable separation

The live path (`GET /api/cron/daily-news`, `lib/select.js`, `lib/youtube.js`, `api/status.js`, `vercel.json`) is stable and **must not be modified** as part of the initial audio work. The 08:00 KST private playlist and its retention/mandatory clips remain exactly as-is. New functionality lives under `audio-briefing/` until reviewed independently.

Current `selectNewsVideos` consumes YouTube metadata (title and description), not the video speech. It cannot support a factual broadcast script on its own. Reading a private playlist is a future read-only integration; the prototype accepts a manually constructed manifest.

## Proposed data flow (not activated)

    EXISTING PRODUCTION SYSTEM
    08:00 KST cron -> news selection -> private YouTube playlist
                                           |
                                           | read-only access, future opt-in
                                           v
    AUDIO-BRIEFING (separate runtime/job, OFF)
    poll latest completed playlist -> item manifest -> authorized article / original
    reporting / press-release text -> source/rights validation -> claim-level evidence
    -> Korean broadcast script -> editorial checks -> TTS chunks -> single audio file
    -> private object storage + manifest -> separate mobile audio player

Do not scrape transcripts when the rights/terms are unclear. YouTube Data API does not grant unrestricted access to third-party video captions. News title/description is metadata for discovery, not a substitute for an article or transcript.

## Interfaces

Input contract for the **planned** audio stage:
- `date`: calendar date in KST (YYYY-MM-DD).
- `playlistId`: existing daily private playlist ID, for provenance and daily idempotency.
- `items[]`: `videoId`, `title`, `category` plus one or more `evidence[]` entries.
- Evidence includes `sourceId`, `publisher`, `url`, `text`, `rights`. Only text the project may actually use should be supplied. Mere source fields do not establish truth.

Implemented today: `validateManifest` / `prepareDraftInput` and `buildDraftRequest` are pure, synchronous functions only. They make no external calls. Validation enforces declared permission and non-empty article text but does **not** verify journalistic truth or legal rights independently.

Planned draft output (not yet implemented):
- Each segment has `itemId`, `script`, `sourceIds[]`, `uncertainties[]`.
- Reject claims without traceable evidence, preserve timing and numerical qualifiers, and never infer missing facts from titles.
- Use the stored original URLs as source links in the eventual audio player; do not reproduce source articles verbatim.

## Reliability: fail closed, fail independently

- Audio runs in a different entry point/runtime; no imports of `api/cron/daily-news.js`, no writes to YouTube, no direct trigger of the existing playlist job.
- `AUDIO_BRIEFING_ENABLED=false` initially; no cron or endpoint exists now. Adding env config by itself is NOT an activation.
- Future job identity: `audio:YYYY-MM-DD:playlistId:scriptVersion:voiceVersion`. Store generated output atomically after success; avoid duplicate charges on retry using persistent job state, not only process memory.
- On source/licensing/accuracy failures: omit affected segment; if insufficient verified content remains, mark audio `not-ready`. **Do not** affect playlist success.
- On OpenAI/TTS/storage rate limits and timeouts: bounded retries with jitter; persist progress; never generate a blank or incorrect audio file.
- On failed TTS chunk: retry just that chunk; publish the completed concatenation only after durations and format are checked.
- Secrets in deployment secret manager only. Store signed/private object access, never public links with embedded tokens.
- No person-voice cloning without consent. Label output as AI-produced audio and preserve attribution.
- Protect any future status/player endpoints with appropriate authentication. Keep script/source logs free of secrets.

## Rollout checklist

Stage A (this branch): docs, pure validator, prompt interface, offline tests. No runtime hook.
Stage B: authorized sample corpus and independently reviewed broadcast style guide; local MP3 experiment, output not published.
Stage C: separate read-only playlist discovery + legal evidence source retrieval + storage; dry run with no TTS and no user-facing publication.
Stage D: independent job + opt-in player, protected, feature flag default-off; track total cost, run time, failures.
Stage E: turn on only after user review; preserve rollback by flipping audio flag off. No shared playlist pipeline edits are required for the initial implementation.

Before any actual launch: check YouTube/news-provider license terms, API budgets, running time, storage retention and access, and the target TTS model's current availability.
