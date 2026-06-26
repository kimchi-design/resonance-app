/**
 * Recognition service — turns a recorded audio Blob into a normalized
 * track object the rest of the app can render.
 *
 * Calls the /api/audd Vercel proxy (which attaches AUDD_API_KEY server-
 * side and forwards to api.audd.io). We never talk to AudD directly from
 * the browser — that would expose the key in the network tab and let
 * anyone burn through the 100-request/day free quota.
 *
 * API:
 *   recognizeSong(audioBlob, { signal? }) -> Promise<RecognitionResult>
 *
 * RecognitionResult is a discriminated union so callers handle each
 * outcome explicitly instead of try/catching a single error type:
 *   { kind: 'match',     track }            - AudD matched the audio
 *   { kind: 'no_match' }                    - AudD ran but found nothing
 *   { kind: 'quota' }                       - AudD's daily quota exceeded
 *   { kind: 'network',   detail }           - transport / proxy / parse failure
 *   { kind: 'cancelled' }                   - fetch aborted via signal
 *
 * Track shape (matches ANCHOR in sampleData.js, plus the optional fields
 * AudD provides):
 *   {
 *     title, artist, album,
 *     spotifyId?,     // Spotify track ID — handed to ReccoBeats in P-11
 *                     // for audio-features enhancement
 *     artUrl?,        // real Spotify cover art when AudD returned one
 *     artClass?,      // gradient-block fallback when no art URL
 *     descriptors,    // neutral defaults; ReccoBeats overwrites when available (P-11)
 *     portrait,       // neutral defaults; ReccoBeats overwrites when available (P-11)
 *     links: { spotify, apple, youtube }   // direct URLs when available
 *   }
 */

import { API } from '../config.js';
import { fallbackArtClass } from '../utils/albumArt.js';
import { IS_DEMO, delay } from '../utils/demoMode.js';
import { ANCHOR } from '../data/sampleData.js';

// AudD error codes that mean "rate limit / quota." 901 is the documented
// "API token limit reached"; 900 is a sibling rate-limit code. Anything
// else falls into the generic 'network' bucket — splitting further can
// wait until a specific code starts mattering in production.
const QUOTA_ERROR_CODES = new Set([900, 901]);

// AudD doesn't return audio-feature data. ReccoBeats does (P-11), so for
// any track ReccoBeats has indexed these values are overwritten by
// mapFeaturesToPortrait / generateDescriptors before the user sees them.
// Tracks ReccoBeats doesn't know — indie / long-tail / very new releases —
// keep these neutral defaults. The result screen never shows a half-
// rendered state; the demo never lies per-track (the defaults aren't
// claimed to be computed from anything song-specific).
//
// Exported so main.js's openHistoricalResult (reopening a Library entry
// that has no cached features) can use the same defaults — single source
// of truth, no drift between live recognition and historical reopen.
export const PLACEHOLDER_DESCRIPTORS = ['Atmospheric', 'Melodic', 'Layered'];
export const PLACEHOLDER_PORTRAIT = {
  energy: 60,
  mood: 55,
  texture: 65,
  pace: 55,
  depth: 65,
};

/** Streaming search URLs, used as fallbacks when AudD didn't give us a
 *  direct track URL for that service. */
function buildSearchLinks(title, artist) {
  const q = encodeURIComponent(title + ' ' + artist);
  return {
    spotify: `https://open.spotify.com/search/${q}`,
    apple: `https://music.apple.com/search?term=${q}`,
    youtube: `https://music.youtube.com/search?q=${q}`,
  };
}

/**
 * Shape AudD's response into the track object renderResult expects.
 * Preference order for each surface:
 *   - title/artist/album: AudD's direct fields (always present on a match)
 *   - links: AudD's direct streaming URLs when present, else search URLs
 *   - album art: AudD's Spotify cover image when present, else gradient
 */
