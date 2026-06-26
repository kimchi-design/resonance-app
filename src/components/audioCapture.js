/**
 * Audio capture for song identification.
 *
 * captureAudio() requests mic permission, records RECORDING_DURATION_MS
 * (5 seconds) via MediaRecorder, and resolves with the recorded audio as
 * a Blob. The blob is consumed by recognitionService.recognizeSong (P-10),
 * which POSTs it to /api/audd. During recording, an
 * AnalyserNode reads the live frequency data and emits 32 normalized
 * amplitude values per frame through the onAmplitudes callback —
 * main.js feeds those values to the waveform so the bars visibly react
 * to whatever the mic is hearing.
 *
 * Permission denial rejects with { code: 'denied', message }. Other
 * setup failures reject with { code: 'recorder', ... } or
 * { code: 'audio', ... }. main.js catches these to show an inline
 * "tap to allow" prompt without breaking the listening flow.
 *
 * stopCapture() halts an in-progress capture early (user cancellation)
 * and resolves the original promise with null — main.js's await sees
 * null and bails out of the listening flow cleanly.
 *
 * Cleanup is centralised so any exit path (success, cancel, error)
 * cancels the rAF, stops the MediaRecorder, closes the AudioContext, and
 * releases the mic stream. Nothing left dangling.
 *
 * API:
 *   captureAudio({ onAmplitudes }) -> Promise<Blob | null>
 *   stopCapture()
 *   isCapturing() -> boolean
 */

import { WAVEFORM_BAR_COUNT, RECORDING_DURATION_MS } from '../config.js';
import { IS_DEMO } from '../utils/demoMode.js';

// 2048 samples → 1024 frequency bins, fine enough that no two of our 32
// bars have to share the same low-end bin under log distribution.
const FFT_SIZE = 2048;

// Bars distribute logarithmically across this band. The full FFT goes
// 0 Hz → Nyquist (~22 kHz), but almost all musical energy lives between
// roughly 60 Hz and 12 kHz — below 60 Hz is subsonic rumble, above 12 kHz
// is sparse for voice/music. Mapping our 32 bars across this band means
// every bar sits on frequencies a normal source actually contains.
const MIN_FREQ = 60;
const MAX_FREQ = 12000;

// In-flight capture state. Null when nothing is running.
let state = null;

/** Probe MediaRecorder.isTypeSupported for the formats AudD accepts.
    audio/webm wins on Chromium/Firefox; audio/mp4 wins on Safari. */
function preferredMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return ''; // browser default
}

export function isCapturing() {
  return state !== null;
}

/**
 * Cancel an in-progress capture early. The captureAudio() promise
 * resolves with null on the next microtask. No-op if nothing's running.
 */
export function stopCapture() {
  if (!state) return;
  finish({ value: null });
}

/**
 * Start a recording session. See module header for the full contract.
 */
export function captureAudio({ onAmplitudes = null } = {}) {
  if (state) {
    return Promise.reject(new Error('Capture already in progress'));
  }

  // Demo mode: skip the mic entirely. Drive the waveform with synthetic
  // amplitudes for the standard recording duration so the visual flow is
  // indistinguishable from a real capture, then resolve with a dummy Blob
  // (recognitionService also has a demo branch that ignores the blob).
  if (IS_DEMO) {
    return captureDemo(onAmplitudes);
  }

  return new Promise((resolve, reject) => {
    // Initialise placeholder state so isCapturing() reports true
    // immediately. Each property is filled in as setup progresses.
    state = {
      stream: null,
      audioContext: null,
      analyser: null,
      recorder: null,
      chunks: [],
      rafId: 0,
      stopTimer: 0,
      mimeType: '',
      onAmplitudes,
      resolve,
      reject,
    };

    setup().catch((err) => {
      // setup() handles its own cleanup via finish(); this just guards
      // against any unexpected synchronous throws.
      finish({ error: err });
    });
  });
}

