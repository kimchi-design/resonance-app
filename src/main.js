import './styles/main.css';
import {
  ANCHOR,
  RECOMMENDATIONS,
  RECENT,
  HISTORY_EXTRA,
  SONIC_REASONS,
} from './data/sampleData.js';
import { showView, initNavigation } from './components/navigation.js';
import {
  initWaveform,
  setWaveformState,
  setBarHeights,
  resumeBars,
} from './components/waveform.js';
import { captureAudio, stopCapture } from './components/audioCapture.js';
import { renderSonicPortrait, updateSonicPortrait } from './components/sonicPortrait.js';
import { initDiscoveryDial } from './components/discoveryDial.js';
import {
  recognizeSong,
  PLACEHOLDER_DESCRIPTORS,
  PLACEHOLDER_PORTRAIT,
} from './services/recognitionService.js';
import {
  getAudioFeatures,
  mapFeaturesToPortrait,
  generateDescriptors,
  getRecommendations,
  getRecsAudioFeatures,
  reasonFromDeltas,
} from './services/reccobeatsService.js';
import { lookupPreviewUrl } from './services/previewService.js';
import * as audioPreview from './services/audioPreview.js';
import * as libraryService from './services/libraryService.js';
import { fallbackArtClass } from './utils/albumArt.js';
import { DEFAULT_DISCOVERY } from './config.js';
import { IS_DEMO } from './utils/demoMode.js';

/* =====================================================================
   Resonance — main entry.
   Wires the sample-data UI together: the home listen flow, result
   rendering, Discovery Dial, and recommendation list. Phase 3+ swaps the
   simulated recognition for real mic capture (P-09) and the AudD /
   ReccoBeats services (P-10+).
   ===================================================================== */

/* ---------- State ---------- */
let hideAi = true;
let discovery = DEFAULT_DISCOVERY;
let isListening = false;
let waveformSvg = null;
let topbarEl = null;
// In-flight recognition controller. Set during the fetch to /api/audd,
// nulled after. cancelListen aborts it so the user can interrupt during
// the "Recognizing…" phase the same way they can during capture.
let recognitionController = null;
// In-flight ReccoBeats audio-features controller. Set after a match,
// nulled when the fetch resolves. A new recognition aborts any previous
// in-flight enhancement so we never apply features from an old track to
// the currently-displayed one.
let featuresController = null;
// In-flight ReccoBeats recommendations controller. Same pattern as
// featuresController — a new recognition aborts the previous fetch so
// stale recs don't land on the currently-displayed result.
let recsController = null;
// In-flight per-rec audio-features controller (P-13). Fires after both
// the anchor features AND the rec list have arrived; aborted by a new
// recognition so reasons computed against an old anchor never land on
// the new track's recs.
let recsFeaturesController = null;
// Snapshot of the current anchor's audio features. Set when
// enhanceWithAudioFeatures resolves with real features; reset to null
// inside renderResult so a fresh recognition doesn't carry over the
// previous anchor's values into per-rec reason computation.
let anchorFeatures = null;
// P-17: the track currently shown on the result screen. Set at the top of
// renderResult; read by the share button to build the ?match= share URL.
let currentTrack = null;
// In-flight iTunes preview lookups, keyed by rec id. So a second tap on
// the same rec while its preview is still being fetched is a no-op
// instead of firing a duplicate fetch. Set on tap, cleared on resolve.
const previewLookups = new Map();
// P-16: rec-card stagger fires only on the FIRST renderRecs paint
// per match. Subsequent re-renders (dial drag, AI toggle, per-rec reason
// enhancement) skip the animation — those reshuffle the list and a
// stagger fade-in on every drag would feel stuttery. Reset to true in
// renderResult so the next match's first paint animates again.
let firstRecsRender = true;
// Pending prompt-reset timer for transient messages (e.g. "No match —
// try again" auto-clears back to the default prompt). Tracked at module
// scope so any state change can cancel it.
let promptResetTimer = null;

// Sample data used as the initial / fallback rec set. Each rec carries
// a rotating "sonic reason" from a fixed pool; rec position determines
// the phrase so a given sample track always carries the same reason
// regardless of how the list is re-sorted by the Discovery Dial. P-13
// swaps the rotating phrases for per-rec reasons computed from real
// audio-feature deltas vs. the anchor track.
const SAMPLE_RECS = RECOMMENDATIONS.map((r, i) => ({
  ...r,
  reason: SONIC_REASONS[i % SONIC_REASONS.length],
}));

// Live rec state for the result screen. Three values are meaningful:
//   null  → loading state (fetch in flight after a real match)
//   []    → empty state (fetch returned no results, or no spotifyId)
//   [...] → populated (sample data at boot, real recs after a match)
// renderRecs reads this and dispatches to the right UI.
let currentRecs = SAMPLE_RECS;

