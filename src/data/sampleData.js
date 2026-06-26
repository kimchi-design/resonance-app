/**
 * Sample fixtures used by the prototype UI.
 *
 * Production wiring:
 *   - ANCHOR              → live AudD fingerprint match (P-10 ✓)
 *                           Real recognized tracks come through
 *                           recognitionService.normalizeMatch(). ANCHOR is
 *                           kept as the canonical shape reference and as
 *                           the demo-mode fallback (P-19).
 *   - RECOMMENDATIONS     → ReccoBeats recommendations + audio features (P-11)
 *   - SONIC_REASONS       → per-rec reasons from audio-feature deltas (P-12)
 *   - RECENT / HISTORY_*  → localStorage-backed user history (P-15)
 *
 * Keeping the shapes here lets `?demo=1` mode (P-19) bypass APIs entirely
 * for screen recordings, App Store assets, and offline demos.
 */

export const ANCHOR = {
  title: 'Midnight City',
  artist: 'M83',
  album: "Hurry Up, We're Dreaming",
  artClass: 'art-2',
  // 3 emotional descriptors. Placeholder for P-05 layout — P-11 generates
  // these from real audio features via generateDescriptors().
  descriptors: ['Euphoric', 'Nostalgic', 'Nocturnal'],
  // 5-trait Sonic Portrait values (0–100). Placeholder for P-06 layout;
  // P-11 maps real audio features (energy, valence, acousticness, tempo,
  // instrumentalness) into this same shape.
  portrait: {
    energy: 82,
    mood: 34,
    texture: 76,
    pace: 68,
    depth: 91,
  },
};

export const RECOMMENDATIONS = [
  { t: 'Outro',              a: 'M83',                   art: 'art-2',  sim: 0.96, listeners: 8400000, indie: false, ai: false },
  { t: 'Wait',               a: 'M83',                   art: 'art-2',  sim: 0.94, listeners: 7200000, indie: false, ai: false },
  { t: 'Divinity',           a: 'Porter Robinson',       art: 'art-3',  sim: 0.92, listeners: 2100000, indie: false, ai: false },
  { t: 'Obstacle 1',         a: 'Interpol',              art: 'art-5',  sim: 0.89, listeners: 1400000, indie: false, ai: false },
  { t: 'Neon Signs',         a: 'Luca Fogale',           art: 'art-6',  sim: 0.88, listeners:   68000, indie: true,  ai: false },
  { t: 'Lost in the Light',  a: 'Bahamas',               art: 'art-4',  sim: 0.87, listeners:  780000, indie: false, ai: false },
  { t: 'Nightcall',          a: 'Kavinsky',              art: 'art-7',  sim: 0.86, listeners: 5200000, indie: false, ai: false },
  { t: 'Halogen City',       a: 'Auralights',            art: 'art-8',  sim: 0.85, listeners:    4200, indie: true,  ai: false },
  { t: 'Cascade',            a: 'Syntheticamore',        art: 'art-9',  sim: 0.84, listeners:   12000, indie: true,  ai: true  },
  { t: 'Oblivion',           a: 'Grimes',                art: 'art-10', sim: 0.83, listeners: 3100000, indie: false, ai: false },
  { t: 'Go',                 a: 'The Chemical Brothers', art: 'art-11', sim: 0.82, listeners: 1800000, indie: false, ai: false },
  { t: 'Starwaves',          a: 'Com Truise',            art: 'art-1',  sim: 0.81, listeners:  410000, indie: false, ai: false },
  { t: 'Evening Mountain',   a: 'Nilufer Yanya',         art: 'art-5',  sim: 0.80, listeners: 1200000, indie: false, ai: false },
  { t: 'Parallel Lines',     a: 'Moonbeat Neon',         art: 'art-6',  sim: 0.78, listeners:    1800, indie: true,  ai: true  },
  { t: 'Lay Me Down',        a: 'The Album Leaf',        art: 'art-3',  sim: 0.77, listeners:  220000, indie: false, ai: false },
  { t: 'Transit',            a: 'Tycho',                 art: 'art-10', sim: 0.76, listeners: 1900000, indie: false, ai: false },
  { t: 'Quiet Neighborhood', a: 'Small Sur',             art: 'art-11', sim: 0.75, listeners:   18000, indie: true,  ai: false },
  { t: 'Harbour Lights',     a: 'An Evening',            art: 'art-1',  sim: 0.74, listeners:     900, indie: true,  ai: false },
  { t: 'Synthetic Memories', a: 'Aural Synth Dreams',    art: 'art-9',  sim: 0.73, listeners:    6200, indie: true,  ai: true  },
  { t: 'Lowlands',           a: 'Chromatics',            art: 'art-4',  sim: 0.72, listeners:  690000, indie: false, ai: false },
];

export const RECENT = [
  { t: 'Strawberry Swing', a: 'Coldplay',         art: 'art-3', time: 'Yesterday' },
  { t: 'Bloodflood pt.II', a: 'alt-J',            art: 'art-5', time: 'Yesterday' },
  { t: 'Redbone',          a: 'Childish Gambino', art: 'art-1', time: 'Monday'    },
  { t: 'Sodium',           a: 'Luca Fogale',      art: 'art-6', time: 'Nov 10'    },
  { t: 'Homesick',         a: 'Kings of Leon',    art: 'art-7', time: 'Nov 9'     },
];

export const HISTORY_EXTRA = [
  { t: 'Lilac',      a: 'Porter Robinson', art: 'art-3',  time: 'Nov 8' },
  { t: 'Undersea',   a: 'Tycho',           art: 'art-10', time: 'Nov 6' },
  { t: 'First Love', a: 'Emmit Fenn',      art: 'art-8',  time: 'Nov 4' },
  { t: 'Weightless', a: 'Marconi Union',   art: 'art-6',  time: 'Nov 2' },
];

// Rotating "sonic reason" phrases shown on each rec card under the artist
// name. Indexed by rec position (modulo length) so the first 12 recs each
// get a distinct phrase, then phrases repeat. Placeholder for P-12, which
// will compute per-rec reasons from real audio-feature deltas (e.g. "tempo
// −12 BPM, more acoustic, brighter top end" → "Quieter intensity").
export const SONIC_REASONS = [
  'Same slow exhale',
  'Darker, more fractured',
  'Brighter twin',
  'Matching pulse',
  'Same cathedral reverb',
  'Wider, more open',
  'Colder atmosphere',
  'Tighter, more urgent',
  'Same haze, different angle',
  'Deeper low end',
  'Higher, more fragile',
  'Quieter intensity',
];