async function setup() {
  // 1. Permission
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    finish({ error: { code: 'denied', message: err && err.message } });
    return;
  }
  if (!state) return; // cancelled while waiting for permission
  state.stream = stream;

  // 2. AudioContext + analyser. Some browsers create AudioContext in
  // 'suspended' state without a user gesture; we explicitly resume().
  const Ctx = window.AudioContext || window.webkitAudioContext;
  let audioContext;
  try {
    audioContext = new Ctx();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
  } catch (err) {
    finish({ error: { code: 'audio', message: err && err.message } });
    return;
  }
  if (!state) return;
  state.audioContext = audioContext;

  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  source.connect(analyser);
  state.analyser = analyser;

  // 3. Precompute log-distributed bin ranges, one per bar. Each bar covers
  // an exponentially-spaced slice of MIN_FREQ → MAX_FREQ — the band where
  // music + voice energy actually lives. Linear bucketing concentrated
  // all energy in bars 0–5 (everything else was sitting on near-silent
  // ultra-high frequencies); log bucketing matches how the ear hears
  // (in octaves) and spreads energy across every bar.
  const nyquist = audioContext.sampleRate / 2;
  const binsCount = analyser.frequencyBinCount;
  const logMin = Math.log(MIN_FREQ);
  const logMax = Math.log(MAX_FREQ);
  const binRanges = new Array(WAVEFORM_BAR_COUNT);
  let prevEnd = 1; // skip the DC bin (0)
  for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
    const startFreq = Math.exp(logMin + (logMax - logMin) * (i / WAVEFORM_BAR_COUNT));
    const endFreq = Math.exp(logMin + (logMax - logMin) * ((i + 1) / WAVEFORM_BAR_COUNT));
    const naturalStart = Math.floor((startFreq / nyquist) * binsCount);
    const naturalEnd = Math.ceil((endFreq / nyquist) * binsCount);
    // Force each bar to start AFTER the previous bar's end and span at
    // least one new bin. At very low frequencies the natural log range
    // collapses onto a single bin (there just aren't many bins below
    // 100 Hz at this sample rate); without this enforcement bars 0–2
    // would overlap and react identically.
    const start = Math.max(naturalStart, prevEnd);
    const end = Math.min(binsCount, Math.max(start + 1, naturalEnd));
    binRanges[i] = { start, end };
    prevEnd = end;
  }

  // 4. Per-bar gain compensation. Music + voice spectral energy rolls
  // off as frequency rises (basically every audio source on earth has
  // more bass than treble in absolute terms), so even after log binning
  // the right-side bars sit at ~10% of the left-side bars' amplitude.
  // A gentle power-curve boost — 1× at bar 0, 6× at bar 31 — lifts the
  // high-frequency bars to comparable visible amplitudes without forcing
  // the bass bars to clip. This is the same compensation iTunes/Winamp/
  // every macOS+iOS audio visualizer applies; it makes "perceived
  // responsiveness" match audio reality.
  const gainCurve = new Float32Array(WAVEFORM_BAR_COUNT);
  for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
    const t = i / (WAVEFORM_BAR_COUNT - 1);
    gainCurve[i] = 1 + Math.pow(t, 1.5) * 5;
  }

  // 5. Per-frame amplitude pump. Re-allocate buffers once and reuse.
  const bins = new Uint8Array(binsCount);
  const amplitudes = new Float32Array(WAVEFORM_BAR_COUNT);

  const tick = () => {
    if (!state) return;
    state.analyser.getByteFrequencyData(bins);

    for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
      const { start, end } = binRanges[i];
      let sum = 0;
      let count = 0;
      for (let j = start; j < end; j++) {
        sum += bins[j];
        count++;
      }
      const raw = count > 0 ? sum / count / 255 : 0; // normalize 0–255 → 0–1
      // Apply per-bar gain, clamp to [0, 1] so a loud high-frequency
      // burst saturates rather than overflows.
      amplitudes[i] = Math.min(1, raw * gainCurve[i]);
    }

    if (state.onAmplitudes) state.onAmplitudes(amplitudes);
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);

  // 4. Recorder
  const mime = preferredMimeType();
  state.mimeType = mime;
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (err) {
    finish({ error: { code: 'recorder', message: err && err.message } });
    return;
  }
  if (!state) return;
  state.recorder = recorder;

  recorder.addEventListener('dataavailable', (e) => {
    if (state && e.data && e.data.size > 0) state.chunks.push(e.data);
  });

  recorder.addEventListener('stop', () => {
    // If we already finished (via cancel), don't re-resolve.
    if (!state) return;
    const blob = new Blob(state.chunks, { type: mime || 'audio/webm' });
    finish({ value: blob });
  });

  recorder.start();

  // 5. Auto-stop after the fixed recording duration. recorder.stop()
  // fires its 'stop' event asynchronously, which resolves the promise.
  state.stopTimer = setTimeout(() => {
    if (state && state.recorder && state.recorder.state === 'recording') {
      state.recorder.stop();
    }
  }, RECORDING_DURATION_MS);
}

