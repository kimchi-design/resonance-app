/**
 * /api/reccobeats  —  ReccoBeats API proxy.
 *
 * ReccoBeats (https://reccobeats.com) supplies audio features and track
 * recommendations. It's keyless and free, so there's no secret to hide —
 * but we still proxy it for three reasons:
 *   1. CORS — calling api.reccobeats.com directly from the browser may be
 *      blocked; a same-origin proxy sidesteps that entirely.
 *   2. Caching — ReccoBeats' rate limits are unpublished (429 + Retry-After
 *      if exceeded). An in-memory cache on the warm instance keeps us well
 *      under whatever the ceiling is.
 *   3. Consistency — every third-party call in the app goes through /api/*.
 *
 * Interface: the frontend passes the ReccoBeats path as a `path` query param,
 * plus whatever upstream params that endpoint needs. Example:
 *   /api/reccobeats?path=/track/recommendation&seeds=<spotifyId>&size=20
 * forwards to:
 *   https://api.reccobeats.com/v1/track/recommendation?seeds=<spotifyId>&size=20
 *
 * Runtime: Vercel Edge.
 */

export const config = {
  runtime: 'edge',
};

const RECCOBEATS_BASE = 'https://api.reccobeats.com/v1';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// In-memory cache, keyed by full upstream URL. Survives across warm
// invocations on the same edge instance. Cold starts start empty — fine.
const cache = new Map();

/**
 * Allowlist check. The proxy must not be usable as an open relay, so only
 * the ReccoBeats endpoints this app actually needs are permitted:
 *   /track/recommendation              — similar tracks
 *   /track                             — multi-get / resolve Spotify ID
 *   /track/{id}                        — track detail
 *   /track/{id}/audio-features         — audio features for Sonic Portrait
 */
function isAllowedPath(path) {
  if (path === '/track/recommendation') return true;
  if (path === '/track') return true;
  if (/^\/track\/[A-Za-z0-9-]+$/.test(path)) return true;
  if (/^\/track\/[A-Za-z0-9-]+\/audio-features$/.test(path)) return true;
  return false;
}

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  if (!path) {
    return json({ error: 'Missing "path" query parameter' }, 400);
  }
  if (!isAllowedPath(path)) {
    return json({ error: 'Path not allowed', path }, 403);
  }

  // Rebuild the upstream query string from every param except `path`.
  const upstreamParams = new URLSearchParams(url.searchParams);
  upstreamParams.delete('path');
  const qs = upstreamParams.toString();
  const upstreamUrl = `${RECCOBEATS_BASE}${path}${qs ? `?${qs}` : ''}`;

  // Serve from cache when warm and fresh.
  const now = Date.now();
  const hit = cache.get(upstreamUrl);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return new Response(hit.body, {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-cache': 'HIT' },
    });
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    return json({ error: 'Upstream fetch failed', detail: String(err) }, 502);
  }

  const body = await upstream.text();

  // Only cache successful responses — don't memoize a 429 or 404.
  if (upstream.ok) {
    cache.set(upstreamUrl, { body, at: now });
  }

  return new Response(body, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'x-cache': 'MISS' },
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
