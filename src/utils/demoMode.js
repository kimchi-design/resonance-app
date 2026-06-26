/**
 * Demo mode — activated by adding `?demo=1` to the URL.
 *
 * When on:
 *   - audioCapture skips the mic entirely (no permission prompt, no
 *     AudioContext) and drives the waveform with synthetic amplitudes
 *     for the standard recording duration.
 *   - recognitionService returns an ANCHOR-based "match" without calling
 *     AudD, with a simulated round-trip delay.
 *   - reccobeatsService returns synthetic audio features and sample
 *     recommendations without calling /api/reccobeats, with simulated
 *     delays so the loading states still get to render.
 *
 * Why this exists:
 *   - **Cheap iteration**: build / test UI, animations, state machines,
 *     and the Discovery Dial without burning a single AudD recognition.
 *   - **Screen recordings + early demos**: show the app to friends or
 *     record marketing footage with no API keys, no mic permission
 *     surprises, no quota anxiety.
 *   - **Offline-friendly**: works on a flight, in a coffee shop with
 *     bad wifi, or anywhere the upstream APIs are flaky.
 *
 * No visual badge is shown — keeps screen recordings clean. The boot-
 * time console.log in main.js tells you you're in demo mode if you have
 * DevTools open.
 *
 * Captured once at module load; URL changes during a session don't
 * toggle the flag. To switch modes, reload.
 */
export const IS_DEMO = (() => {
  try {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('demo') === '1';
  } catch {
    return false;
  }
})();

/**
 * Promise-based sleep that respects an AbortSignal. Used by demo
 * branches in services to simulate network latency without blocking
 * the cancellation path — caller cancels (e.g. user taps mid-listen),
 * this rejects with an AbortError, and the existing fetch-style catch
 * blocks in the services handle it identically to a real aborted fetch.
 */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    }
  });
}
