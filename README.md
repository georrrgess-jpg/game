# Overround Lab

A sports forecasting and market-analysis studio for classrooms. It shows how forecasts, market
prices, bookmaker margin, uncertainty and new information fit together.
**Simulation points only:** there are no deposits, no sportsbook logins, no wagering, no affiliate
links and no staking advice. "Insufficient evidence" and "no credible difference from the market"
are normal, expected results.

![Today board in the dark studio theme](docs/screenshots/today-dark.png)

---

## 1. Run it

**Requirements:** Node.js **22.13 or newer** (current LTS recommended). Nothing else: no database
server and no native compilation.

```bash
npm install
npm start          # builds the client and server, then serves http://127.0.0.1:5180
```

Open **http://127.0.0.1:5180**. On first start the app generates the fictional demo world
(about 5 seconds, roughly 60 MB in `./data`).

| Command | What it does |
|---|---|
| `npm start` | Build, then serve on 127.0.0.1:5180 |
| `npm run serve` | Serve an existing build (faster restarts) |
| `npm run dev` | API with auto-restart plus Vite hot reload on http://127.0.0.1:5173 |
| `npm test` | Unit, contract and integration tests (Vitest) |
| `npm run test:e2e` | Build, then run end-to-end tests in Chromium (desktop and mobile) |
| `npm run typecheck` | TypeScript check of server, client and tests |

Configuration lives in `.env` (copy `.env.example`). Stop the app with **Ctrl+C**. To start from
scratch, stop the app and delete the `data/` folder. With connected providers the database grows
with each odds refresh; at default settings that is very roughly 1–3 MB per active day, bounded by
the daily credit cap. Forecasts are immutable, so trimming history means starting a new data folder.

---

## 2. Use it

The top bar always shows the mode: **DEMO · FICTIONAL DATA**, **HISTORICAL REPLAY** (with the
frozen information time) or **CONNECTED DATA**. Switch between Demo and Connected there. Choose
**Replay a past moment** to freeze all information at any earlier time.

| Area | What it is for |
|---|---|
| **Today** | **Analyze Today** refreshes connected providers within your caps (demo: recomputes as of the demo clock), records the day's estimates, and shows three separate views: *Most likely outcomes*, *Highest quoted price* for a chosen outcome, and *Model vs market*. Filters cover sport, league, start time, market, quote freshness and data completeness. Every game shows its as-of time, coverage, probability, evidence summary and an uncertainty statement. CSV export and print are available. |
| **Games** | Search by team and open the **game workspace**: raw implied, margin-adjusted market, independent model (with an approximate 80% range), combined estimate, per-book quote table, quote history chart (with a table view), injuries, lineups, conflicts, source-linked news, weather, a five-question plain-language explanation with source IDs, and **what-if** controls kept visibly separate from confirmed facts. |
| **Market Explorer** | Equivalent contracts across books, each book's margin, price movement, and a margin calculator. |
| **Evidence** | News (official / report / speculation, duplicates grouped), injuries, lineups (unknown stays unknown) and conflicting reports. |
| **Classroom Lab** | Students forecast **before** results are known (model and market can be hidden to avoid anchoring), forecasts are immutable and timestamped, results are revealed later and scored with Brier score and log loss against the model and market on the same games. There is a points-only notebook (100 simulation points per experiment), explainers (probability vs confidence, odds and margin, calibration, EV with pushes, a variance simulator) and instructor controls (demo clock, hide results, new session). |
| **Model Report** | Chronological train / validation / holdout splits, Brier and log loss against baselines and the market, paired-bootstrap intervals, calibration charts, the saved forward record (abstentions included) and limitations. |
| **Settings** | Providers (coverage, licensing, health, quotas, connection test), cost caps, scheduler (pause/resume, run now, last and next run, activity log), time zone, freshness and threshold settings, theme, motion, text size and contrast. |

