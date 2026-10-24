# AI Audio News Briefing (isolated, not live)

Status: **design scaffold / disabled**. This module is separate from the existing YouTube news playlist. No job, API route, deployment setting, package dependency, or trigger is installed by this commit.

## Existing behavior remains unchanged

- Existing: `api/cron/daily-news.js` -> KBS/JTBC/SBS and weather sources -> OpenAI selection -> private YouTube playlist; schedule remains 08:00 KST.
- Proposed: read the **completed** playlist (read-only), gather legally usable full-text evidence for each selected story, write an independent Korean broadcast script, synthesize an original AI voice, store an audio file, then serve it in a separate player.
- Never write to/delete/reorder YouTube playlists from the new module; never call the current news cron directly.
- Existing `music/`, `api/`, `lib/`, `vercel.json`, `.github/`, root `package.json`, and root UI stay untouched.

## Directory

    audio-briefing/
      README.md                   this overview
      docs/ARCHITECTURE.md        interface, fail-safe design, rollout
      docs/SCRIPT_STYLE.md        evidence-grounded newsroom Korean style
      config.example.json         default-off configuration reference
      src/manifest.mjs            pure validation; NO network/side effects
      src/prompt.mjs              pure prompt builder; NO OpenAI call
      tests/manifest.test.mjs     isolated Node built-in tests
      samples/fictional.json     clearly fictional test fixture

## Phase gates

1. This PR/branch: isolated specification and pure functions only; **no audio is generated**.
2. Opt-in prototype: manually supply authorized article/official-release evidence for 2-3 items; test transcript writing, source citations and audio quality.
3. Separately add a read-only playlist adapter, licensed source retrieval, TTS and durable storage with explicit feature flags. Keep it disabled in production by default.
4. Only after manual acceptance, add an **independent** scheduled job and a separate player. Do not alter the existing playlist cron's 60-second execution path.

Run unit tests without installing dependencies: `node --test audio-briefing/tests/*.test.mjs`.

### Editorial rule

YouTube Data API video title/description alone is NOT evidence for a script. An item with no authorized full-text evidence is skipped, not invented. The current selection code does not download third-party transcripts. Style references must be licensed/permitted. Never clone a real presenter's voice without consent, and label audio as AI-generated.

Implementation details: [architecture](docs/ARCHITECTURE.md), [style rules](docs/SCRIPT_STYLE.md).

**Production status:** no playback UI, no TTS, no storage, no new environment variables loaded, no Cron. The sample file contains fictional test data only.
