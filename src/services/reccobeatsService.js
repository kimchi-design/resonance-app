/**
 * ReccoBeats service — audio features (P-11) and recommendations (P-12,
 * coming next). Replaces what would have been a Spotify Web API
 * integration; Spotify's audio-features endpoint locked out new apps in
 * Feb 2026, and ReccoBeats is the open, keyless drop-in that exposes the
 * same feature schema (energy, valence, acousticness, tempo,
 * instrumentalness, liveness, etc.).
 *
 * All calls go through the /api/reccobeats Vercel proxy:
 *   - same-origin (sidesteps any CORS surprise)
 *   - 10-minute in-memory cache on warm instances
 *   - allowlisted to the exact endpoints we use
 *
 * Public API:
 *   getAudioFeatures(spotifyId, { signal? }) -> Promise<FeaturesOrNull>
 *   mapFeaturesToPortrait(features)          -> { energy, mood, texture, pace, depth }
 *   generateDescriptors(features)            -> [string, string, string]
 *   getRecommendations(spotifyId, { signal?, size? }) -> Promise<Rec[] | null>
 *   getRecsAudioFeatures(reccoIds, { signal? }) -> Promise<(Features|null)[]>
 *   reasonFromDeltas(anchorFeatures, recFeatures) -> string | null
 *
 * Failures (network, no match, malformed payload, AbortError) all resolve
 * to null from getAudioFeatures. The caller falls back to the neutral
 * placeholders shipped in P-10 — the result screen never breaks, the
 * demo never shows a half-rendered state.
 */

import { API } from '../config.js';
import { fallbackArtClass } from '../utils/albumArt.js';
import { RECOMMENDATIONS, SONIC_REASONS } from '../data/sampleData.js';
import { IS_DEMO, delay } from '../utils/demoMode.js';

/**
 * Resolve a Spotify track ID to its ReccoBeats internal UUID. ReccoBeats'
 * audio-features endpoint requires its own ID, so this is the first half
 * of the two-step lookup.
 */
async function resolveSpotifyId(spotifyId, signal) {
  const url = `${API.reccobeats}?path=/track&ids=${encodeURIComponent(spotifyId)}`;
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    return null;
  }
  if (!response.ok) return null;

  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  // ReccoBeats' /track response wraps matches in a `content` array. Indie /
  // long-tail tracks that aren't in ReccoBeats' index return an empty
  // array — we treat that the same as a hard miss.
  const first = body?.content?.[0];
  return first?.id || null;
}

/**
 * Fetch the audio features object for a ReccoBeats track. Returns the raw
 * features (energy, valence, acousticness, danceability, tempo,
 * instrumentalness, liveness, ...) so downstream pure functions can map
 * however they want.
 *
 * Exported so getRecsAudioFeatures (P-13) can reuse it for per-rec
 * feature fetches without going through the Spotify-ID resolution step —
 * recommended tracks already carry their ReccoBeats UUID in the rec
 * card shape (the `id` field), so per-rec features are a single
 * round-trip apiece.
 */
export async function fetchFeaturesByReccoId(reccoId, signal) {
  const url = `${API.reccobeats}?path=/track/${encodeURIComponent(reccoId)}/audio-features`;
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    return null;
  }
  if (!response.ok) return null;

  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Public entry point. Given a Spotify track ID (from the AudD recognition
 * response), returns the ReccoBeats audio features object — or null if
 * anything went wrong end-to-end. Caller decides what to do with null;
 * for the result screen we leave the P-10 placeholders in place.
 *
 * Pass an AbortSignal to cancel an in-flight request when a new
 * recognition starts.
 */
/** Synthetic feature object engineered so mapFeaturesToPortrait produces
 *  approximately ANCHOR.portrait ({energy:82, mood:34, texture:76,
 *  pace:68, depth:91}) and generateDescriptors produces a vibey demo
 *  combo (Driving / Dark / Cinematic — perfect for M83's Midnight City). */
const DEMO_FEATURES = Object.freeze({
  energy: 0.82,
  valence: 0.34,
  acousticness: 0.24,
  tempo: 155.2,
  instrumentalness: 0.8,
  liveness: 0.37,
  danceability: 0.6,  // unused by current mappers but present in real shape
  speechiness: 0.05,
});

