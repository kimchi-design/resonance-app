/**
 * Shared audio-preview player. One HTMLAudioElement reused across all
 * rec cards — starting a new preview pauses the old one automatically
 * via src reassignment. UI components subscribe to state changes
 * (play / pause / timeupdate / ended / error) and update the DOM
 * minimally (button class, progress fill, playing border) rather than
 * re-rendering the rec list on every frame.
 *
 * Public API:
 *   play(id, url)            — start (or resume, if same id) playback
 *   pause()                  — pause the currently loaded track
 *   stop()                   — pause + clear loadedId (e.g. on new recognition)
 *   getState()               — snapshot {loadedId, isPlaying, progress, duration}
 *   subscribe(listener)      — call listener(state) on every change;
 *                              returns an unsubscribe function
 *
 * Why a single shared element rather than one per card:
 *   - Switching src is the cleanest "pause old, play new" — the browser
 *     handles the transition.
 *   - 20 hidden Audio elements per rec list is wasted memory.
 *   - Only one track can audibly play at a time anyway.
 */

let audio = null;
let loadedId = null;
const listeners = new Set();

function getAudio() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'metadata';
  // Standard event wiring. timeupdate is the throttled progress signal
  // (~4 Hz in most browsers — enough for a smooth thin progress bar).
  audio.addEventListener('play', notify);
  audio.addEventListener('pause', notify);
  audio.addEventListener('timeupdate', notify);
  audio.addEventListener('ended', () => {
    // Reset to top so the next .play() on this same id replays cleanly.
    if (audio) audio.currentTime = 0;
    loadedId = null;
    notify();
  });
  audio.addEventListener('error', () => {
    loadedId = null;
    notify();
  });
  return audio;
}

function notify() {
  const state = getState();
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (_) {
      // Listener errors don't break the broadcast.
    }
  }
}

/** Snapshot of the current player state. Safe to call any time. */
export function getState() {
  const a = audio;
  if (!a || !loadedId) {
    return { loadedId: null, isPlaying: false, progress: 0, duration: 0 };
  }
  const duration = isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
  const progress = duration > 0 ? Math.min(1, a.currentTime / duration) : 0;
  return {
    loadedId,
    isPlaying: !a.paused,
    progress,
    duration,
  };
}

/**
 * Start playing `url` associated with rec `id`. If `id` matches the
 * currently loaded track, simply resumes from the current position
 * (resume semantics for pause-then-tap-again UX). Otherwise swaps the
 * src and plays from 0.
 *
 * Returns a Promise that resolves when playback starts, or rejects if
 * the browser blocks autoplay / the URL is bad / etc. — caller doesn't
 * need to await it, but can if they want explicit error handling.
 */
export function play(id, url) {
  const a = getAudio();
  if (loadedId !== id) {
    a.src = url;
    loadedId = id;
  }
  // Calling .play() can reject if the URL fails to load or if the
  // browser blocks autoplay. We silently fall back to "not playing" —
  // the listener will see isPlaying false and the UI will show paused.
  return a.play().catch(() => {
    loadedId = null;
    notify();
  });
}

export function pause() {
  const a = audio;
  if (a && !a.paused) a.pause();
}

/**
 * Hard stop — pause, reset position, clear loadedId. Used on new
 * recognition so the previous track's preview doesn't keep playing into
 * the new result screen.
 */
export function stop() {
  const a = audio;
  if (a) {
    if (!a.paused) a.pause();
    a.currentTime = 0;
  }
  loadedId = null;
  notify();
}

/**
 * Subscribe to state changes. Returns an unsubscribe function. The
 * listener fires immediately with the current state, so subscribers
 * can do initial-render setup without a separate getState() call.
 */
export function subscribe(listener) {
  listeners.add(listener);
  listener(getState());
  return () => listeners.delete(listener);
}
