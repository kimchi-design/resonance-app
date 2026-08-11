# Resonance

**A music discovery web app that explains *why* two songs sound alike.**

Identify a song from a five-second microphone clip, then get a sonic portrait of
it, three emotional descriptors, and twenty similar tracks — each one labeled
with the specific audio dimension that connects it to the anchor song
("Brighter mood", "More vocal-forward", "Shared drive"), not just a genre tag.

🔗 **Live demo:** https://resonance-app-two.vercel.app/?demo=1
🔗 **Live app (real recognition):** https://resonance-app-two.vercel.app

> The `?demo=1` link is the one to open first — it runs the complete flow with
> deterministic stub data, no microphone permission and no API quota required.
> See [Demo mode](#demo-mode-a-deterministic-test-harness) for why that exists.

---

## Contents

- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [Tech stack](#tech-stack)
- [Key engineering decisions](#key-engineering-decisions)
- [Demo mode: a deterministic test harness](#demo-mode-a-deterministic-test-harness)
- [Testing & accessibility](#testing--accessibility)
- [Architecture](#architecture)
- [Local setup](#local-setup)
- [Deploying](#deploying)
- [Project structure](#project-structure)
- [Current status & known limitations](#current-status--known-limitations)

---

## What it does

1. **Listen** — tap anywhere on the home stage. A 32-bar SVG waveform reacts to
   live microphone input while five seconds of audio are captured.
2. **Identify** — the clip goes to AudD via a server-side proxy and comes back
   as a track identity.
3. **Explain** — the result screen builds a five-trait *Sonic Portrait* from the
   track's audio features and reduces them to three plain-language descriptors.
4. **Recommend** — twenty similar tracks, each with a caption derived from the
   largest normalized difference between its audio features and the anchor's.
5. **Control** — the **Discovery Dial** re-ranks the list live along a
   mainstream ↔ obscure axis, from *Charting* to *Lost*.
6. **Preview & save** — 30-second previews play inline; identified tracks persist
   to a local library that aggregates into a personal taste fingerprint.

Installable as a PWA. Any result can be shared as a deep link that opens
straight to that track's result screen.

---

## Screenshots

<!-- Replace these with real captures. Suggested set:
     1. Home listen stage (idle waveform)
     2. Listening state (mic-driven waveform, topbar hidden)
     3. Result screen (sonic portrait + descriptors + rec cards)
     4. Discovery Dial mid-drag showing a reshuffled list
     5. Library tab with taste fingerprint
-->

| Home | Result | Library |
| --- | --- | --- |
| _screenshot_ | _screenshot_ | _screenshot_ |

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | Vite + vanilla JavaScript, ES modules, no framework |
| Backend | Vercel edge functions (`api/`) as thin, allowlisted proxies |
| Recognition | [AudD](https://audd.io) — server-side key |
| Audio features & recommendations | [ReccoBeats](https://reccobeats.com) — keyless |
| Preview clips | iTunes Search API — keyless |
| Persistence | `localStorage` only — no database, no accounts, no auth |
| Motion | CSS keyframes + Web Animations API — no animation library |
| Hosting | Vercel free tier |

Total runtime dependencies: **zero.** The only `devDependency` is Vite.

---

## Key engineering decisions

**Vanilla JS instead of React.**
The app has four views and one meaningful piece of shared state (the current
track). React would have added a build-time dependency and a mental model
without removing any real complexity at this size. The tradeoff is explicit:
DOM updates are hand-written and targeted — for example, preview playback
mutates only the affected card's button class and progress width rather than
re-rendering a twenty-item list on every `timeupdate` frame. That is faster than
a naive re-render, and it is also the thing that would become a liability at
scale. React is the right call at the next order of magnitude, not this one.

**ReccoBeats instead of the Spotify Web API.**
The original design used Spotify for audio features and recommendations. In
February 2026 Spotify locked `/audio-features` and `/recommendations` for new
applications and began requiring Premium for Development Mode. ReccoBeats
exposes the same field schema (energy, valence, acousticness, tempo,
instrumentalness, liveness) with no key and no account, so the migration was a
service-layer swap rather than a redesign. Streaming hand-off uses plain deep
links instead of an API integration for the same reason — no agreement, no rate
limit, no dependency on a partnership that can be revoked.

**API keys never reach the browser.**
`AUDD_API_KEY` is read by an edge function through `process.env` and is
deliberately *not* prefixed with `VITE_`, which would cause Vite to inline it
into the client bundle. The ReccoBeats proxy exists even though the API is
keyless — it enforces a path allowlist so it cannot be used as an open relay,
and it caches responses to stay inside free-tier limits.

**Never cache `/api/*` in the service worker.**
The service worker uses a versioned cache with cleanup-on-activate, network-first
for navigation, and cache-first for immutable hashed assets — but `/api/*` is
pass-through only. A cached recognition response served for a *different* song
would be silently, confidently wrong. This is the class of bug that is very hard
to reproduce and very easy to prevent.

**The recommendation captions had to stop overclaiming.**
An early version labeled a match "Near-identical feel" whenever four audio axes
(energy, tempo, valence, acousticness) were all close. Live testing surfaced the
failure: a rap track recommended a sung worship track under that label, because
four scalar features are too coarse to distinguish them. Two fixes followed —
the comparison expanded to seven axes (speechiness alone separates those two
cases: ~0.25 vs ~0.04), and the "near-identical" claim was removed entirely in
favor of naming the strongest trait the two tracks genuinely *share*. A label
the product cannot support is worse than a vaguer one that it can.

**A rotating phrase pool, because one honest label repeated twenty times reads as broken.**
Once captions were accurate, a second problem appeared: when the anchor is dark
and the returned neighborhood skews bright, most cards legitimately say
"Brighter mood." Correct, but it looks like a bug. Each axis now has three
semantically equivalent phrasings and a counter threads through the render loop
so repeats rotate. The underlying analysis is unchanged — only its expression
varies.

**`localStorage` instead of a database.**
The project is bootstrapped on free tiers. Accounts and a database would add
cost, an auth surface, and a privacy obligation before there is a single user.
Every write is wrapped in `try`/`catch` with an in-memory mirror so private
browsing and quota-exceeded states degrade instead of throwing.

---

## Demo mode: a deterministic test harness

Appending `?demo=1` to any URL replaces every external dependency with a stub:

| Real path | Demo path |
| --- | --- |
| Microphone + `AudioContext` | Synthetic bass-leaning amplitude generator |
| AudD recognition | Fixed anchor track, resolved after 900 ms |
| ReccoBeats audio features | Engineered features producing a known portrait, 450 ms |
| ReccoBeats recommendations | Fixed twenty-track sample set, 700 ms |
| Library writes | No-ops, so demo runs never pollute real data |

The simulated latencies are deliberate. Loading states, cancellation via
`AbortController`, and the full sequence of intermediate UI states all still
exercise correctly — demo mode reproduces the real flow's *timing behavior*, not
just its final output.

This makes the app testable with no microphone, no API credit, and no network
variability, and it makes bugs reproducible: the same input produces the same
output every run. It is also what makes the live demo link above safe to hand to
someone who will open it on a desktop in a silent room.

---

## Testing & accessibility

Verification performed on the current build:

- **Build integrity** — all source modules transform cleanly; a custom
  import/export resolution pass confirms every cross-module import resolves.
- **Accessibility pass** — status messages announce via `role="status"` /
  `aria-live="polite"`; the AI filter is a real `role="switch"` with keyboard
  activation and `aria-checked` sync; focus moves into each newly shown view;
  recommendation titles are real links rather than nested interactive elements;
  the Discovery Dial implements `role="slider"` with arrow/Home/End keys and an
  `aria-valuetext` that announces its named position.
- **Contrast, computed rather than eyeballed** — measured against the `#0a0a14`
  background: dim text 6.27:1, glow 9.93:1, flavor 5.24:1, warm 9.14:1. The
  solid accent measures 3.52:1, which passes AA-large only — so it is documented
  as background/decoration-only and is never used for small body text.
- **Reduced motion** — every CSS animation carries a `prefers-reduced-motion`
  guard and every Web Animations call checks it in JS.

Detailed test cases, results, and logged defects: **[`TESTING.md`](TESTING.md)**

---

## Architecture

```
mic (5s capture)
  └─→ POST /api/audd ──────────────→ AudD          → track identity + Spotify ID
        ├─→ GET /api/reccobeats ────→ ReccoBeats    → audio features  → Sonic Portrait
        │                                                             → 3 descriptors
        ├─→ GET /api/reccobeats ────→ ReccoBeats    → 20 similar tracks
        │     └─→ per-track features → caption from largest normalized delta
        └─→ GET /api/itunes ────────→ iTunes Search → 30s preview URL (lazy, on tap)
```

Recognition returns a discriminated result — `match` / `no_match` / `quota` /
`network` / `cancelled` — so each failure mode gets its own UX treatment rather
than a generic error. No-match clears itself after 2.5 s; quota and network
errors persist until the next attempt.

Audio features and recommendations load as **asynchronous enhancements** after
the result screen is already visible. The screen never blocks on a third-party
response, and when ReccoBeats has not indexed a track — common for indie and
brand-new releases — placeholders simply remain rather than the view breaking.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/audd` | Recognize a song from `multipart/form-data` audio |
| `GET` | `/api/reccobeats` | Allowlisted ReccoBeats proxy (features, recommendations) |
| `GET` | `/api/itunes` | iTunes Search proxy for preview URLs, 10-minute cache |

---

## Local setup

Requires Node.js 18+.

```sh
git clone https://github.com/REPLACE-ME/resonance-app.git
cd resonance-app
npm install
cp .env.example .env      # then paste your AudD token into .env
```

Three ways to run it, and picking the wrong one is the most common source of
confusion:

```sh
npm run dev               # frontend only — /api/* returns 404, real recognition fails
vercel dev                # full stack — runs the edge functions, reads .env
npm run build && npm run preview   # production build — required to test the PWA
```

Add `?demo=1` to any of them to run without a microphone or API key.

The service worker registers **only in production builds** (`import.meta.env.PROD`).
Registering it under Vite's dev server would cache dev modules and fight hot
module replacement, so PWA installability cannot be tested with `npm run dev`.
That is intentional, not a defect.

---

## Deploying

```sh
npm i -g vercel
vercel login
vercel                    # first run links/creates the project
vercel env add AUDD_API_KEY   # choose Production, Preview, and Development
vercel --prod
```

---

## Project structure

```
resonance-app/
├── api/                        Vercel edge functions (server-side)
│   ├── audd.js                 AudD recognition proxy — holds the key
│   ├── reccobeats.js           ReccoBeats proxy — path allowlist + cache
│   └── itunes.js               iTunes Search proxy — 10-minute cache
├── public/
│   ├── manifest.webmanifest    PWA manifest
│   ├── sw.js                   Service worker — versioned, /api/* never cached
│   └── icon-*.png              App icons (placeholder artwork)
├── src/
│   ├── components/
│   │   ├── waveform.js         32-bar SVG waveform, WAAPI state machine
│   │   ├── audioCapture.js     5s mic capture, log-distributed FFT bands
│   │   ├── discoveryDial.js    Mainstream ↔ obscure slider
│   │   ├── sonicPortrait.js    Five-trait audio-feature visual
│   │   └── navigation.js       View switching + focus management
│   ├── services/
│   │   ├── recognitionService.js   AudD calls, discriminated results
│   │   ├── reccobeatsService.js    Features, recommendations, delta captions
│   │   ├── previewService.js       iTunes lookup + session cache
│   │   ├── audioPreview.js         One shared HTMLAudioElement for all cards
│   │   └── libraryService.js       localStorage history + taste fingerprint
│   ├── utils/
│   │   ├── albumArt.js         Deterministic gradient fallback art
│   │   └── demoMode.js         ?demo=1 flag + abort-aware delay helper
│   ├── styles/main.css         Design tokens + all component styles
│   ├── config.js               Constants + Discovery Dial positions
│   └── main.js                 Orchestrator
├── index.html                  SPA shell — four views
├── vercel.json
└── .env.example
```

---

## Current status & known limitations

This is a working MVP, and the parts that are not finished are deliberate rather
than overlooked:

- **Recommendation quality is ReccoBeats' output, not an original model.** The
  project's actual thesis — that content-based audio embeddings produce better
  "sounds like this" results than behavioral collaborative filtering — requires
  an embedding pipeline (MERT or CLAP into a vector store) that is designed but
  not yet built. What ships today demonstrates the *experience* and the
  *explainability layer*, not a differentiated recommender. Saying otherwise
  would be the same overclaiming problem the caption fix addressed.
- **No AI-generated-track detection.** The filter toggle is wired end to end but
  has nothing real to filter on; classification is a future layer.
- **App icons are placeholders** — generated concentric rings, not a brand mark.
- **No rate limiting on the AudD proxy.** Acceptable for a portfolio deployment,
  not for a public launch. Per-IP limiting or an origin check comes first.
- **Recognition needs network and quota.** The service worker provides
  installability, fast repeat loads, and a graceful offline shell — it cannot
  make a recognition app work offline, and it does not pretend to.

---

## License

No license granted. Portfolio and demonstration use.
