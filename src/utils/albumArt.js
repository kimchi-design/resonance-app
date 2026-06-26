/**
 * Album-art helpers shared across recognition and recommendation paths.
 *
 * The app has 11 gradient blocks defined in main.css (.art-1 ... .art-11)
 * that double as the canonical fallback when real cover art isn't
 * available — either because the upstream API didn't return an image URL,
 * or because the track isn't in any image-providing source.
 *
 * Both recognitionService (P-10 — anchor track) and reccobeatsService
 * (P-12 — rec cards) need this fallback, so it lives here as the single
 * source of truth. Same input always returns the same class, so users
 * see consistency on re-renders and repeat identifications.
 */

const ART_CLASS_COUNT = 11;

/**
 * Deterministic gradient-block picker. Hashes `title + artist` to a stable
 * art-N class so the same track always renders the same gradient block,
 * even across sessions and re-renders.
 */
export function fallbackArtClass(title, artist) {
  const seed = String(title || '') + '|' + String(artist || '');
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const n = (Math.abs(hash) % ART_CLASS_COUNT) + 1;
  return `art-${n}`;
}