**A typical class with the demo:** the demo clock starts on Tue 16 Jun 2026 at 11:00 in New York.
Students research games and make forecasts in the Lab. The instructor presses *Advance a day*,
students press *Reveal results*, then compare Brier scores with the model and the market. Repeat.
Use *Replay a past moment* to replay any earlier day the same way.

---

## 3. What works without keys

| Feature | Without any key | Needs |
|---|---|---|
| Demo world, Today board, game workspaces, what-ifs, Lab, Report, explainers, exports | ✅ fully offline | — |
| MLB schedules, official results, probable pitchers, posted lineups, injured lists, model history | ✅ enable **MLB Stats API** in Settings | internet |
| Venue weather | ✅ enable **Open-Meteo** | internet |
| News headlines | ✅ enable **News feeds** and list feed URLs | internet |
| Market quotes (any sport The Odds API covers), recent scores for odds-only sports | — | `ODDS_API_KEY` |
| Optional AI-written explanation | — | `ANTHROPIC_API_KEY` and enabled in Settings |

Connected mode **never** fills gaps with demo data. With no providers enabled, the connected
board is empty and says so.

---

## 4. Connecting providers

All providers are **off by default**. Turn them on in **Settings → Providers & coverage**, then press
**Test connection**. Each card shows coverage, history, licensing, cost notes, health, today's usage,
and the sports and books actually observed on your installation.

### MLB Stats API: schedules, results, lineups, injured lists (no key)
- Endpoint `statsapi.mlb.com/api/v1` (teams, schedule with `probablePitcher,lineups,venue` hydration,
  40-man rosters). MLB publishes no formal public documentation. Every response carries an MLB
  Advanced Media copyright notice (gdx.mlb.com/components/copyright.txt) that limits use to
  individual, non-commercial, non-bulk purposes. Check that your use complies.
- Official status mapping: only `Final` / `Completed Early` count as final. `Game Over` waits for the
  official final. Postponed games are void. A make-up keeps the same game ID; forecasts made for the
  original date are void because the start moved more than 12 hours.
- **The model needs two completed seasons before the forecast season.** Analyze Today imports the
  configured history (default: two previous seasons plus the current one, cached for a week).

### The Odds API (v4): market quotes
1. Get a key at the-odds-api.com and put `ODDS_API_KEY=...` in `.env`. Restart.
2. In Settings set the sport keys (e.g. `baseball_mlb`, `icehockey_nhl`, `soccer_epl`), regions,
   markets, and a **daily credit cap** and **minimum remaining credits**. Defaults: `h2h`, `us`, cap 30.
3. Press **Test connection**. It calls `/v4/sports`, which the docs say is free, and lists the active
   sports for your key.

Documented behaviour this adapter relies on (verify against the current docs; plans change):
odds cost = markets × regions credits per request (empty responses free); scores cost 1, or 2 with
`daysFrom` (1–3 days); historical snapshots are paid-plan only, cost 10× and are available from
June 2020. Usage headers `x-requests-remaining / -used / -last` are recorded. Requests are refused
locally before they would exceed your caps. A 401 quota response pauses paid calls until a free
connection test shows credits again.

MLB quotes attach only to official MLB schedule events (matched by team aliases and start time,
which handles doubleheaders), so enable the MLB Stats API too. For other sports, events are created
from the odds feed itself and settled from its scores endpoint.

### Open-Meteo: weather (no key)
Hourly forecast at the venue's coordinates (MLB venues), outdoor venues only. The free tier is for
non-commercial use with documented limits (under 10,000 calls a day). Data is CC BY 4.0 and the app
shows "Weather data by Open-Meteo.com".

### News feeds (RSS/Atom, no key)
Only the https feeds you list are fetched (default: the MLB.com news feed; confirm it still exists).
Each request is restricted to the feed's own host and refused if DNS resolves to a private, loopback
or link-local address. Headlines, links and publication times are stored; full articles are not
copied. Claim type (official / report / speculation) is a labelled keyword heuristic.