export async function getAudioFeatures(spotifyId, { signal } = {}) {
  // Demo branch — skip ReccoBeats entirely. Shorter delay than recognition
  // since features are a secondary enhancement; the result screen is
  // already up by the time this fires.
  if (IS_DEMO) {
    try {
      await delay(450, signal);
    } catch {
      return null;
    }
    return { ...DEMO_FEATURES };
  }

  if (!spotifyId) return null;

  let reccoId;
  try {
    reccoId = await resolveSpotifyId(spotifyId, signal);
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    return null;
  }
  if (!reccoId) return null;

  try {
    return await fetchFeaturesByReccoId(reccoId, signal);
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    return null;
  }
}

/**
 * Clamp a number into [0, 100] and round. Used for every Sonic Portrait
 * value so the bars never overflow their 80px max-height container.
 */
function clamp100(n) {
  if (!isFinite(n)) return 0;
  return Math.round(Math.max(0, Math.min(100, n)));
}

/**
 * Map raw audio features → the five Sonic Portrait traits. Each trait is
 * an opinionated composite, not a 1:1 of a single ReccoBeats field:
 *
 *   energy  : energy * 100                       — same scale as ReccoBeats
 *   mood    : valence * 100                      — higher = more positive
 *   texture : (1 - acousticness) * 100           — higher = more produced/electronic
 *   pace    : (tempo - 60) / 1.4                 — maps 60-200 BPM onto 0-100
 *   depth   : instrumentalness * 100 + liveness * 30
 *                                                — instrumental + live = "deep" sonic space
 *
 * Each is clamped + rounded so renderSonicPortrait gets clean integers.
 */
export function mapFeaturesToPortrait(features) {
  const energy = Number(features?.energy) || 0;
  const valence = Number(features?.valence) || 0;
  const acousticness = Number(features?.acousticness) || 0;
  const tempo = Number(features?.tempo) || 0;
  const instrumentalness = Number(features?.instrumentalness) || 0;
  const liveness = Number(features?.liveness) || 0;

  return {
    energy: clamp100(energy * 100),
    mood: clamp100(valence * 100),
    texture: clamp100((1 - acousticness) * 100),
    pace: clamp100((tempo - 60) / 1.4),
    depth: clamp100(instrumentalness * 100 + liveness * 30),
  };
}

/**
 * Generate the three-word emotional descriptor strip shown above the
 * Sonic Portrait. Pure function — same inputs always produce the same
 * three words, in the same order.
 *
 * All thresholds operate on raw ReccoBeats values (0–1 for energy /
 * valence / acousticness / instrumentalness, BPM for tempo) — NOT on the
 * mapped portrait percentages. The old prompt's "energy > 65" was a typo
 * for "> 0.65"; using raw thresholds throughout keeps every check
 * internally consistent.
 *
 *   1. Motion    — energy > 0.65 ? "Driving" : "Drifting"
 *   2. Mood      — valence < 0.40 ? "Dark"
 *                  valence > 0.70 ? "Bright"
 *                  else "Wistful"
 *   3. Character — acousticness < 0.3 AND instrumentalness > 0.3 ? "Cinematic"
 *                  acousticness > 0.6 ? "Organic"
 *                  else "Electronic"
 */
export function generateDescriptors(features) {
  const energy = Number(features?.energy) || 0;
  const valence = Number(features?.valence) || 0;
  const acousticness = Number(features?.acousticness) || 0;
  const instrumentalness = Number(features?.instrumentalness) || 0;

  const motion = energy > 0.65 ? 'Driving' : 'Drifting';

  let mood;
  if (valence < 0.40) mood = 'Dark';
  else if (valence > 0.70) mood = 'Bright';
  else mood = 'Wistful';

  let character;
  if (acousticness < 0.3 && instrumentalness > 0.3) character = 'Cinematic';
  else if (acousticness > 0.6) character = 'Organic';
  else character = 'Electronic';

  return [motion, mood, character];
}

// ────────────────────────────────────────────────────────────────────────
// Recommendations (P-12)
// ────────────────────────────────────────────────────────────────────────

/**
 * Threshold below which a track counts as "indie" for the badge. ReccoBeats'
 * popularity is mirrored from Spotify's 0–100 popularity field; in
 * practice anything above ~30 has meaningful streaming presence, while
 * <30 trends toward genuine long-tail / indie / regional releases.
 */
const INDIE_POPULARITY_THRESHOLD = 30;

