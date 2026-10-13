# Build plan and architecture notes

## Choice of stack

A **local web app**: one Node.js process serves both the API and the built React client on
`127.0.0.1`. One command (`npm start`), any modern browser, no native add-ons to compile
(SQLite comes from Node's built-in `node:sqlite`), and it works offline in demo mode.
A desktop wrapper would add signing and packaging work without adding capability.

| Layer | Choice | Why |
|---|---|---|
| Server | Fastify 5, TypeScript, Zod validation | Small, fast, testable with `inject()` |
| Storage | SQLite (`node:sqlite`, WAL) | Zero setup, file-based, triggers make forecasts immutable |
| Client | React 19 + Vite, hand-written CSS and SVG charts | No heavy chart dependency; accessible tables behind every chart |
| Tests | Vitest (unit, contract, integration), Playwright (end-to-end, desktop and mobile) | |

## Milestones (as delivered)

1. Shell, stack, plan: this document plus the app shell with an always-visible mode badge.
2. Offline demo: a deterministic fictional world with two leagues, four books, injuries, lineups,
   news, weather, postponements and doubleheaders, and its own demo clock.
3. Real provider integrations: The Odds API, MLB Stats API, Open-Meteo and RSS, each with
   connection tests, health, quotas and caps. Covered by recorded-response contract tests; not
   live-verified here because the build environment's network blocks these hosts.
4. Daily analysis, selected-game analysis, odds math, evidence links and immutable saved forecasts.
5. Classroom experiments, historical replay and an honest walk-forward evaluation.
6. UI polish, accessibility, end-to-end tests and documentation.

## Key design rules

- Every read used for analysis takes an **information time** (`asOf`). Quotes, injuries,
  lineups, news, weather, results and model fits only count if they were known by then.
  Once a game starts, its analysis is frozen at the scheduled start.
- Quotes are compared only within one **contract** (same event, market type, period rules and
  line). A market reference is built from each book's own complete set, never by mixing books.
- "Current" means re-confirmed by a retrieval within the stale limit. The time the price
  last changed is shown separately.
- Demo data and connected data live in separate datasets and are never mixed.
- Language models never produce numbers. The optional AI text is validated against the
  computed numbers and the cited source IDs.