### Optional AI explanations (Anthropic API)
Set `ANTHROPIC_API_KEY`, then enable it in Settings and set a daily request cap (default 20). Model
`claude-opus-5-5` by default (`AI_MODEL` overrides). One request is made per click, at low effort,
with server-side fallback enabled. The model receives only computed results and source metadata,
never page bodies or secrets. Its reply is **rejected** if it states a percentage the app did not
compute or cites an unknown source, and the deterministic summary is shown instead. It never
changes a number.

---

## 5. Actual coverage and known limitations

- **"All sportsbooks" is not a coverage claim.** Prices are always the *highest quoted price among
  connected sources as of [time]*. The books seen per sport are listed in Settings after a refresh.
- **Independent model:** MLB and the demo baseball league, 2-way moneyline only. Every other sport
  and market (soccer 1X2, NHL, NBA, spreads, totals) shows the **market reference only**, labelled
  "no independent forecast available". Spreads and totals are shown for comparison by exact line and
  are never modelled.
- **Contracts are never mixed:** soccer `h2h` is treated as 3-way regulation time (draw included).
  US-sport `h2h` is treated as full game including overtime, and `h2h_3_way` as regulation-only.
  Bookmaker rules can differ, so check them if precision matters.
- **Settlement:** postponed, cancelled or rescheduled (start moved more than 12 h) means void. An
  official tie in a 2-way market is void. 3-way markets settle only on a known regulation-time score.
  For the Odds API that means an allow-list of leagues with no extra time at any stage (EPL, La Liga,
  Bundesliga, Serie A, Ligue 1, Primeira Liga). Cups and leagues with play-offs (e.g. MLS) are
  "unsupported", not guessed. Suspended games wait for the official completion.
- **Classroom integrity:** forecasts are accepted only before the start by the information time.
  Replay forecasts on games already played by the real clock are kept but scored on separate rows,
  and they can never earn simulation points.
- **Injuries:** MLB injured-list status only (no day-to-day list). Injuries and lineups are evidence;
  no numeric effect is applied without a validated method, so nothing is double-counted.
- **Live scores** are not modelled. Analysis is pre-game and frozen at the scheduled start once a
  game begins.
- The app does not watch broadcasts or read article text.
- **Not live-verified:** the build environment's network blocked every provider host, so the adapters
  are verified against recorded-format responses only (see §9). The first successful live call on
  your machine is shown on each provider card.

---

## 6. Math and model

**Odds.** American A → decimal d: A > 0 gives d = 1 + A/100; A < 0 gives d = 1 + 100/|A|.
0 and |A| < 100 are rejected, as are malformed or non-finite values. The raw implied probability
is q = 1/d.

**Market reference.** For each book's complete, same-time outcome set: p_i = q_i / Σq (proportional
margin removal, an approximation, not the true probability). Across books, the consensus is the
median of each book's adjusted probability, renormalised. Best prices from different books are
never combined. A quote is *current* if it was re-confirmed within the stale limit (default
150 minutes, set to cover the default 120-minute odds refresh).

**Simulation EV** per 1-point stake: p·d − 1 (= p·(d−1) − (1−p)). The break-even probability is 1/d.
With pushes: p_win·(d−1) − p_loss. A void returns the stake.

**Independent model (`elo-logit-v1`).** Elo team ratings (K, home bonus and between-season carry-over
chosen by grid search) feed a logistic regression on home advantage, rating difference and rest-day
difference. A factor is kept only if it improves validation log loss; in the demo, rest is dropped.
Weights are learned by maximum likelihood on seasons **before** the forecast season only. Ratings
use only games completed before the information time. The 80% range comes from the weights'
covariance (delta method). It reflects parameter uncertainty only and understates total uncertainty.

**Combined estimate:** a logistic blend of model and market fitted on the validation season. It is
labelled as using market odds.

