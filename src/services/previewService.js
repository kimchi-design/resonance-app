/**
 * Preview service — turns a (title, artist) pair into a 30-second iTunes
 * preview URL, or null when none exists.
 *
 * Calls the /api/itunes Vercel proxy (which adds caching + locks the
 * upstream query to the safest shape: top song result only). Results are
 * also cached in-memory per browser session so repeat plays of the same
 * rec card are instant after the first lookup.
 *
 * Public API:
 *   lookupPreviewUrl(title, artist, { signal? }) -> Promise<string | null>
 *
 * Failures (network, no match, malformed response, abort) all resolve to
 * null. The caller (main.js) treats null as "preview unavailable" and
 * disables the play button for that rec — no error UX, no broken state.
 */

import { API } from '../config.js';

// Per-session in-memory cache. Keyed by "title|artist" — same key used
// for both lookups and result storage. Survives across rec list re-renders
// and Discovery Dial reshuffles; resets on full page reload.
const cache = new Map();

function cacheKey(title, artist) {
  return `${String(title || '').trim().toLowerCase()}|${String(artist || '').trim().toLowerCase()}`;
}

/**
 * Look up the iTunes preview URL for a track. Resolves to a string when
 * iTunes returned a track with a previewUrl, or null when it didn't (no
 * match, no preview field, or a transport failure). The 'null' case is
 * cached too so we don't re-fetch a known-bad track over and over.
 */
export async function lookupPreviewUrl(title, artist, { signal } = {}) {
  if (!title || !artist) return null;

  const key = cacheKey(title, artist);
  if (cache.has(key)) return cache.get(key);

  // iTunes' search term combines title + artist into one space-separated
  // string — they parse word-level matches across all metadata fields.
  // Trimming punctuation that confuses the matcher (parentheses around
  // "(Live)", "(feat. ...)", etc.) gives noticeably better hit rates.
  const term = cleanForSearch(`${title} ${artist}`);
  const url = `${API.itunes}?term=${encodeURIComponent(term)}`;

  let response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (err && err.name === 'AbortError') return null;
    cache.set(key, null);
    return null;
  }

  if (!response.ok) {
    cache.set(key, null);
    return null;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    cache.set(key, null);
    return null;
  }

  const first = Array.isArray(body?.results) ? body.results[0] : null;
  const previewUrl = first?.previewUrl || null;

  cache.set(key, previewUrl);
  return previewUrl;
}

/**
 * Strip parenthetical qualifiers and most punctuation from the search
 * string. iTunes matches better against "Spirit Break Out Kim Walker
 * Smith" than against "Spirit Break Out (Live) Kim Walker-Smith". Keeps
 * letters, numbers, spaces, and ampersands (which iTunes handles fine).
 */
function cleanForSearch(s) {
  return String(s)
    .replace(/\([^)]*\)/g, ' ')    // drop "(Live)", "(feat. X)", etc.
    .replace(/\[[^\]]*\]/g, ' ')   // drop "[Remastered]", etc.
    .replace(/[^A-Za-z0-9& ]+/g, ' ') // collapse other punctuation to spaces
    .replace(/\s+/g, ' ')
    .trim();
}
