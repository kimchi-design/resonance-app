# Resonance

Music discovery web app. Identifies a song from a five-second mic clip, then
explains *why* it sounds the way it does — a sonic portrait, three emotional
descriptors, and twenty recommendations each tagged with the audio dimensions
that connect them to the anchor track.

Built with Vite + vanilla JavaScript on the frontend, Vercel edge functions on
the backend. No accounts, no database — taste history lives in `localStorage`.

---

## Tech stack

- **Frontend:** Vite + vanilla JS (no framework). Single-page app.
- **Backend:** Vercel edge functions in `api/`. No persistent server.
- **APIs:**
  - **AudD** — song recognition. Free tier, 100 req/day. Needs a key.
  - **ReccoBeats** — audio features + track recommendations. Keyless and free.
  - **iTunes Search API** — 30-second preview clips (added in P-14). Keyless.
  - **MusicBrainz / Cover Art Archive** — fallback album art.
- **Persistence:** `localStorage` only. No database, no auth.

> **Note on Spotify:** the original plan used Spotify's Web API for audio
> features and recommendations. As of the February 2026 API lockdown, those
> endpoints (`/audio-features`, `/recommendations`) are unavailable to new
> apps, and Development Mode now requires the owner to hold Spotify Premium.
> Resonance uses ReccoBeats instead — keyless, free, same feature set. No
> Spotify account is needed anywhere in this project.

---

## Prerequisites

- **Node.js** 18 or later.
- **Vercel account** (free tier) and the [Vercel CLI](https://vercel.com/docs/cli):
  ```sh
  npm i -g vercel
  ```
- **One API key** (free): AudD — sign up at [audd.io](https://audd.io) and copy
  your `api_token`. Free tier is 100 recognitions/day.

That's the whole list. ReccoBeats needs no key or account.

---

## Local setup

```sh
git clone <your-repo-url> resonance-app
cd resonance-app
npm install
cp .env.example .env
```

Open `.env` and paste in your AudD token. **Never commit this file** — it's
gitignored.

```
AUDD_API_KEY=your_audd_token
```

---

## Running locally

There are two dev commands and they do different things.

### `vercel dev` — full stack (recommended)

```sh
vercel dev
```

Runs the Vite frontend **and** the `/api/*` edge functions together on the same
port, reading from `.env`. Use this for anything that touches the AudD or
ReccoBeats proxies. First run links the folder to a Vercel project — say yes
and pick "create new" if you haven't deployed yet.

### `npm run dev` — frontend only

```sh
npm run dev
```

Faster startup, but `/api/*` calls will 404. Use this when working purely on
UI, animation, or layout.

---

## Deploying

First-time deploy:

```sh
vercel login       # one-time
vercel             # from the project root — prompts to link and create the project
```

Set the one environment variable on Vercel:

```sh
vercel env add AUDD_API_KEY
```

When prompted, paste the value and choose **Production, Preview, and
Development** so all environments have access.

Subsequent deploys:

```sh
vercel --prod      # deploy to production
vercel             # deploy a preview build
```

---

## Project structure

```
resonance-app/
├── api/                      # Vercel edge functions (server-side)
│   ├── audd.js               # /api/audd       — AudD recognition proxy (keyed)
│   └── reccobeats.js         # /api/reccobeats — ReccoBeats proxy (keyless, cached)
├── public/                   # Static assets served as-is
├── src/
│   ├── components/           # UI modules (navigation, sonicPortrait, dial, etc.)
│   ├── data/                 # Sample data & fallbacks
│   ├── services/             # Browser-side API clients (P-10+)
│   ├── styles/main.css       # Global styles + design tokens
│   ├── config.js             # Non-secret constants
│   └── main.js               # App entry
├── index.html                # SPA shell
├── vite.config.js
├── vercel.json               # Deploy config (framework: vite)
└── .env.example              # Template for the AudD key — copy to .env
```

---

## API endpoints

The frontend services (P-10 onward) call these same-origin paths. AudD's key
stays server-side; ReccoBeats has no key but is proxied for caching and CORS.

| Method | Path              | Purpose                                                        |
| ------ | ----------------- | -------------------------------------------------------------- |
| POST   | `/api/audd`       | Recognize a song from `multipart/form-data` audio              |
| GET    | `/api/reccobeats` | Proxy to ReccoBeats — pass `?path=/track/...&...` upstream args |

Recognition-to-recommendation data flow:

```
mic → /api/audd → song identity + Spotify ID
                   ├→ /api/reccobeats?path=/track&ids=<spotifyId>      resolve track
                   ├→ /api/reccobeats?path=/track/<id>/audio-features  Sonic Portrait
                   └→ /api/reccobeats?path=/track/recommendation
                        &seeds=<spotifyId>&size=20                     similar tracks
```

---

## Security notes

- `.env` is gitignored. `.env.example` is the committed template.
- `AUDD_API_KEY` is read by the edge function via `process.env` — it never
  reaches the client bundle. The variable name omits the `VITE_` prefix on
  purpose so Vite doesn't inline it.
- The AudD free tier (100/day) has no built-in abuse protection on this proxy.
  Before any real launch, add per-IP rate limiting or an origin check.
- `/api/reccobeats` is an allowlisted proxy — only the specific ReccoBeats
  paths this app uses are permitted, so it can't be abused as an open relay.

---

## Roadmap

Built in phases — see `PROJECT-HANDOFF.md` and the project plan in the parent
folder. Current state:

- **Phase 1 (P-01…P-03):** Vite scaffold, prototype refactor, Vercel proxies — **done**
- **Phase 2 (P-04…P-08):** UI overhaul, Discovery Dial, Sonic Portrait
- **Phase 3 (P-09…P-10):** Real mic capture + AudD recognition
- **Phase 4 (P-11…P-13):** ReccoBeats audio features + recommendations
- **Phase 5 (P-14…P-15):** Preview playback (iTunes Search API) + localStorage library
- **Phase 6 (P-16…P-19):** Polish, PWA, error states, demo mode
```