/**
 * Convert Spotify-style popularity (0–100) into a plausible-looking
 * monthly listener count for the rec card UI. The existing rec rendering
 * displays "X listeners" strings (and the Discovery Dial's re-rank formula
 * reads `listeners`), so we keep that interface and back it with a smooth
 * log curve over popularity. This is an APPROXIMATION — the numbers are
 * directionally correct (more popular = more listeners) but not actual
 * telemetry. Real monthly-listener data would require a Spotify API
 * relationship the bootstrap stage doesn't have.
 *
 * Curve:
 *   popularity   0  →     ~100 listeners
 *   popularity  25  →    ~3.2K
 *   popularity  50  →     ~32K
 *   popularity  75  →    ~3.2M
 *   popularity 100  →     ~32M
 */
function popularityToListeners(popularity) {
  const p = Math.max(0, Math.min(100, Number(popularity) || 0));
  return Math.floor(Math.pow(10, 2 + (p / 100) * 5.5));
}

/**
 * Normalize one ReccoBeats track object into the rec-card shape main.js
 * already renders. Defensive about missing fields — ReccoBeats track
 * shapes vary slightly across endpoints (lookup vs. recommendation), and
 * popularity / image URLs aren't always populated for every track.
 *
 * Output shape (matches a row in the sample RECOMMENDATIONS array, plus
 * a few extras for future use):
 *   {
 *     id,         // ReccoBeats UUID (stable key for re-renders)
 *     t,          // track title
 *     a,          // artist name (first artist if multiple)
 *     art,        // gradient-block class fallback
 *     artUrl,     // real image URL when ReccoBeats provided one
 *     sim,        // similarity proxy derived from rank
 *     listeners,  // popularity-derived approximation
 *     popularity, // raw 0-100 from ReccoBeats (preserved for future re-rankers)
 *     indie,      // popularity < threshold
 *     ai,         // always false; ReccoBeats doesn't classify AI
 *     spotifyUrl, // direct Spotify track URL when present
 *     reason,     // rotating sonic reason; P-13 swaps for delta-computed
 *   }
 */
function normalizeRec(raw, rank) {
  const t = raw?.trackTitle || raw?.title || 'Unknown title';
  const firstArtist = Array.isArray(raw?.artists) ? raw.artists[0] : null;
  const a = firstArtist?.name || raw?.artist || 'Unknown artist';
  const popularity = Math.round(Number(raw?.popularity) || 0);

  // Similarity proxy: ReccoBeats orders by similarity but doesn't expose
  // the score. Use rank-based decay so the existing Discovery Dial
  // re-rank formula (sim * 0.7 + pull * 0.3) keeps working. Top rec
  // ~0.95, last rec ~0.66 across 20 items.
  const sim = Math.max(0.5, 0.95 - rank * 0.015);

  // ReccoBeats' recommendation response sometimes nests Spotify-derived
  // metadata; try common locations before giving up.
  const spotifyUrl =
    raw?.href ||
    raw?.spotify?.external_urls?.spotify ||
    raw?.external_urls?.spotify ||
    null;
  const artUrl =
    raw?.imageUrl ||
    raw?.album?.images?.[0]?.url ||
    raw?.images?.[0]?.url ||
    null;

  return {
    id: raw?.id || `${t}|${a}`,
    t,
    a,
    art: fallbackArtClass(t, a),
    artUrl,
    sim,
    popularity,
    listeners: popularityToListeners(popularity),
    indie: popularity < INDIE_POPULARITY_THRESHOLD,
    ai: false,
    spotifyUrl,
    reason: SONIC_REASONS[rank % SONIC_REASONS.length],
  };
}

/**
 * Fetch real similar-track recommendations for a recognized anchor.
 *
 * ReccoBeats' /track/recommendation endpoint accepts Spotify IDs directly
 * (unlike audio-features, which needs the ReccoBeats UUID), so this is a
 * single round-trip — no Spotify-ID-to-ReccoBeats-ID resolution step.
 *
 * Returns an array of normalized rec objects, or null on any failure.
 * Caller decides what to do with null; main.js shows an empty-state
 * message rather than falling back to sample data (M83-themed sample
 * recs next to a real recognized song would look broken).
 *
 * The Discovery Dial's mainstream↔obscure axis is applied client-side
 * in main.js's renderRecs — not as a server-side filter — because
 * (a) ReccoBeats doesn't expose popularity-tuning parameters, and
 * (b) re-fetching on every dial drag would be laggy and burn the
 * proxy's 10-minute cache.
 */