/* ---------- Helpers ---------- */
function formatListeners(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M listeners';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K listeners';
  return n + ' listeners';
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildLinks(title, artist) {
  const q = encodeURIComponent(title + ' ' + artist);
  return {
    spotify: 'https://open.spotify.com/search/' + q,
    apple: 'https://music.apple.com/search?term=' + q,
    youtube: 'https://music.youtube.com/search?q=' + q,
  };
}

/**
 * Paint the three-word descriptor strip above the Sonic Portrait. Shared
 * by renderResult (initial render with whatever descriptors the track
 * arrived with — placeholders, sample data, or already-real) and by the
 * async ReccoBeats enhancement (swap to real descriptors when features
 * resolve).
 *
 * P-16 — `{ initial: true }` marks the spans with `.descriptor--initial`
 * so the CSS stagger fires only on the first paint per match. The
 * features-arrival re-render passes `initial: false` (the default) so
 * the new spans land instantly without re-staggering — otherwise
 * descriptors 2 and 3 would briefly snap to opacity 0 mid-screen while
 * waiting out their CSS animation delays.
 */
function renderDescriptors(values, { initial = false } = {}) {
  const cls = initial ? 'descriptor descriptor--initial' : 'descriptor';
  document.getElementById('resultDescriptors').innerHTML = values
    .map((d) => `<span class="${cls}">${escapeHtml(d)}</span>`)
    .join('');
}

/* ---------- Renderers ---------- */

/**
 * Render the Library tab — taste stats, Sonic Portrait fingerprint, and
 * the full identified-songs list. Reads everything from libraryService.
 *
 * Empty-state behavior:
 *   - Real mode + empty library: stats stay at 0, portrait hidden behind
 *     "Identify songs to build your fingerprint", song list shows
 *     "Your library is empty."
 *   - Demo mode + empty library: falls back to sample data (RECENT +
 *     HISTORY_EXTRA) so the demo doesn't show an empty tab. Sample data
 *     doesn't include features, so the taste portrait still shows the
 *     empty-state message.
 */
function renderLibrary() {
  const entries = libraryService.getLibrary();
  const stats = libraryService.getStats();
  // Demo + empty library: show sample-flavored numbers and ANCHOR's
  // portrait so the demo Library tab looks fully populated (matches the
  // demo-mode philosophy that every visible surface should look polished
  // rather than expose empty real state).
  const showSample = IS_DEMO && entries.length === 0;

  document.getElementById('libCountSongs').textContent = String(
    showSample ? 47 : stats.totalCount
  );
  document.getElementById('libCountArtists').textContent = String(
    showSample ? 12 : stats.uniqueArtists
  );

  // Taste fingerprint: real Sonic Portrait when we have features to
  // average; ANCHOR's portrait in demo+empty so the demo tab still
  // shows the component working; placeholder message in real-mode empty.
  const portrait = libraryService.getTasteFingerprint()
    || (showSample ? ANCHOR.portrait : null);
  const portraitHost = document.getElementById('tastePortrait');
  const portraitEmpty = document.getElementById('tastePortraitEmpty');
  if (portrait) {
    portraitHost.hidden = false;
    portraitEmpty.hidden = true;
    renderSonicPortrait(portraitHost, portrait);
  } else {
    portraitHost.hidden = true;
    portraitEmpty.hidden = false;
  }

  // Song list. In demo mode with an empty library, fall back to sample
  // data so the demo screen looks populated.
  const rows = showSample
    ? [...RECENT, ...HISTORY_EXTRA].map((r) => ({
        title: r.t,
        artist: r.a,
        artClass: r.art,
        artUrl: null,
        spotifyId: null,
        identifiedAt: null,
        _displayTime: r.time, // sample data has pre-formatted relative times
      }))
    : entries;

  const host = document.getElementById('historyList');
  if (rows.length === 0) {
    host.innerHTML = `<div class="library-empty">Your library is empty. Identify a song to start building it.</div>`;
    return;
  }

  host.innerHTML = rows
    .map((r) => {
      const artStyle = r.artUrl
        ? `style="background-image:url(&quot;${escapeAttr(r.artUrl)}&quot;);background-size:cover;background-position:center"`
        : '';
      const artClass = r.artUrl ? 'recent-art' : `recent-art ${r.artClass || 'art-2'}`;
      const time = r._displayTime || formatRelativeTime(r.identifiedAt);
      return `
    <div class="recent-row" data-title="${escapeAttr(r.title)}" data-artist="${escapeAttr(r.artist)}">
      <div class="${artClass}" ${artStyle}></div>
      <div class="recent-info">
        <div class="recent-title">${escapeHtml(r.title)}</div>
        <div class="recent-artist">${escapeHtml(r.artist)}</div>
      </div>
      <div class="recent-time">${escapeHtml(time)}</div>
    </div>
  `;
    })
    .join('');

  // Library-row tap behavior:
  //   - Real library entry (has spotifyId or features) → reopen the
  //     result screen for that track via openHistoricalResult. Uses
  //     cached features when present, re-fetches recs fresh. Back
  //     button returns to the library (data-return-to plumbing in
  //     renderResult / navigation.js).
  //   - Sample-fallback row (demo mode + empty library) → keep the
  //     prior Spotify-search behavior, since we don't have enough data
  //     to reopen a meaningful result for a sample entry (no spotifyId,
  //     no features).
  host.querySelectorAll('.recent-row').forEach((el, i) => {
    const entry = rows[i];
    el.addEventListener('click', () => {
      if (entry && (entry.spotifyId || entry.features)) {
        openHistoricalResult(entry);
      } else {
        const q = encodeURIComponent(`${entry.title} ${entry.artist}`);
        window.open(`https://open.spotify.com/search/${q}`, '_blank');
      }
    });
  });
}

/**
 * Format a timestamp as a brief relative-time string for library rows.
 * Boundary thresholds tuned to the brand voice (quiet, calm): "Just now"
 * is the only super-short label; everything else is calendar-ish.
 */
function formatRelativeTime(ts) {
  if (!ts) return '';
  const now = Date.now();
  const diffMs = now - ts;
  const diffMin = diffMs / 60000;
  const diffHr = diffMin / 60;
  const diffDay = diffHr / 24;

  if (diffMin < 2) return 'Just now';
  if (diffMin < 60) return `${Math.floor(diffMin)}m ago`;
  if (diffHr < 24) return `${Math.floor(diffHr)}h ago`;
  if (diffDay < 2) return 'Yesterday';
  if (diffDay < 7) return `${Math.floor(diffDay)}d ago`;

  // Anything older than a week: short month-day. Year only if not this year.
  const d = new Date(ts);
  const now2 = new Date(now);
  const monthDay = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.getFullYear() === now2.getFullYear()
    ? monthDay
    : `${monthDay}, ${d.getFullYear()}`;
}

function renderRecs() {
  const host = document.getElementById('recList');
  const countEl = document.getElementById('recCount');

  // Loading state — fetch in flight after a real match.
  if (currentRecs === null) {
    countEl.textContent = '';
    host.innerHTML = `<div class="rec-loading">Finding similar tracks…</div>`;
    return;
  }

  // Empty state — fetch returned nothing, or the recognized track had no
  // Spotify ID for us to seed from. Don't fall back to sample data — M83-
  // themed recs next to a real recognized song would look broken.
  if (currentRecs.length === 0) {
    countEl.textContent = '';
    host.innerHTML = `<div class="rec-empty">No similar tracks right now.</div>`;
    return;
  }

  let list = currentRecs.filter((r) => !(hideAi && r.ai));

  // Re-rank by Discovery Dial. Two ideas at work:
  //   1. Direction (obscurity) — at dial=0 we pull mainstream tracks up,
  //      at dial=100 we pull obscure tracks up, blend in between.
  //   2. Intensity (dialEffect) — at the middle (dial≈50) similarity
  //      should dominate (user is saying "I don't care about popularity,
  //      just give me what sounds similar"). At the extremes (0 or 100)
  //      popularity should dominate so the dial visibly reshuffles the
  //      list. Without this ramp, the 0.7-weighted similarity term swamps
  //      the 0.3-weighted pull almost everywhere, and the top of the list
  //      looks frozen no matter where the dial sits — exactly the bug
  //      this formula fixes.
  const obscurity = discovery / 100;
  const dialEffect = Math.abs(discovery - 50) / 50;        // 0 (middle) → 1 (extreme)
  const popWeight = 0.3 + 0.4 * dialEffect;                 // 0.3 → 0.7
  const simWeight = 1 - popWeight;                          // 0.7 → 0.3
  list = list
    .map((r) => {
      const logListeners = Math.log10(Math.max(r.listeners, 100));
      const mainstreamness = Math.min(logListeners / 7, 1); // 0..1
      const pull = (1 - obscurity) * mainstreamness + obscurity * (1 - mainstreamness);
      const score = r.sim * simWeight + pull * popWeight;
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score);

  countEl.textContent = list.length + ' tracks';

  host.innerHTML = list
    .map((r) => {
      // Real album art when ReccoBeats provided a URL; gradient-block
      // fallback otherwise. Same pattern as the result-screen hero in P-10.
      const artStyle = r.artUrl
        ? `style="background-image:url(&quot;${escapeAttr(r.artUrl)}&quot;);background-size:cover;background-position:center"`
        : '';
      const artClass = r.artUrl ? 'rec-art' : `rec-art ${r.art}`;
      // Prefer the direct Spotify URL when ReccoBeats included one;
      // fall back to search URL via the existing buildLinks helper.
      const linkUrl = r.spotifyUrl || buildLinks(r.t, r.a).spotify;
      // P-14: a rec marked previewUnavailable (lookup attempted and
      // iTunes returned no match) gets a disabled play button from the
      // start. Recs that haven't been tapped yet (previewUrl === undefined)
      // get the default enabled button — we discover availability lazily.
      // Native `disabled` attribute on top of the class so screen readers
      // announce it and clicks don't fire (we still want card-body clicks
      // to bubble to the Spotify deep link, which works fine — the button
      // disable doesn't block events on the card).
      const previewDisabled = r.previewUnavailable === true;
      const playClass = previewDisabled ? 'rec-play rec-play--disabled' : 'rec-play';
      const playTitle = previewDisabled ? ' title="Preview unavailable"' : '';
      const playDisabled = previewDisabled ? ' disabled' : '';
      return `
    <div class="rec-card" data-rec-id="${escapeAttr(r.id)}" data-link="${escapeAttr(linkUrl)}">
      <div class="${artClass}" ${artStyle}></div>
      <div class="rec-info">
        <div class="rec-title-text"><a class="rec-open" href="${escapeAttr(linkUrl)}" target="_blank" rel="noopener">${escapeHtml(r.t)}</a></div>
        <div class="rec-artist">${escapeHtml(r.a)}</div>
        <div class="rec-reason">${escapeHtml(r.reason)}</div>
        <div class="rec-meta">
          ${r.indie ? '<span class="chip chip-indie">◆ Indie</span>' : ''}
          ${r.ai ? '<span class="chip chip-ai">⚠ AI</span>' : ''}
          <span class="listeners">${formatListeners(r.listeners)}</span>
        </div>
      </div>
      <button class="${playClass}" aria-label="Preview ${escapeAttr(r.t)}"${playTitle}${playDisabled}>
        <svg class="rec-play-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        <svg class="rec-play-bars" width="14" height="14" viewBox="0 0 14 14">
          <rect class="rec-play-bar rec-play-bar-1" x="2"  y="3" width="1.5" height="8" rx="0.75"/>
          <rect class="rec-play-bar rec-play-bar-2" x="5"  y="3" width="1.5" height="8" rx="0.75"/>
          <rect class="rec-play-bar rec-play-bar-3" x="8"  y="3" width="1.5" height="8" rx="0.75"/>
          <rect class="rec-play-bar rec-play-bar-4" x="11" y="3" width="1.5" height="8" rx="0.75"/>
        </svg>
      </button>
      <div class="rec-progress"><div class="rec-progress-fill"></div></div>
    </div>
  `;
    })
    .join('');

  // Card-body click → open the Spotify deep link in a new tab.
  // Play-button click → toggle inline preview (P-14). The button's
  // stopPropagation prevents the card-body handler from also firing.
  host.querySelectorAll('.rec-card').forEach((cardEl) => {
    const id = cardEl.dataset.recId;
    const rec = currentRecs.find((r) => r.id === id);
    cardEl.addEventListener('click', () => window.open(cardEl.dataset.link, '_blank'));
    // A11y: the title is now a real <a> (keyboard + SR accessible). Stop
    // its click from bubbling to the card handler above — otherwise a
    // click on the title would open the link twice (anchor + card).
    const openLink = cardEl.querySelector('.rec-open');
    if (openLink) openLink.addEventListener('click', (e) => e.stopPropagation());
    const playBtn = cardEl.querySelector('.rec-play');
    if (playBtn) {
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (rec) togglePreview(rec);
      });
    }
  });

  // Apply the current audio state to the freshly-rendered cards (new id
  // active, progress fill, playing border). Without this, a dial drag or
  // hideAi toggle would re-render the list and visually drop the playing
  // indicator until the next timeupdate fires.
  applyAudioStateToCards(audioPreview.getState());

  // P-16: stagger the cards in on the FIRST paint per match that actually
  // produces cards. The flag only flips to false when there are real
  // cards to animate — loading-state and empty-state renders (no
  // .rec-card elements) leave the flag armed so the eventual real paint
  // gets its stagger. Subsequent re-renders WITH cards (dial drag, AI
  // toggle, per-rec reason enhancement) skip the animation — re-staggering
  // every drag would feel stuttery.
  const cards = host.querySelectorAll('.rec-card');
  if (firstRecsRender && cards.length > 0) {
    if (!prefersReducedMotion()) {
      cards.forEach((card, i) => {
        card.animate(
          [
            { opacity: 0, transform: 'translateY(12px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          {
            duration: 380,
            easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
            delay: i * 60,
            fill: 'backwards',
          }
        );
      });
    }
    firstRecsRender = false;
  }
}

/** Single source of truth for the reduced-motion check used by P-16
 *  WAAPI animations. CSS @media queries handle the CSS-side animations
 *  directly; this is for the JS-side WAAPI ones. */
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ---------- Listening flow ----------
   No overlay card (P-05). Tapping the home stage toggles the listening
   state — the waveform intensifies in place, the prompt swaps. Tapping
   again cancels.

   P-09 wired the real 5-second mic capture: audioCapture pipes live
   amplitudes into the waveform via setBarHeights, and resolves with a
   Blob.

   P-10 wired real recognition: after capture the bars resume their
   breathing (mic stream is closed but we're still in the listening 3×
   rate), the prompt swaps to "Recognizing…", and recognizeSong() POSTs
   the blob to /api/audd. The result drives one of four UI outcomes:
   match → result screen; no_match → transient "try again" on home;
   quota → persistent "daily limit reached"; network → persistent
   "connection issue". A user tap mid-recognition aborts the fetch.
*/
function toggleListen() {
  if (isListening) cancelListen();
  else startListen();
}

async function startListen() {
  clearFlashTimer();
  isListening = true;
  setWaveformState(waveformSvg, 'listening');
  document.getElementById('listenPrompt').textContent = 'Listening…';
  // Auto-hide the topbar while listening — full immersion when it matters.
  if (topbarEl) topbarEl.classList.add('topbar--hidden');

  try {
    // Real 5-second mic capture (RECORDING_DURATION_MS in config.js).
    // onAmplitudes runs every animation frame and pipes live mic energy
    // into the waveform — bars react to whatever the room is playing.
    const blob = await captureAudio({
      onAmplitudes: (values) => setBarHeights(waveformSvg, values),
    });
    if (!blob) return; // cancelled via stopCapture

    // Capture done — mic stream is closed, bars are frozen at their last
    // values. Restore the WAAPI breathing so the waveform stays alive
    // through the recognition round-trip. We're still in the 3× listening
    // rate, so the bars come back at full intensity.
    resumeBars(waveformSvg);
    document.getElementById('listenPrompt').textContent = 'Recognizing…';

    recognitionController = new AbortController();
    const result = await recognizeSong(blob, { signal: recognitionController.signal });
    recognitionController = null;

    handleRecognitionResult(result);
  } catch (err) {
    handleCaptureError(err);
  }
}

function handleCaptureError(err) {
  const message =
    err && err.code === 'denied'
      ? 'Microphone access needed — tap to allow'
      : 'Microphone unavailable';
  // Reset listening visuals but leave the error message in place —
  // next tap will overwrite it with "Listening…" via startListen.
  isListening = false;
  if (topbarEl) topbarEl.classList.remove('topbar--hidden');
  resumeBars(waveformSvg);
  setWaveformState(waveformSvg, 'idle');
  document.getElementById('listenPrompt').textContent = message;
}

/**
 * Dispatch on the discriminated result from recognizeSong. Each branch
 * either navigates to the result screen or shows an inline prompt on the
 * home stage (matching the existing capture-error UX pattern).
 *
 * Severity-tiered messaging: no_match auto-clears (recoverable common
 * outcome, user usually retries immediately); quota and network persist
 * until the next tap (they're rarer and signal something the user should
 * be aware of); cancelled is silent (endListen already ran in cancelListen).
 */
function handleRecognitionResult(result) {
  switch (result.kind) {
    case 'match':
      endListen();
      renderResult(result.track);
      // P-15: persist the basic match immediately so the Library tab
      // reflects every successful AudD recognition, even tracks that
      // ReccoBeats doesn't end up indexing (features will stay null on
      // those entries; the taste-fingerprint average just skips them).
      // No-op in demo mode (libraryService handles that internally).
      libraryService.saveTrack(result.track);
      // P-11: async Sonic Portrait + descriptors enhancement.
      enhanceWithAudioFeatures(result.track.spotifyId);
      // P-12: async recommendations. Renders into the "Finding similar
      // tracks…" loading state renderResult just set; replaces with real
      // rec cards (or an empty-state message) when ReccoBeats responds.
      loadRecommendations(result.track.spotifyId);
      return;
    case 'no_match':
      endListen();
      flashPrompt('No match — try again');
      return;
    case 'quota':
      endListen();
      document.getElementById('listenPrompt').textContent =
        'Daily limit reached — try again soon';
      return;
    case 'network':
      endListen();
      document.getElementById('listenPrompt').textContent =
        'Connection issue — try again';
      return;
    case 'cancelled':
      // cancelListen already ran endListen(); nothing more to do.
      return;
  }
}

/**
 * Fire-and-forget ReccoBeats audio-features fetch for a recognized track.
 * Runs after the result screen is already up — when (if) features arrive,
 * the Sonic Portrait and descriptors swap in-place to real values.
 *
 * Uses its own AbortController so a new recognition cancels the previous
 * enhancement. Without that, features for an old track could land on the
 * currently-displayed new track and silently mis-label it.
 *
 * Failure paths (network, no match in ReccoBeats, missing spotifyId, abort)
 * all leave the placeholders from P-10 in place — no error UX, no broken
 * screen, demo always feels complete.
 */
function enhanceWithAudioFeatures(spotifyId) {
  if (featuresController) featuresController.abort();
  if (!spotifyId) {
    featuresController = null;
    return;
  }
  featuresController = new AbortController();
  const controller = featuresController;

  getAudioFeatures(spotifyId, { signal: controller.signal })
    .then((features) => {
      // Bail if this enhancement was superseded by a newer recognition.
      if (controller !== featuresController) return;
      featuresController = null;
      if (!features) return; // ReccoBeats doesn't know this track — keep placeholders

      const portrait = mapFeaturesToPortrait(features);
      const descriptors = generateDescriptors(features);
      // updateSonicPortrait (vs. renderSonicPortrait) retargets the
      // existing bars in place — their CSS height transition smoothly
      // redirects to the new heights even if the initial mount animation
      // is still in flight. No flicker, no snap-to-4px reset.
      updateSonicPortrait(document.getElementById('sonicPortrait'), portrait);
      renderDescriptors(descriptors);
      // P-15: backfill the corresponding library entry with the now-
      // available features. Identity-checked by spotifyId inside the
      // service, so a stale features-fetch resolution after the user
      // has moved on to a different song can't bleed onto the wrong
      // entry.
      libraryService.updateFeaturesFor(spotifyId, features);
      // P-13: stash the anchor features and try to enhance the rec
      // list's sonic reasons. No-op if recs aren't ready yet — the
      // loadRecommendations .then will fire this again when they are.
      anchorFeatures = features;
      maybeEnhanceRecsWithReasons();
    })
    .catch(() => {
      // Silent. getAudioFeatures already swallows AbortError and returns
      // null on transport failures — anything reaching here is a bug in
      // the .then handler itself, which we don't want to crash on.
      if (controller === featuresController) featuresController = null;
    });
}

/**
 * Fire-and-forget ReccoBeats recommendations fetch for a recognized track.
 * Runs after the result screen is already up showing the "Finding similar
 * tracks…" loading state — when (if) recs arrive, currentRecs updates and
 * renderRecs paints real cards in place of the loading message.
 *
 * Mirrors enhanceWithAudioFeatures: own AbortController so a new
 * recognition cancels the previous in-flight fetch (prevents stale recs
 * landing on the currently-displayed result). No spotifyId → straight to
 * empty state (we can't seed ReccoBeats without one). Fetch failure or
 * empty content array → also empty state (showing M83 sample recs next
 * to a real Taylor Swift result would look broken).
 */
function loadRecommendations(spotifyId) {
  if (recsController) recsController.abort();
  if (!spotifyId) {
    recsController = null;
    setCurrentRecs([]);
    return;
  }
  recsController = new AbortController();
  const controller = recsController;

  getRecommendations(spotifyId, { signal: controller.signal })
    .then((recs) => {
      if (controller !== recsController) return;
      recsController = null;
      // recs is array on success (possibly empty), null on failure. Both
      // surface as the empty-state UI; the user's still got a complete
      // result screen with song info, art, portrait, and deep links.
      setCurrentRecs(recs ?? []);
      // P-13: try to enhance the rec list's sonic reasons. No-op if
      // anchor features aren't ready yet — the enhanceWithAudioFeatures
      // .then will fire this again when they are.
      maybeEnhanceRecsWithReasons();
    })
    .catch(() => {
      if (controller === recsController) {
        recsController = null;
        setCurrentRecs([]);
      }
    });
}

/** Update currentRecs and re-paint. Single setter so every state change
 *  flows through one place — easier to extend later (analytics, etc.). */
function setCurrentRecs(recs) {
  currentRecs = recs;
  renderRecs();
}

/**
 * Reopen the result screen for a track the user previously identified.
 * Called from the Library tab when the user taps a row.
 *
 * The flow mirrors live recognition (renderResult → enhance → load recs)
 * but skips work we already have stored:
 *   - features are read from the library entry when present (no
 *     re-fetch from ReccoBeats; same anchorFeatures plumbing as live so
 *     per-rec sonic reasons still compute against this anchor)
 *   - the entry's portrait + descriptors are precomputed from those
 *     cached features so the result screen lands with the *real* values
 *     immediately, no placeholder flash
 *   - if the entry has no cached features (e.g. an older entry, or one
 *     where ReccoBeats didn't index the track at identification time),
 *     we render with placeholders and fire enhanceWithAudioFeatures to
 *     fetch them now
 *   - loadRecommendations always fires so the rec list is fresh — recs
 *     aren't stored in the library, so we can't reuse them
 *
 * Back-button target is set to 'library' after renderResult so tapping
 * back returns the user where they came from instead of home.
 */
function openHistoricalResult(entry) {
  if (!entry) return;

  const hasFeatures = !!(entry.features && typeof entry.features === 'object');
  const track = {
    title: entry.title || 'Unknown title',
    artist: entry.artist || 'Unknown artist',
    album: entry.album || '',
    spotifyId: entry.spotifyId || null,
    artUrl: entry.artUrl || null,
    artClass: entry.artClass || null,
    descriptors: hasFeatures
      ? generateDescriptors(entry.features)
      : PLACEHOLDER_DESCRIPTORS,
    portrait: hasFeatures
      ? mapFeaturesToPortrait(entry.features)
      : PLACEHOLDER_PORTRAIT,
    links: buildLinks(entry.title, entry.artist),
  };

  renderResult(track);

  // After renderResult: override back-target to library (live recognition
  // would have left it at 'home').
  document.getElementById('view-result').dataset.returnTo = 'library';

  if (hasFeatures) {
    // Cache hit — set anchorFeatures directly so the per-rec sonic reason
    // enhancement (which fires from loadRecommendations' .then) can
    // compute deltas against this anchor without an extra round-trip.
    anchorFeatures = entry.features;
  } else if (entry.spotifyId) {
    // No cached features and we have a Spotify ID — fetch them now. This
    // updates the Sonic Portrait and descriptors in place via the same
    // enhanceWithAudioFeatures path live recognition uses.
    enhanceWithAudioFeatures(entry.spotifyId);
  }

  if (entry.spotifyId) {
    loadRecommendations(entry.spotifyId);
  } else {
    // No Spotify ID — can't fetch real recs. Empty state is honest.
    setCurrentRecs([]);
  }
}

/**
 * Coordinator (P-13). Fires whenever either the anchor features or the
 * rec list resolves — whichever resolves second is the one that actually
 * starts the per-rec enhancement, since both inputs are required.
 *
 * Guards against four cases where enhancement is meaningless:
 *   - anchor features failed (track not in ReccoBeats) → rotating phrases stay
 *   - rec list is still loading (null) or empty
 *   - rec list contains zero items with usable ReccoBeats IDs
 *   - already fired for this recognition (recsFeaturesController set)
 * The last guard means this can safely be called from both .then handlers
 * without double-firing.
 */
function maybeEnhanceRecsWithReasons() {
  if (!anchorFeatures) return;
  if (!Array.isArray(currentRecs) || currentRecs.length === 0) return;
  if (recsFeaturesController) return; // already in flight for this match

  enhanceRecsWithReasons(currentRecs, anchorFeatures);
}

/**
 * Fetch audio features for every rec in parallel, compute a per-rec
 * "sonic reason" from the delta vs. the anchor, mutate each rec's
 * `reason` field in place, and re-render the rec list so the new
 * captions appear on the cards.
 *
 * Recs whose features fetch failed (or who have no ReccoBeats ID) keep
 * their rotating-pool reason — partial success is still a win. Pure
 * function reasonFromDeltas does the phrase mapping.
 *
 * Cancellation: standard AbortController pattern. New recognition aborts
 * the in-flight batch via cancelListen; controller-sentinel check
 * inside the .then prevents stale results from overwriting a newer
 * track's reasons.
 */
function enhanceRecsWithReasons(recs, anchor) {
  recsFeaturesController = new AbortController();
  const controller = recsFeaturesController;
  const reccoIds = recs.map((r) => r.id);

  getRecsAudioFeatures(reccoIds, { signal: controller.signal })
    .then((featuresArray) => {
      if (controller !== recsFeaturesController) return;
      recsFeaturesController = null;
      if (!Array.isArray(featuresArray) || featuresArray.length === 0) return;

      let changed = false;
      // Variant counter shared across every rec in this batch. Each call
      // to reasonFromDeltas increments the counter for whatever axis-key
      // it picks, so when many recs hit the same axis (e.g. 8 brighter
      // recs against a dark anchor) they cycle through the three phrase
      // pool variants instead of repeating "Brighter mood" every time.
      const counters = {};
      // Mutate in place so the rec objects keep their identity (other
      // call sites that hold references — none today, but a future
      // analytics hook would — stay consistent).
      for (let i = 0; i < recs.length; i++) {
        const recFeatures = featuresArray[i];
        if (!recFeatures) continue;
        const reason = reasonFromDeltas(anchor, recFeatures, counters);
        if (reason && recs[i].reason !== reason) {
          recs[i].reason = reason;
          changed = true;
        }
      }

      if (changed) renderRecs();
    })
    .catch(() => {
      if (controller === recsFeaturesController) recsFeaturesController = null;
    });
}

/* ---------- Inline preview (P-14) ---------- */
/**
 * Toggle inline preview for a rec card. Three paths:
 *   - This rec is currently playing → pause.
 *   - This rec's preview URL is cached → play immediately.
 *   - This rec's preview URL is unknown → fetch from iTunes lazily; if
 *     found, play; if not, mark rec.previewUnavailable so the button
 *     goes to its disabled state for the rest of the session.
 *
 * The card's preview state lives on the rec object itself (previewUrl /
 * previewUnavailable / previewLoading) so re-renders triggered by the
 * dial or AI toggle preserve it without any extra plumbing.
 */
function togglePreview(rec) {
  if (!rec || rec.previewUnavailable) return;

  const state = audioPreview.getState();

  // Tap the currently-playing card → pause. Tap the currently-loaded
  // (but paused) card → resume from the same position.
  if (state.loadedId === rec.id) {
    if (state.isPlaying) audioPreview.pause();
    else audioPreview.play(rec.id, rec.previewUrl);
    return;
  }

  // A different rec is loaded / nothing is loaded. If we already know
  // this rec's URL, play immediately — switching src auto-pauses any
  // currently-playing track.
  if (rec.previewUrl) {
    audioPreview.play(rec.id, rec.previewUrl);
    return;
  }

  // Don't fire a second lookup if one's already in flight for this rec.
  if (previewLookups.has(rec.id)) return;

  // Lazy iTunes lookup. Show the loading visual immediately so the user
  // gets feedback that something is happening during the ~200-500ms wait.
  rec.previewLoading = true;
  applyAudioStateToCards(audioPreview.getState());

  const controller = new AbortController();
  previewLookups.set(rec.id, controller);
  lookupPreviewUrl(rec.t, rec.a, { signal: controller.signal })
    .then((url) => {
      previewLookups.delete(rec.id);
      rec.previewLoading = false;
      if (url) {
        rec.previewUrl = url;
        audioPreview.play(rec.id, url);
      } else {
        rec.previewUnavailable = true;
      }
      // Re-render so the button picks up its new state (playing / disabled).
      renderRecs();
    })
    .catch(() => {
      previewLookups.delete(rec.id);
      rec.previewLoading = false;
      renderRecs();
    });
}

/**
 * Apply the audio-preview module's state to the currently-rendered rec
 * cards via targeted DOM updates. Called both from the audio
 * subscription (every play/pause/timeupdate) and from renderRecs after
 * a re-render. Targeted — never re-renders the list — so timeupdate at
 * ~4 Hz is cheap.
 */
function applyAudioStateToCards(state) {
  const cards = document.querySelectorAll('.rec-card');
  cards.forEach((card) => {
    const id = card.dataset.recId;
    const isActive = id && id === state.loadedId;
    const playBtn = card.querySelector('.rec-play');
    const fill = card.querySelector('.rec-progress-fill');

    card.classList.toggle('rec-card--playing', isActive);
    if (playBtn) {
      playBtn.classList.toggle('rec-play--playing', isActive && state.isPlaying);
      // The loading class is set independent of the audio state — it
      // reflects an in-flight iTunes lookup. Pull it from rec data.
      const rec = currentRecs?.find?.((r) => r.id === id);
      playBtn.classList.toggle('rec-play--loading', !!rec?.previewLoading);
    }
    if (fill) {
      fill.style.width = isActive ? `${state.progress * 100}%` : '0%';
    }
  });
}

/**
 * Show a message in the listen prompt that auto-resets back to the default
 * after `ms`. Used for transient, recoverable states (no_match) where we
 * want the user to be able to re-tap on the cleared default.
 */
function flashPrompt(message, ms = 2500) {
  clearFlashTimer();
  const el = document.getElementById('listenPrompt');
  el.textContent = message;
  promptResetTimer = setTimeout(() => {
    el.textContent = 'Tap anywhere to identify';
    promptResetTimer = null;
  }, ms);
}

function clearFlashTimer() {
  if (promptResetTimer) {
    clearTimeout(promptResetTimer);
    promptResetTimer = null;
  }
}

function cancelListen() {
  clearFlashTimer();
  // Abort any in-flight recognition fetch. If we're still in the capture
  // phase, recognitionController is null and this is a no-op — stopCapture
  // handles capture-phase cancellation below.
  if (recognitionController) {
    recognitionController.abort();
    recognitionController = null;
  }
  // P-13: also bail on any in-flight per-rec features batch from a prior
  // successful match. User intent here is "stop everything from this
  // listen flow"; leaving the batch running would let stale reasons
  // appear on a result the user has since dismissed.
  if (recsFeaturesController) {
    recsFeaturesController.abort();
    recsFeaturesController = null;
  }
  stopCapture(); // halts the recording; captureAudio's promise resolves with null
  endListen();
}

// Reset the home stage to its idle state. Shared by cancel + match-found
// + every recognition outcome.
function endListen() {
  isListening = false;
  resumeBars(waveformSvg);
  setWaveformState(waveformSvg, 'idle');
  document.getElementById('listenPrompt').textContent = 'Tap anywhere to identify';
  if (topbarEl) topbarEl.classList.remove('topbar--hidden');
}

/* ---------- Result ---------- */
function renderResult(track) {
  // P-17 (library reopen): every renderResult call resets the back-button
  // target to 'home'. openHistoricalResult overrides this to 'library'
  // after renderResult returns, so library-originated reopens send the
  // user back where they came from instead of dumping them on the home
  // screen. Live recognitions keep the default 'home'.
  document.getElementById('view-result').dataset.returnTo = 'home';

  // P-17: remember the displayed track so the share button can build a
  // link back to exactly this result.
  currentTrack = track;

  document.getElementById('resultTitle').textContent = track.title;
  // Some recognized tracks come back with no album (e.g. singles, live
  // recordings AudD couldn't tie to a release). Drop the separator when
  // album is empty so we don't end up rendering "Artist · ".
  const subtitle = track.album ? `${track.artist} · ${track.album}` : track.artist;
  document.getElementById('resultArtist').textContent = subtitle;

  // Album art — real Spotify cover when AudD returned one (P-10),
  // otherwise the gradient block fallback. Reset the other surface's
  // styles so a recognized track with art doesn't keep a stale art-N
  // class from a previous render, and vice versa.
  const artEl = document.getElementById('resultArt');
  if (track.artUrl) {
    artEl.className = 'result-art';
    artEl.style.backgroundImage = `url("${track.artUrl}")`;
    artEl.style.backgroundSize = 'cover';
    artEl.style.backgroundPosition = 'center';
  } else {
    artEl.className = 'result-art ' + (track.artClass || 'art-2');
    artEl.style.backgroundImage = '';
    artEl.style.backgroundSize = '';
    artEl.style.backgroundPosition = '';
  }

  renderDescriptors(track.descriptors, { initial: true });

  // Sonic Portrait rebuilds + re-animates each time a track is shown.
  renderSonicPortrait(document.getElementById('sonicPortrait'), track.portrait);

  // Prefer direct streaming URLs from AudD when the recognition service
  // attached them (P-10). Fall back to search URLs for ANCHOR / sample
  // data and for any service AudD didn't enrich (YouTube is always a
  // search since AudD doesn't return YouTube URLs).
  const links = track.links || buildLinks(track.title, track.artist);
  document.getElementById('linkSpotify').href = links.spotify;
  document.getElementById('linkApple').href = links.apple;
  document.getElementById('linkYoutube').href = links.youtube;

  // P-14: any preview that's still playing from a previous result
  // shouldn't bleed into the new one. Hard-stop the audio so the new
  // result screen starts silent.
  audioPreview.stop();
  // Cancel any in-flight iTunes lookups from the previous result.
  for (const controller of previewLookups.values()) controller.abort();
  previewLookups.clear();

  // P-12: clear recs to the loading state. The match branch in
  // handleRecognitionResult will fire loadRecommendations right after
  // this returns, which paints real cards (or empty state) when the
  // ReccoBeats fetch resolves. Setting null here means the rec section
  // shows "Finding similar tracks…" the instant the result screen
  // appears, instead of stale sample / previous-track recs.
  currentRecs = null;
  // P-13: reset the anchor features cache. If we left it pointing at
  // the previous match's features, the next rec list's reasons could
  // be computed against a stale anchor. Also abort any per-rec
  // features batch left running from the previous match — without
  // this, maybeEnhanceRecsWithReasons' "already in flight" guard
  // would block the new match's enhancement.
  anchorFeatures = null;
  if (recsFeaturesController) {
    recsFeaturesController.abort();
    recsFeaturesController = null;
  }
  // P-16: arm the first-paint stagger for the new match.
  firstRecsRender = true;
  renderRecs();
  showView('result');
}

/* ---------- Share (P-17) ---------- */
/**
 * Build a shareable URL that reopens the recipient straight into the
 * current result. Encodes the Spotify ID (so the recipient's app can
 * fetch the same audio features + recommendations) plus title/artist
 * (so the result header renders immediately, with no metadata lookup —
 * there's no cheap "Spotify ID → title/artist" call under our keyless
 * constraints). Preserves the demo flag so a shared demo link still
 * opens in demo mode.
 */
function buildShareUrl(track) {
  const url = new URL(window.location.origin + window.location.pathname);
  if (track.spotifyId) url.searchParams.set('match', track.spotifyId);
  if (track.title) url.searchParams.set('t', track.title);
  if (track.artist) url.searchParams.set('a', track.artist);
  if (IS_DEMO) url.searchParams.set('demo', '1');
  return url.toString();
}

/**
 * Share the current result. Web Share API where available (mobile —
 * opens the native share sheet), copy-link fallback elsewhere (desktop).
 * Both paths are guarded so a user-cancelled share sheet or a missing
 * clipboard API never throws into the console.
 */
async function shareResult() {
  if (!currentTrack) return;
  const url = buildShareUrl(currentTrack);
  const title = currentTrack.title || 'Resonance';
  const artist = currentTrack.artist || '';
  const shareData = {
    title: 'Resonance',
    text: artist ? `${title} — ${artist} · found on Resonance` : `${title} · found on Resonance`,
    url,
  };

  if (navigator.share) {
    try {
      await navigator.share(shareData);
    } catch {
      // User dismissed the sheet, or share failed — silent, no fallback
      // needed (they chose not to share).
    }
    return;
  }

  // Desktop fallback: copy the link and confirm inline.
  try {
    await navigator.clipboard.writeText(url);
    showShareCopied();
  } catch {
    // Clipboard blocked (insecure context / permissions) — last-ditch
    // prompt so the user can still grab the link manually.
    window.prompt('Copy this link', url);
  }
}

let shareCopiedTimer = null;
/** Brief "Link copied" confirmation under the share button. */
function showShareCopied() {
  const btn = document.getElementById('shareResult');
  if (!btn) return;
  btn.classList.add('share-btn--copied');

  let toast = document.getElementById('shareToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'shareToast';
    toast.className = 'share-toast';
    toast.textContent = 'Link copied';
    document.getElementById('view-result').appendChild(toast);
  }
  // Force a reflow so the transition runs even if the toast was just made.
  void toast.offsetWidth;
  toast.classList.add('share-toast--show');

  if (shareCopiedTimer) clearTimeout(shareCopiedTimer);
  shareCopiedTimer = setTimeout(() => {
    btn.classList.remove('share-btn--copied');
    toast.classList.remove('share-toast--show');
    shareCopiedTimer = null;
  }, 1800);
}

/**
 * Boot handler for a shared `?match=` link. If the URL carries a shared
 * track, build a track object from the params and jump STRAIGHT to the
 * result screen (the whole point of a share link — skip the listen flow).
 *
 * Returns true if it handled a shared match, false otherwise. No caller
 * branches on this today — the home view is the default by virtue of its
 * `active` class in index.html, and renderResult's showView('result')
 * overrides it — but the boolean is the honest signal for any future
 * boot step that needs to know whether the user landed on a share link.
 *
 * Works in demo mode: enhanceWithAudioFeatures / loadRecommendations call
 * the same services that demo mode stubs, so `?demo=1&match=...` resolves
 * synthetic features + recs after the usual simulated delays.
 */
function bootFromSharedMatch() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return false;
  }
  const id = params.get('match');
  const title = params.get('t');
  const artist = params.get('a');

  // Need at least a Spotify ID or a title to have anything to show.
  if (!id && !title) return false;

  // Resolve the display values ONCE and derive everything from them.
  // buildLinks and fallbackArtClass both stringify their inputs, so
  // passing the raw params through would yield a "null null" search URL
  // and an art class keyed on a different seed than the one
  // libraryService stores for the same track.
  const displayTitle = title || 'Shared track';
  const displayArtist = artist || 'Unknown artist';

  const track = {
    title: displayTitle,
    artist: displayArtist,
    album: '',
    spotifyId: id || null,
    artUrl: null,
    artClass: fallbackArtClass(displayTitle, displayArtist),
    descriptors: PLACEHOLDER_DESCRIPTORS,
    portrait: PLACEHOLDER_PORTRAIT,
    links: buildLinks(displayTitle, displayArtist),
  };

  renderResult(track);

  // Strip the share params from the address bar now that they've been
  // consumed. Without this the URL stays pinned to the shared result:
  // tapping back reaches home, but any reload — or the installed PWA
  // relaunching from a start URL captured off a shared link — would
  // bounce the user back into this result forever. replaceState keeps
  // it out of session history so back still behaves. The demo flag is
  // preserved because it governs the whole session, not just this view.
  try {
    window.history.replaceState({}, '', window.location.pathname + (IS_DEMO ? '?demo=1' : ''));
  } catch {
    // Non-fatal — some embedded/sandboxed contexts block replaceState.
  }

  // Persist a shared open into the library too — it's a song the user
  // engaged with. No-op in demo mode (libraryService guards internally).
  libraryService.saveTrack(track);

  if (id) {
    // Pull the real Sonic Portrait + descriptors and similar tracks via
    // the same paths live recognition uses.
    enhanceWithAudioFeatures(id);
    loadRecommendations(id);
  } else {
    // No Spotify ID — can't fetch features or recs. Honest empty rec
    // state; placeholders stay on the portrait/descriptors.
    setCurrentRecs([]);
  }
  return true;
}