/**
 * Demo-mode capture: no mic, no AudioContext, no MediaRecorder. Drives
 * the waveform with a synthetic amplitude signal so "Listening…" still
 * feels alive on screen, then resolves with a dummy Blob after the
 * standard recording duration.
 *
 * Mirrors enough of the real state shape that the existing finish()
 * teardown handles both the natural-completion and cancellation paths
 * identically to the mic path — same rafId / stopTimer field names,
 * resolve passed straight through to the outer Promise, real-resource
 * fields (stream / audioContext / recorder) left null so the cleanup
 * blocks no-op.
 */
function captureDemo(onAmplitudes) {
  return new Promise((resolve) => {
    const start = performance.now();

    const demoState = {
      stream: null, audioContext: null, analyser: null,
      recorder: null, chunks: [],
      rafId: 0, stopTimer: 0, mimeType: '',
      onAmplitudes,
      // resolve passes straight through. reject is wired to the same
      // resolver since demo capture never errors — if something
      // unexpected wants to reject, treat it as a null-blob cancel.
      resolve,
      reject: () => resolve(null),
      isDemo: true,
    };
    state = demoState;

    const tick = () => {
      if (state !== demoState) return;
      const elapsed = performance.now() - start;
      if (onAmplitudes) {
        onAmplitudes(generateDemoAmplitudes(elapsed));
      }
      demoState.rafId = requestAnimationFrame(tick);
    };
    demoState.rafId = requestAnimationFrame(tick);

    demoState.stopTimer = setTimeout(() => {
      if (state !== demoState) return;
      const blob = new Blob([new Uint8Array([0])], { type: 'audio/webm' });
      finish({ value: blob });
    }, RECORDING_DURATION_MS);
  });
}

/**
 * Synthetic per-bar amplitudes for demo capture. Two layers:
 *   - bass-leaning envelope (mimics real music: more energy in low bars)
 *   - slow + fast wobble per-bar so the waveform never freezes
 * Output values are in [0..1], matching the real mic path's normalized
 * amplitude contract.
 */
function generateDemoAmplitudes(elapsedMs) {
  const out = new Float32Array(WAVEFORM_BAR_COUNT);
  const t = elapsedMs / 1000;
  for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
    const barT = i / (WAVEFORM_BAR_COUNT - 1);
    // Bass-heavy envelope — left bars sit higher than right bars on average.
    const envelope = 0.45 + 0.35 * Math.cos(barT * Math.PI * 0.5);
    // Two-frequency wobble so neighbouring bars never move in perfect lockstep.
    const slow = 0.22 * Math.sin(t * 2.1 + i * 0.31);
    const fast = 0.14 * Math.sin(t * 6.7 + i * 0.13);
    out[i] = Math.max(0.05, Math.min(1, envelope + slow + fast));
  }
  return out;
}

/**
 * Centralised exit path. Called from: success ('stop' event), cancel
 * (stopCapture), or any error during setup. Tears down everything and
 * resolves/rejects exactly once.
 */
function finish({ value = undefined, error = null } = {}) {
  if (!state) return;
  const { stream, audioContext, recorder, rafId, stopTimer, resolve, reject } = state;

  // Snapshot then clear state synchronously so any racing handlers
  // (e.g. a queued 'stop' event) see state === null and bail out.
  state = null;

  if (rafId) cancelAnimationFrame(rafId);
  if (stopTimer) clearTimeout(stopTimer);

  if (recorder && recorder.state !== 'inactive') {
    try { recorder.stop(); } catch (_) { /* already stopped */ }
  }

  if (audioContext && audioContext.state !== 'closed') {
    try { audioContext.close(); } catch (_) { /* already closed */ }
  }

  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
  }

  if (error) reject(error);
  else resolve(value);
}
