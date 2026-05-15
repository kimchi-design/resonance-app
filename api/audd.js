/**
 * /api/audd  —  AudD song-recognition proxy.
 *
 * The frontend POSTs `multipart/form-data` with a `file` field containing
 * the audio Blob captured from the mic. This function attaches our server-
 * side AUDD_API_KEY and forwards to api.audd.io, then returns the raw JSON.
 *
 * Why a proxy: AUDD_API_KEY is a secret. Calling AudD directly from the
 * browser would expose it in the network tab and let anyone burn through
 * our 100-request/day free quota.
 *
 * Runtime: Vercel Edge. No Node APIs used — only the Web standard FormData,
 * fetch, and Response objects.
 */

export const config = {
  runtime: 'edge',
};

const AUDD_ENDPOINT = 'https://api.audd.io/';

// Which providers we ask AudD to enrich the match with. These show up in the
// JSON response as `result.spotify`, `result.apple_music`, etc., which the
// frontend uses to build deep-link buttons and pull preview URLs.
const AUDD_RETURN_FIELDS = 'spotify,apple_music,timecode';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const apiKey = process.env.AUDD_API_KEY;
  if (!apiKey) {
    return json(
      { error: 'Server not configured', detail: 'AUDD_API_KEY missing' },
      500
    );
  }

  let incoming;
  try {
    incoming = await req.formData();
  } catch (err) {
    return json({ error: 'Expected multipart/form-data body' }, 400);
  }

  const audio = incoming.get('file');
  if (!audio) {
    return json({ error: 'Missing "file" field in form data' }, 400);
  }

  // Rebuild the outgoing form with our secret key + return fields prepended.
  const forwarded = new FormData();
  forwarded.append('api_token', apiKey);
  forwarded.append('return', AUDD_RETURN_FIELDS);
  forwarded.append('file', audio);

  let upstream;
  try {
    upstream = await fetch(AUDD_ENDPOINT, {
      method: 'POST',
      body: forwarded,
    });
  } catch (err) {
    return json({ error: 'Upstream fetch failed', detail: String(err) }, 502);
  }

  // Pass AudD's response through verbatim. The frontend handles status codes
  // (e.g. `status: 'error'` means no match found vs. malformed input).
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