/* ---------- Controls ---------- */
function toggleAi() {
  hideAi = !hideAi;
  const el = document.getElementById('aiToggle');
  el.classList.toggle('active', hideAi);
  // A11y: keep the switch's checked state in sync so screen readers
  // announce "on"/"off" as the user toggles it.
  el.setAttribute('aria-checked', String(hideAi));
  renderRecs();
}

/* ---------- Wire-up ---------- */
document.getElementById('listenStage').addEventListener('click', toggleListen);
document.getElementById('aiToggle').addEventListener('click', toggleAi);
// A11y: the toggle is a role=switch div, so it needs keyboard activation
// (Enter/Space) that a native <button> would give for free.
document.getElementById('aiToggle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    toggleAi();
  }
});
// P-17: share the current result (Web Share API / copy-link fallback).
document.getElementById('shareResult')?.addEventListener('click', shareResult);

/* ---------- Boot ---------- */
waveformSvg = initWaveform(document.getElementById('waveform'));
topbarEl = document.querySelector('.topbar');
initNavigation();

// Leaving the current view mid-listen cancels the in-progress
// identification (defence-in-depth — the topbar also auto-hides during
// listening, but if the user manages to tap a pill or the avatar in the
// transition window, we don't want a stale timer firing later).
document
  .querySelectorAll('.pill-option')
  .forEach((btn) => btn.addEventListener('click', cancelListen));
