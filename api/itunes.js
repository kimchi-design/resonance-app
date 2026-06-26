/**
 * /api/itunes  —  iTunes Search API proxy.
 *
 * Used by previewService (P-14) to look up 30-second preview URLs for
 * recommendation tracks. iTunes Search is free, keyless, and returns
 * a `previewUrl` field for ~95% of commercial releases.
 *
 * Why proxy a public free API:
 *   1. Caching — iTunes' rate limits aren't strictly documented; an
 *      in-memory cache on the warm edge instance keeps us well under
 *      whatever the ceiling is and makes repeat identifications instant.
 *   2. CORS — iTunes Search does return CORS-friendly headers in practice,
 *      but proxying sidesteps any future header change.
 *   3. Consistency — every third-party call in the app goes through /api/*.
 *
 * Interface (mirrors reccobeats.js): frontend passes a `term` query param
 * that gets appended to the iTunes search call.
 *   /api/itunes?term=<encoded search>
 * forwards to:
 *   https://itunes.apple.com/search?term=<term>&entity=song&limit=1&media=music
 *
 * Runtime: Vercel Edge.
 */

export const config = {
  runtime: 'edge',
};

const ITUNES_BASE = 'https://itunes.apple.com/search';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map();

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(req.url);
  const term = url.searchParams.get('term');
  if (!term) {
    return json({ error: 'Missing "term" query parameter' }, 400);
  }

  // Fixed downstream params — we only want song matches with previews,
  // top result only. Keeping these server-side prevents the client from
  // requesting bulk/expensive variants of the search.
  const upstreamUrl = `${ITUNES_BASE}?term=${encodeURIComponent(term)}&entity=song&limit=1&media=music`;

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
