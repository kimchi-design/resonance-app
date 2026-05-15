/**
 * Resonance — non-secret constants.
 *
 * IMPORTANT: anything imported from this file ends up in the client bundle
 * and is visible in the browser. Real API keys live in env vars consumed
 * server-side by /api/* proxy functions — see .env.example.
 */

// ----- App -----
export const APP_NAME = 'Resonance';
export const APP_VERSION = '0.0.1';

// ----- Audio capture (used in P-09) -----
export const RECORDING_DURATION_MS = 5000; // 5-second mic capture
export const TARGET_SAMPLE_RATE = 44100;
export const WAVEFORM_BAR_COUNT = 32; // breathing waveform on home screen

// ----- API proxy endpoints (P-03 implements; P-10+ consumes) -----
// Frontend always hits these relative paths. The serverless functions behind
// them handle keys/caching/CORS and forward to AudD / ReccoBeats.
//   - recognize:  AudD song recognition (needs AUDD_API_KEY server-side)
//   - reccobeats: ReccoBeats audio features + recommendations (keyless)
//     usage: `${API.reccobeats}?path=/track/recommendation&seeds=<id>&size=20`
export const API = {
  recognize: '/api/audd',
  reccobeats: '/api/reccobeats',
};

// ----- Discovery Dial (used in P-07 and P-13) -----
// Slider value (0–100) maps to one of five named positions.
// Subtitle phrases are intentionally omitted here — P-07 finalizes the voice.
export const DISCOVERY_POSITIONS = [
  { id: 'charting', label: 'Charting', range: [0, 19] },
  { id: 'familiar', label: 'Familiar', range: [20, 39] },
  { id: 'roaming', label: 'Roaming', range: [40, 59] },
  { id: 'adventurous', label: 'Adventurous', range: [60, 84] },
  { id: 'lost', label: 'Lost', range: [85, 100] },
];

export const DEFAULT_DISCOVERY = 50; // Roaming

// ----- Helpers -----
/** Map a 0–100 dial value to its named position object. */
export function getDiscoveryPosition(value) {
  return (
    DISCOVERY_POSITIONS.find(
      (p) => value >= p.range[0] && value <= p.range[1]
    ) || DISCOVERY_POSITIONS[2]
  );
}