function normalizeMatch(audd) {
  const r = audd.result;
  const title = r.title || 'Unknown title';
  const artist = r.artist || 'Unknown artist';
  const album = r.album || '';

  const search = buildSearchLinks(title, artist);
  const links = {
    // AudD nests Spotify under result.spotify.external_urls.spotify; Apple
    // Music under result.apple_music.url. YouTube isn't returned at all —
    // always a search link.
    spotify: r.spotify?.external_urls?.spotify || search.spotify,
    apple: r.apple_music?.url || search.apple,
    youtube: search.youtube,
  };

  // Spotify returns images sorted largest-first, so [0] is the highest-
  // resolution available — perfect for the 200×200 result hero.
  const artUrl = r.spotify?.album?.images?.[0]?.url || null;
  const artClass = artUrl ? null : fallbackArtClass(title, artist);

  // The Spotify track ID is what ReccoBeats wants in P-11 to look up audio
  // features. Some recognized tracks don't have Spotify metadata attached
  // (rare; usually obscure releases AudD knows about but Spotify doesn't).
  const spotifyId = r.spotify?.id || null;

  return {
    title,
    artist,
    album,
    spotifyId,
    artUrl,
    artClass,
    descriptors: PLACEHOLDER_DESCRIPTORS,
    portrait: PLACEHOLDER_PORTRAIT,
    links,
  };
}

/**
 * Run recognition on a captured audio Blob. See module header for the
 * contract. Pass an AbortSignal in `signal` to support user cancellation
 * (tap a topbar pill / avatar / the home stage mid-recognition).
 */
// Sentinel Spotify ID used in demo mode. The reccobeatsService recognizes
// this and routes audio-features / recommendations to its own demo
// branches instead of calling the real ReccoBeats API.
export const DEMO_SPOTIFY_ID = 'demo-anchor-spotify-id';

/** Demo-mode recognition payload — ANCHOR rebuilt into the
 *  recognitionService output shape, including the sentinel spotifyId
 *  so the downstream enhancement + recommendations chain proceeds. */
function buildDemoMatch() {
  const search = buildSearchLinks(ANCHOR.title, ANCHOR.artist);
  return {
    title: ANCHOR.title,
    artist: ANCHOR.artist,
    album: ANCHOR.album,
    spotifyId: DEMO_SPOTIFY_ID,
    artUrl: null,
    artClass: ANCHOR.artClass,
    // Show placeholders first just like the real path — the demo
    // enhancement in reccobeatsService swaps them for synthetic ANCHOR-
    // shaped values shortly after, preserving the P-11 "fills in" visual.
    descriptors: PLACEHOLDER_DESCRIPTORS,
    portrait: PLACEHOLDER_PORTRAIT,
    links: { spotify: search.spotify, apple: search.apple, youtube: search.youtube },
  };
}

export async function recognizeSong(audioBlob, { signal } = {}) {
  // Demo branch — skip AudD entirely. Simulated round-trip so the
  // "Recognizing…" state still gets to render briefly.
  if (IS_DEMO) {
    try {
      await delay(900, signal);
    } catch {
      return { kind: 'cancelled' };
    }
    return { kind: 'match', track: buildDemoMatch() };
  }

  if (!(audioBlob instanceof Blob)) {
    return { kind: 'network', detail: 'Invalid audio payload' };
  }

  // We deliberately don't send `return` from the client — the /api/audd
  // proxy rebuilds the form server-side with a fixed return-fields list.
  // Anything we attach here besides `file` is dropped on the floor.
  const form = new FormData();
  form.append('file', audioBlob);

  let response;
  try {
    response = await fetch(API.recognize, {
      method: 'POST',
      body: form,
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') return { kind: 'cancelled' };
    return { kind: 'network', detail: String(err && err.message ? err.message : err) };
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    return { kind: 'network', detail: 'Malformed AudD response' };
  }

  // Proxy-level failures (missing key, bad form, upstream 502) come back
  // as non-2xx with a JSON `error` field. Bucket as network — these are
  // configuration / infra problems, not user-facing AudD outcomes.
  if (!response.ok) {
    return {
      kind: 'network',
      detail: body?.error || body?.detail || `HTTP ${response.status}`,
    };
  }

  // AudD returns 200 for both successes and errors; status is in the body.
  if (body?.status === 'error') {
    const code = body?.error?.error_code;
    if (QUOTA_ERROR_CODES.has(code)) return { kind: 'quota' };
    return {
      kind: 'network',
      detail: body?.error?.error_message || `AudD error ${code ?? ''}`.trim(),
    };
  }

  // status: 'success' with a populated result = match.
  // status: 'success' with result: null = ran cleanly, found nothing.
  if (body?.status === 'success' && body.result) {
    return { kind: 'match', track: normalizeMatch(body) };
  }

  return { kind: 'no_match' };
}