document.getElementById('profileButton')?.addEventListener('click', cancelListen);

// P-15: refresh the library every time the user opens it. Without this,
// stats and the song list would only reflect what was in storage at boot
// — every recognition in the current session would be invisible until a
// page reload.
document.querySelectorAll('.pill-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === 'explore') renderLibrary();
  });
});

initDiscoveryDial(document.getElementById('discoveryDial'), {
  value: discovery,
  onChange: (v) => {
    discovery = v;
    renderRecs();
  },
});

renderLibrary();
renderRecs();

// P-14: subscribe to the shared audio preview state so any play/pause/
// timeupdate event updates the affected rec card's visuals (button,
// progress fill, playing border) via targeted DOM mutations — no full
// renderRecs on every timeupdate frame.
audioPreview.subscribe((state) => applyAudioStateToCards(state));

// Surface demo mode in the console so devs / friends with DevTools open
// can tell at a glance. No visual badge — keeps screen recordings clean.
if (IS_DEMO) {
  // eslint-disable-next-line no-console
  console.log(
    '%c[Resonance] DEMO MODE',
    'background:#6258c8;color:#fff;padding:2px 8px;border-radius:4px;font-weight:600',
    '— recognition and recommendations are served from sample data; no API calls.'
  );
}

// P-17: a shared `?match=` link opens straight into the result for that
// track, skipping the home listen flow. Runs after the normal boot wiring
// so renderResult has everything (dial, audio subscription) ready.
bootFromSharedMatch();

// P-17: register the service worker for installability + fast repeat
// loads. PROD-only — registering under Vite's dev server would cache dev
// modules and fight HMR. The SW lives at the site root (public/sw.js →
// served at /sw.js) so its scope covers the whole app. Failures are
// non-fatal: the app works fine without it.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // The SW calls skipWaiting() + clients.claim(), so a newly deployed
    // version takes control of THIS page while it's still running the
    // previously-cached bundle. Refresh once when that happens so the
    // page and its service worker are the same version.
    //
    // Read the controller BEFORE registering: on a first-ever install
    // clients.claim() also fires controllerchange, and reloading there
    // would bounce every new visitor once for nothing. Only a genuine
    // update — already controlled, now controlled by something new —
    // earns the refresh.
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || refreshing) return;
      // Never reload out from under an in-progress recognition — the mic
      // capture and its AudD request would die mid-flight and the user
      // would just see the home stage again with no explanation. The new
      // SW is already active either way; the next load picks it up.
      if (isListening) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