/** Inverse of popularityToListeners — recover an approximate Spotify-
 *  style popularity (0–100) from a displayed listener count. Used in the
 *  demo recs path to attach a coherent popularity value to sample-data
 *  rows so the Discovery Dial's mainstream↔obscure axis behaves the
 *  same way in demo as it does in real recognition. */
function listenersToPopularity(listeners) {
  const log = Math.log10(Math.max(Number(listeners) || 100, 100));
  return Math.max(0, Math.min(100, Math.round(((log - 2) / 5.5) * 100)));
}

/** Map a single sample RECOMMENDATIONS row into the rec-card shape
 *  getRecommendations returns. Mirrors normalizeRec but for static
 *  sample data — no ReccoBeats-derived fields (id, artUrl, spotifyUrl)
 *  so the rec list uses the gradient-block class fallback and the
 *  search-URL deep-link fallback already wired into renderRecs. */
function normalizeDemoRec(row, rank) {
  return {
    id: `demo:${row.t}|${row.a}`,
    t: row.t,
    a: row.a,
    art: row.art,                    // sample data already has a gradient class
    artUrl: null,                    // no real image — rec card uses .art class
    sim: row.sim,
    popularity: listenersToPopularity(row.listeners),
    listeners: row.listeners,
    indie: row.indie,
    ai: row.ai,
    spotifyUrl: null,                // fall through to search-link path
    reason: SONIC_REASONS[rank % SONIC_REASONS.length],
  };
}

export async function getRecommendations(spotifyId, { signal, size = 20 } = {}) {
  // Demo branch — return sample data shaped exactly like the real return
  // value. Slightly longer simulated delay than features so the
  // "Finding similar tracks…" loading state gets to render (P-12).
  if (IS_DEMO) {
    try {
      await delay(700, signal);
    } catch {
      return null;
    }
    return RECOMMENDATIONS.slice(0, size).map((row, i) => normalizeDemoRec(row, i));
  }

  if (!spotifyId) return null;

  const params = new URLSearchParams({
    path: '/track/recommendation',
    seeds: spotifyId,
    size: String(size),
  });

  let response;
  try {
    response = await fetch(`${API.reccobeats}?${params.toString()}`, { signal });
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    return null;
  }
  if (!response.ok) return null;

  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  // ReccoBeats wraps results in a `content` array. Empty array = the seed
  // had no good neighbours (rare; usually only for very-obscure tracks
  // ReccoBeats indexes the seed of but not its neighbourhood).
  const raw = Array.isArray(body?.content) ? body.content : [];
  if (raw.length === 0) return [];

  return raw.map((r, i) => normalizeRec(r, i));
}

// ────────────────────────────────────────────────────────────────────────
// Per-rec sonic reasons (P-13)
// ────────────────────────────────────────────────────────────────────────

/**
 * Fetch audio features for an array of rec IDs in parallel. Each ID is a
 * ReccoBeats UUID (the `id` field on a normalized rec) — no Spotify-ID
 * resolution step, so each rec is a single round-trip.
 *
 * Returns an array of the same length as `reccoIds`, with each slot
 * either a features object or null (when that specific rec's fetch
 * failed). One bad rec doesn't poison the rest; the caller can compute
 * delta-based reasons for whichever recs got features.
 *
 * Aborts: if `signal` is aborted, the whole batch is treated as
 * cancelled and the resolved array is all-null. The caller's enhancement
 * .then is gated behind its own controller-sentinel check, so a stale
 * batch (from a previous recognition that the user has since interrupted)
 * is also ignored at that layer.
 *
 * Demo branch: returns array of nulls so demo mode keeps the rotating
 * SONIC_REASONS phrases (varied enough for demo quality without needing
 * synthetic per-rec features).
 */
export async function getRecsAudioFeatures(reccoIds, { signal } = {}) {
  if (IS_DEMO) {
    try {
      // Tiny delay so any "thinking" UX still has a moment to breathe;
      // production callers don't need this, but keeping the demo path
      // visually parallel to the real one is worth a few ms.
      await delay(250, signal);
    } catch {
      return reccoIds.map(() => null);
    }
    return reccoIds.map(() => null);
  }

  if (!Array.isArray(reccoIds) || reccoIds.length === 0) return [];

  return Promise.all(
    reccoIds.map(async (id) => {
      if (!id) return null;
      try {
        return await fetchFeaturesByReccoId(id, signal);
      } catch (err) {
        if (err && err.name === 'AbortError') return null;
        return null;
      }
    })
  );
}

