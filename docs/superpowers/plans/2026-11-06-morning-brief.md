# Morning brief implementation plan

Spec: docs/superpowers/specs/2026-11-05-morning-brief-page-design.md

Executed natively in one session at the user's request ("finish it so it runs tomorrow morning").

1. Rules, RSS parsing and collection: `morning-brief/lib/{rules,rss,collect}.js`, tests in `test/`.
2. AI stages market, select, write, retitle, verify: `lib/{ai,prompts,pipeline}.js`. Tests use a fake `ask`.
3. Storage and access: `api/{ingest,briefing,access}.js`, `lib/{oidc,access}.js`.
4. Page: `public/index.html`, built from `docs/superpowers/mockups/morning-brief-b.html`.
5. Schedule: `.github/workflows/morning-brief.yml` on main; first real run through `workflow_dispatch`.

Verify: `npm test` in `morning-brief/`, a real manual run, then the live page at 360 and 375 px.
