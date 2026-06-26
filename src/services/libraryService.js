/**
 * Library service — persists recognized tracks to localStorage so the
 * Library tab shows the user's real identification history and a real
 * taste fingerprint, not sample data.
 *
 * Public API:
 *   saveTrack(track)                          — append (or move-to-top if exists)
 *   updateFeaturesFor(spotifyId, features)    — fill in audio features once they arrive
 *   getLibrary()                              — read parsed array, newest first
 *   getStats()                                — { totalCount, uniqueArtists }
 *   getTasteFingerprint()                     — average features → portrait shape, or null
 *   getTopArtists(n)                          — top-n by frequency
 *   clearLibrary()                            — wipe (useful in dev / future settings panel)
 *
 * Storage shape — each entry:
 *   {
 *     title, artist, album,
 *     spotifyId,            // dedup key
 *     artUrl,               // real Spotify image when AudD gave us one
 *     artClass,             // gradient-block class fallback when no artUrl
 *     features,             // null until enhanceWithAudioFeatures fills it in
 *     identifiedAt,         // Date.now() — updated on each re-identification
 *   }
 *
 * Demo mode (?demo=1):
 *   - saveTrack and updateFeaturesFor are no-ops so demo sessions don't
 *     pollute a real user's history.
 *   - getLibrary / getStats / etc. still read from storage normally — a
 *     real user who later flips into demo mode still sees their real
 *     history in the Library tab; demo mode just doesn't write more.
 *
 * Storage robustness:
 *   localStorage can throw in private browsing or when quota-exceeded.
 *   Every read/write wraps a try/catch; on failure we fall through to an
 *   in-memory mirror so the rest of the app keeps working (history just
 *   evaporates on reload).
 */

import { mapFeaturesToPortrait } from './reccobeatsService.js';
import { IS_DEMO } from '../utils/demoMode.js';

const STORAGE_KEY = 'resonance_library';
const MAX_ENTRIES = 200;

// In-memory mirror used when localStorage is unavailable (private mode,
// quota exceeded, etc.). Same shape as the on-disk array.
let inMemoryLibrary = null;

function readRaw() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Private browsing or SecurityError → use the in-memory mirror so
    // saves within this session still stick.
    return inMemoryLibrary || [];
  }
}

function writeRaw(entries) {
  inMemoryLibrary = entries; // keep mirror current either way
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded or storage blocked — silently fall back to the
    // in-memory mirror. The user keeps using the app; their history just
    // doesn't survive a reload.
  }
}

/**
 * Append a recognized track to the library, or — if a track with the same
 * spotifyId is already there — move it to the top with an updated
 * timestamp. Dedup by spotifyId so the Library list doesn't fill up with
 * duplicates when the user re-identifies a song they've seen before.
 *
 * If the existing entry already has features and the incoming track
 * doesn't (it hasn't been enhanced yet), the existing features are
 * preserved — don't downgrade real data to null on re-identification.
 *
 * No-op in demo mode.
 */
export function saveTrack(track) {
  if (IS_DEMO) return;
  if (!track || (!track.spotifyId && !track.title)) return;

  const entries = readRaw();
  const dedupKey = track.spotifyId || `${track.title}|${track.artist}`;

  // Drop any existing entry with the same key (case-insensitive on the
  // fallback composite key so capitalization quirks from AudD don't
  // create phantom duplicates).
  const filtered = entries.filter((e) => {
    const eKey = e.spotifyId || `${e.title}|${e.artist}`;
    return eKey.toLowerCase() !== dedupKey.toLowerCase();
  });
  const previous = entries.find((e) => {
    const eKey = e.spotifyId || `${e.title}|${e.artist}`;
    return eKey.toLowerCase() === dedupKey.toLowerCase();
  });

  const entry = {
    title: track.title || 'Unknown title',
    artist: track.artist || 'Unknown artist',
    album: track.album || '',
    spotifyId: track.spotifyId || null,
    artUrl: track.artUrl || null,
    artClass: track.artClass || null,
    // Preserve previously-fetched features on re-identification — features
    // only arrive when ReccoBeats has the track, and we don't want to lose
    // that signal just because the user re-tapped the same song before
    // enhanceWithAudioFeatures lands.
    features: track.features || previous?.features || null,
    identifiedAt: Date.now(),
  };

  const next = [entry, ...filtered].slice(0, MAX_ENTRIES);
  writeRaw(next);
}

/**
 * Fill in the features field for an existing library entry. Called from
 * main.js's enhanceWithAudioFeatures .then once ReccoBeats responds.
 *
 * Identity-checked: only updates an entry whose spotifyId matches.
 * Guards against the race where the user identifies B before A's
 * features fetch lands — A's stale features would otherwise overwrite
 * the now-most-recent entry (B). With this guard, the stale update
 * either matches a deeper entry (which IS A — correct) or matches
 * nothing (because A has been pushed out by MAX_ENTRIES — also correct).
 *
 * No-op in demo mode.
 */
export function updateFeaturesFor(spotifyId, features) {
  if (IS_DEMO) return;
  if (!spotifyId || !features) return;

  const entries = readRaw();
  let changed = false;
  const next = entries.map((e) => {
    if (e.spotifyId === spotifyId) {
      changed = true;
      return { ...e, features };
    }
    return e;
  });
  if (changed) writeRaw(next);
}

/**
 * Read the library — newest first. Always returns an array.
 */
export function getLibrary() {
  return readRaw();
}

/**
 * Top-line counters for the taste card header.
 */
export function getStats() {
  const entries = readRaw();
  const artists = new Set();
  for (const e of entries) {
    if (e.artist) artists.add(e.artist.trim().toLowerCase());
  }
  return {
    totalCount: entries.length,
    uniqueArtists: artists.size,
  };
}

/**
 * Average the audio features across every library entry that has them,
 * then run that mean through mapFeaturesToPortrait to get the same
 * five-trait shape the result-screen Sonic Portrait uses.
 *
 * Returns null when:
 *   - the library is empty
 *   - no entry has features yet (e.g., everything's still ReccoBeats-miss)
 * Callers (renderLibrary) show a placeholder portrait or empty state
 * in those cases.
 */
export function getTasteFingerprint() {
  const entries = readRaw();
  const withFeatures = entries.filter((e) => e.features);
  if (withFeatures.length === 0) return null;

  const sums = {};
  const counts = {};
  for (const e of withFeatures) {
    for (const key of Object.keys(e.features)) {
      const value = Number(e.features[key]);
      if (!isFinite(value)) continue;
      sums[key] = (sums[key] || 0) + value;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  const mean = {};
  for (const key of Object.keys(sums)) {
    mean[key] = sums[key] / counts[key];
  }
  return mapFeaturesToPortrait(mean);
}

/**
 * Top-n artists by raw identification frequency. Each entry counts once
 * (dedup already happened at save time, so a track identified 5 times is
 * still one entry — what we're really measuring is "distinct songs per
 * artist this user has identified," a reasonable taste signal).
 *
 * Returns array of { name, count } sorted by count desc. Up to `n` items.
 * Empty array if library is empty.
 */
export function getTopArtists(n = 3) {
  const entries = readRaw();
  const counts = new Map();
  for (const e of entries) {
    if (!e.artist) continue;
    const key = e.artist.trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

/** Wipe — used by future settings panel / dev tools. */
export function clearLibrary() {
  if (IS_DEMO) return;
  writeRaw([]);
}