**Model–market verdicts:** a gap is a *research lead* only if (1) the model beat the market **out of
sample** (95% paired-bootstrap interval of the log-loss difference below 0 on at least 200 of this
season's earlier games, with parameters fixed before the season), (2) the market falls outside the
model's 80% range, and (3) the gap is at least 3 points. With fewer holdout games, the validation
season is used, but because the model's settings were chosen on it, the best possible verdict is then
*insufficient evidence*. Otherwise the verdict is *no credible difference*. The board never fills a
quota.

### Evaluation results (fictional demo league; methods are real, data is simulated)

Train 2024 (800 games after a 120-game burn-in), validation 2025 (921 games), final holdout 2026.
Lower is better.

| As of the demo start (16 Jun 2026), holdout n = 382 | Brier | Log loss |
|---|---|---|
| Independent model | 0.2403 | 0.6737 |
| Home-win-rate baseline | 0.2469 | 0.6870 |
| Coin flip | 0.2500 | 0.6931 |
| Market reference (60 min pre-game) | **0.2310** | **0.6541** |
| Combined (uses market) | 0.2328 | 0.6582 |

- Model minus market log loss: +0.020 (95% interval +0.005 to +0.034), so **the model is worse than
  the market**. On validation the gap (+0.006, −0.005 to +0.017) was not significant. Every
  model–market gap on the demo board is therefore labelled *no credible difference*.
- Model minus home-rate baseline: −0.013 (−0.029 to +0.003), so no clear advantage over the
  baseline yet. Over the full simulated 2026 season (n = 921) it is −0.017 (−0.030 to −0.003).
- Hypothetical points (1 point wherever model EV > 0): −18.5 over 350 stakes, a negative result
  reported as is.
- 3-way demo soccer, market only (n = 110): Brier 0.591 vs 0.667 uniform and 0.625 outcome frequency.

This is the intended lesson: the market sees starting pitchers and injuries that the model does
not. With real MLB data you get the same report for your seasons once two are imported. If there is
too little history, the app says so instead of producing a backtest.

---

## 7. Background scheduling

Connected providers can refresh on a schedule (**paused by default**): a daily scan at a local time
(full refresh plus an Analyze Today snapshot), odds every 120 minutes (skipped when no games remain),
results every 120 minutes and news every 240 minutes. Settings shows the last run, last success,
next run, a **Run now** button for each job, and the activity log.

**Scans run only while this program is running.** Closing the terminal or shutting down the
computer stops them, and missed runs are not back-filled (the log notes them at the next start). For
unattended daily scans, keep the process running, for example under a service manager (`systemd`,
`launchd`, Windows Task Scheduler running `npm run serve` at log-on) or `pm2`. Your interactive
Claude Code session is not a background worker for this app.

---

## 8. Security and privacy

- Listens on **127.0.0.1** only. Exposing it on a network requires `HOST=…`, `ALLOW_REMOTE=1` and an
  `INSTRUCTOR_PIN`.
- Host-header allow-list (DNS-rebinding protection), a custom header on every write (CSRF), same-origin
  checks, Content-Security-Policy, `X-Frame-Options: DENY`, 200 KB body limit, and Zod validation on
  every input.
- API keys live only in `.env` on the server. They are never sent to the browser and are redacted
  from logs and stored errors. Exports contain no secrets, and CSV cells are protected against
  spreadsheet-formula injection.
- Outbound requests use https only, per-provider host allow-lists, private-network blocking at DNS
  resolution time, redirect re-checks, timeouts, size limits, retries with backoff (respecting
  `Retry-After`), caching and in-flight de-duplication.
- Fetched text is untrusted data: stored as plain text, rendered escaped, and never treated as
  instructions. Feed links that are not http(s) are dropped.
- Forecasts and experiment entries are **immutable** (database triggers block update and delete).
  Starting a new session archives the old one; nothing is deleted.

---

## 9. What was tested, and what needs live credentials

`npm test`: **97 tests** across 6 files, all passing in the build environment. Covers:
- odds math (positive and negative American odds, ±100, round-trips, malformed and zero quotes,
  3-way margin, EV with and without pushes, half-up rounding),
- settlement (overtime vs regulation, draws, pushes on lines, void, suspended), equivalent-contract
  matching,
- DST days (23 h and 25 h), games crossing local midnight, southern-hemisphere and non-hour offsets,
- stale, incomplete and mismatched-time quotes, after-start exclusion, never mixing books,
- **leakage** (future quotes, injuries, news and results cannot change an analysis; parameters
  never use the forecast season; started games are frozen at start) and deterministic replay,
- provider contract tests against recorded-format responses (Odds API odds, scores and historical;
  MLB teams, schedule with make-up, doubleheader, Game Over, suspended, and roster; Open-Meteo;
  RSS and Atom), quota exhaustion, invalid keys, credit caps, 429/5xx retries, caching and
  de-duplication, partial outages, SSRF and allow-list checks, secret redaction,
- API workflows: Host and CSRF checks, PIN, input validation, Analyze Today snapshots, selected game,
  what-if, immutable forecasts, reveal after the clock advances, instructor hide-results, session
  restart, **restart persistence**, connected mode with no demo substitution, scheduler pause and
  resume and DST next-run times, AI-output validation,
- regression tests for every finding of an independent code review: percent-encoded CSRF paths,
  points entries after the start or in someone else's experiment, replay forecasts on finished
  games, regulation scores leaking while results are hidden, historical snapshots that never went
  stale, out-of-range information times, play-off soccer leagues, the doubleheader matching window,
  postponed originals kept for replay, and venue data surviving history imports.

`npm run test:e2e`: **16 Playwright tests** (desktop 1366×900 and Pixel 7), all passing: Analyze
Today with keyboard tab navigation, game workspace with what-if, the full forecast → advance day →
reveal → score loop, replay and connected labels, every page without horizontal overflow,
skip-link focus, theme and reduced-motion preferences, **a clean browser console** asserted in every
test, and an **axe-core accessibility audit of every page in the dark and light themes with zero
violations** (contrast, heading order, keyboard-reachable scroll regions, labels).

| Integration | Implemented | Fixture-tested | Live-verified |
|---|---|---|---|
| The Odds API v4 (odds, scores, sports, historical) | ✅ | ✅ | ❌ needs `ODDS_API_KEY` and network |
| MLB Stats API | ✅ | ✅ | ❌ network blocked in build environment |
| Open-Meteo | ✅ | ✅ | ❌ network blocked |
| RSS/Atom feeds | ✅ | ✅ | ❌ network blocked; confirm default feed URL |
| Anthropic API explanations | ✅ | output validation tested | ❌ needs `ANTHROPIC_API_KEY` |

Not verified: real browsers other than Chromium, manual screen-reader walkthroughs (automated axe
checks pass; landmarks, labelled controls, tab roles, table headers, live regions and focus
management are in place), and
Windows/macOS launch (the code is cross-platform; tested on Linux with Node 22).

---

## 10. Operating costs (categories only)

- **Odds data:** The Odds API subscription tier and per-request credits (more markets, regions,
  sports or refreshes cost more; historical snapshots cost 10×). Controlled by the daily cap and
  minimum-remaining settings.
- **AI explanations (optional):** per-token API usage for each click, capped per day.
- **Weather and MLB data:** no fee for individual, non-commercial use within their terms and limits.
  Commercial use needs the providers' own agreements.
- **Hosting:** none by default (your computer). An always-on machine or small server if you want
  unattended scheduled scans.

---

## Project layout

```
shared/     odds math, contracts, settlement, scoring and calibration, time zones (used by server and client)
server/     Fastify app, SQLite repo (as-of queries), model, analysis, board, classroom, evaluation,
            scheduler, ingest, providers/ (oddsapi, mlb, openmeteo, rss), demo world generator, AI layer
client/     React app (pages/, components/), styles
tests/      unit/ (Vitest), e2e/ (Playwright), fixtures/ (recorded-format provider responses)
docs/       PLAN.md: stack choice, milestones, design rules
```