/**
 * Phrase pools — three brand-voice variants per axis-direction. When
 * many recs in a single batch end up hitting the same winning axis (e.g.
 * a moody anchor against 8 brighter recs), the variant counter in
 * main.js rotates through these so the user doesn't see "Brighter mood"
 * stamped on every card. All three variants per row mean the same thing;
 * they're written in the same italic-Cormorant register as the rest of
 * the result-screen's sonic-reason copy.
 */
const PHRASE_POOL = {
  energy_up:            ['More intense',       'Heavier hit',        'Stronger surge'],
  energy_down:          ['More restrained',    'Softer touch',       'Quieter pulse'],
  tempo_up:             ['Faster pace',        'Quicker step',       'Brisker cadence'],
  tempo_down:           ['Slower pace',        'Stretched tempo',    'Easier roll'],
  valence_up:           ['Brighter mood',      'Sunnier feel',       'Lifted tone'],
  valence_down:         ['Darker mood',        'Heavier shade',      'Lower sky'],
  acousticness_up:      ['More organic',       'Warmer grain',       'Closer to wood'],
  acousticness_down:    ['More electronic',    'Sleeker surface',    'Cleaner edges'],
  speechiness_up:       ['More vocal-forward', 'Closer to spoken',   'Voice out front'],
  speechiness_down:     ['More melodic',       'More sung',          'Led by melody'],
  instrumentalness_up:  ['More instrumental',  'Mostly textures',    'Fewer words'],
  instrumentalness_down:['More vocal-driven',  'Voice-led',          'Carried by song'],
  danceability_up:      ['More danceable',     'Stronger groove',    'Tighter rhythm'],
  danceability_down:    ['Looser groove',      'Freer rhythm',       'Open pocket'],
};

const SHARED_POOL = {
  drive:      ['Shared drive',      'Same forward push',  'Matched momentum'],
  calm:       ['Shared calm',       'Same quiet weight',  'Mirrored hush'],
  brightness: ['Shared brightness', 'Same lift',          'Matched warmth'],
  melancholy: ['Shared melancholy', 'Same shadow',        'Mirrored ache'],
  warmth:     ['Shared warmth',     'Same earthen tone',  'Same wood-grain'],
  sheen:      ['Shared sheen',      'Same polish',        'Matched gloss'],
  atmosphere: ['Shared atmosphere', 'Same drift',         'Same suspended air'],
  kindred:    ['Kindred sound',     'Quiet kinship',      'Same hand'],
};

/**
 * Pure helper: compute the most descriptive "this rec differs from the
 * anchor in *this* way" reason phrase. Returns a short caption suitable
 * for the .rec-reason slot on a rec card, or null if either side is
 * missing.
 *
 * Strategy: compare SEVEN audio-feature axes. For each, check whether the
 * absolute delta clears that axis's "noteworthy" threshold. The axis
 * whose delta most exceeds its threshold (highest `|delta| / threshold`
 * ratio) wins, and the sign picks the direction (up/down). The PHRASE_POOL
 * then gives one of three same-meaning phrasings — the optional `counters`
 * argument lets the caller distribute variants across a batch so a list
 * of 8 "brighter mood" recs reads as three rotating phrasings instead of
 * "Brighter mood" eight times.
 *
 * Why seven and not four: the original four (energy / tempo / valence /
 * acousticness) are crude — two songs from totally different genres can
 * share near-identical values on all four and sound nothing alike. The
 * worst offender was a rap track recommended against a sung worship song:
 * identical energy/tempo/valence/acousticness, so the old code fell
 * through to "Near-identical feel" — actively claiming high similarity on
 * a bad match. Adding speechiness (rap/spoken vs sung), instrumentalness
 * (vocal vs instrumental), and danceability (groove) gives the comparison
 * real chances to catch a genuine difference. NOTE: this only makes the
 * *label* honest — recommendation QUALITY is still entirely ReccoBeats'
 * output until the content-embedding engine (Stage A) is built.
 *
 * If no axis differs meaningfully, we do NOT claim "near-identical feel"
 * (a few scalar features can't honestly support that). Instead sharedTrait
 * names the strongest characteristic the two tracks actually SHARE —
 * honest about what we can measure rather than overclaiming sameness.
 *
 * Thresholds:
 *   energy 0.15 · tempo 15 BPM · valence 0.15 · acousticness 0.30 ·
 *   speechiness 0.12 · instrumentalness 0.35 · danceability 0.20
 *
 * @param {object} anchor   — anchor track's audio features
 * @param {object} rec      — this rec's audio features
 * @param {object} [counters] — shared state across a batch. If passed, the
 *                              caller (main.js) mutates it through every
 *                              rec so variants distribute. If omitted,
 *                              every call returns variant 0 (fine for
 *                              single-rec lookups and tests).
 */
export function reasonFromDeltas(anchor, rec, counters = null) {
  if (!anchor || !rec) return null;

  const delta = (key) => (Number(rec[key]) || 0) - (Number(anchor[key]) || 0);

  const axes = [
    { kind: 'energy',           d: delta('energy'),           threshold: 0.15 },
    { kind: 'tempo',            d: delta('tempo'),            threshold: 15   },
    { kind: 'valence',          d: delta('valence'),          threshold: 0.15 },
    { kind: 'acousticness',     d: delta('acousticness'),     threshold: 0.30 },
    { kind: 'speechiness',      d: delta('speechiness'),      threshold: 0.12 },
    { kind: 'instrumentalness', d: delta('instrumentalness'), threshold: 0.35 },
    { kind: 'danceability',     d: delta('danceability'),     threshold: 0.20 },
  ];

  // Most distinctive axis = highest "how many thresholds above the floor"
  // ratio. Threshold-normalize so e.g. a 30 BPM tempo gap and a 0.30
  // energy gap (both 2× their threshold) compete fairly.
  const winner = axes
    .filter((a) => Math.abs(a.d) > a.threshold)
    .sort((a, b) => Math.abs(b.d) / b.threshold - Math.abs(a.d) / a.threshold)[0];

  if (winner) {
    const direction = winner.d > 0 ? 'up' : 'down';
    const key = `${winner.kind}_${direction}`;
    return pickVariant(PHRASE_POOL[key], key, counters);
  }

  // Every measured axis is close. Name the most characterful trait the
  // two SHARE rather than overclaiming "near-identical feel".
  const sharedKey = sharedTraitKey(anchor);
  return pickVariant(SHARED_POOL[sharedKey], `shared_${sharedKey}`, counters);
}

/**
 * Pick a variant from a pool. If `counters` is provided (the batch case),
 * the variant index = how many times this key has been used so far in the
 * batch, mod pool length — guaranteeing the first N picks for a given key
 * are all unique. counters is mutated. If no counters, returns variant 0.
 */
function pickVariant(pool, key, counters) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  if (!counters) return pool[0];
  const used = counters[key] || 0;
  counters[key] = used + 1;
  return pool[used % pool.length];
}

/**
 * Pick the key for the most distinctive characteristic the anchor carries
 * (and, since reasonFromDeltas only calls this when every measured axis
 * is close, the rec shares). "Characterful" = furthest from the neutral
 * midpoint, so a very-high-energy or very-acoustic track gets named for
 * that quality. Falls back to "kindred" when nothing stands out — honest
 * about a measured-but-unremarkable closeness.
 */
function sharedTraitKey(anchor) {
  const energy = Number(anchor.energy) || 0;
  const valence = Number(anchor.valence) || 0;
  const acousticness = Number(anchor.acousticness) || 0;
  const instrumentalness = Number(anchor.instrumentalness) || 0;

  const candidates = [
    { score: Math.abs(energy - 0.5),       key: energy > 0.5 ? 'drive' : 'calm' },
    { score: Math.abs(valence - 0.5),      key: valence > 0.5 ? 'brightness' : 'melancholy' },
    { score: Math.abs(acousticness - 0.5), key: acousticness > 0.5 ? 'warmth' : 'sheen' },
    { score: instrumentalness > 0.5 ? instrumentalness - 0.5 : 0, key: 'atmosphere' },
  ];

  const top = candidates.sort((a, b) => b.score - a.score)[0];
  return top && top.score > 0.15 ? top.key : 'kindred';
}
