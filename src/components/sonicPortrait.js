/**
 * Sonic Portrait — a 5-bar visual fingerprint of a track's audio character.
 * Lives on the result screen between the emotional descriptors and the
 * streaming-service buttons.
 *
 * Input shape (each value 0–100):
 *   { energy, mood, texture, pace, depth }
 *
 * Visual: five thin columns side-by-side. Each column is a value (above),
 * a 6px-wide indigo bar that grows from 4px to its target height (a max of
 * 80px), and an uppercase trait label (below). Bars animate in on mount —
 * each bar starts at 4px height and transitions to its target over 600ms,
 * staggered 80ms apart so the portrait visibly "builds in."
 *
 * Decorative for screen readers — the emotional descriptors and the rest
 * of the result screen already convey the same information textually.
 *
 * Values come from reccobeatsService.mapFeaturesToPortrait (P-11) for any
 * track ReccoBeats has indexed; tracks ReccoBeats doesn't know fall back
 * to neutral placeholder values supplied by recognitionService. The
 * component itself doesn't care which — it just renders whatever 0–100
 * numbers it's handed.
 *
 * API:
 *   renderSonicPortrait(host, values)         — fresh build, grows from 4px
 *   updateSonicPortrait(host, values)         — retarget existing bars in place
 */

const TRAITS = ['energy', 'mood', 'texture', 'pace', 'depth'];
const BAR_MAX_HEIGHT = 80;
const BAR_MIN_HEIGHT = 4;
const STAGGER_MS = 80;

/**
 * Render (or re-render) the Sonic Portrait into `host`. Clears any prior
 * content, then triggers the grow-in animation on the next frame.
 *
 * @param {HTMLElement} host - container element (e.g. document.getElementById('sonicPortrait'))
 * @param {{energy:number, mood:number, texture:number, pace:number, depth:number}} values
 */
export function renderSonicPortrait(host, values) {
  if (!host || !values) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  host.replaceChildren();

  const bars = [];

  for (let i = 0; i < TRAITS.length; i++) {
    const trait = TRAITS[i];
    const raw = Number(values[trait]);
    const value = Math.max(0, Math.min(100, isFinite(raw) ? raw : 0));
    const targetHeight = BAR_MIN_HEIGHT + (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) * (value / 100);

    const column = document.createElement('div');
    column.className = 'portrait-column';

    const valueEl = document.createElement('span');
    valueEl.className = 'portrait-value';
    valueEl.textContent = String(Math.round(value));

    // The bar lives inside a fixed-height track so it can grow upward from
    // a stable baseline; all 5 bars therefore share the same bottom edge.
    const barTrack = document.createElement('div');
    barTrack.className = 'portrait-bar-track';

    const bar = document.createElement('div');
    bar.className = 'portrait-bar';
    bar.style.height = `${BAR_MIN_HEIGHT}px`;
    barTrack.appendChild(bar);

    const labelEl = document.createElement('span');
    labelEl.className = 'portrait-label';
    labelEl.textContent = trait;

    column.appendChild(valueEl);
    column.appendChild(barTrack);
    column.appendChild(labelEl);
    host.appendChild(column);

    bars.push({ bar, targetHeight });
  }

  if (reduceMotion) {
    // Skip the grow-in; show the final shape immediately.
    for (const { bar, targetHeight } of bars) {
      bar.style.transition = 'none';
      bar.style.height = `${targetHeight}px`;
    }
    return;
  }

  // Apply the target heights on the next frame so the CSS height
  // transition (defined in main.css) actually fires. Per-bar delay creates
  // the left-to-right staggered build-in.
  requestAnimationFrame(() => {
    bars.forEach(({ bar, targetHeight }, i) => {
      bar.style.transitionDelay = `${i * STAGGER_MS}ms`;
      bar.style.height = `${targetHeight}px`;
    });
  });
}

/**
 * Retarget an already-rendered Sonic Portrait to new values, without
 * tearing down and rebuilding the DOM. The bars' existing CSS height
 * transition smoothly redirects to the new targets (so if features
 * arrive mid-mount-animation, the bars don't flicker — they continue
 * growing toward the new heights).
 *
 * Falls back to a fresh renderSonicPortrait if the host doesn't already
 * have the expected 5-column structure (defensive: should only happen if
 * this is called before any initial render).
 */
export function updateSonicPortrait(host, values) {
  if (!host || !values) return;
  const columns = host.querySelectorAll('.portrait-column');
  if (columns.length !== TRAITS.length) {
    renderSonicPortrait(host, values);
    return;
  }
  for (let i = 0; i < TRAITS.length; i++) {
    const trait = TRAITS[i];
    const raw = Number(values[trait]);
    const value = Math.max(0, Math.min(100, isFinite(raw) ? raw : 0));
    const targetHeight = BAR_MIN_HEIGHT + (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT) * (value / 100);

    const valueEl = columns[i].querySelector('.portrait-value');
    const bar = columns[i].querySelector('.portrait-bar');
    if (valueEl) valueEl.textContent = String(Math.round(value));
    if (bar) {
      bar.style.transitionDelay = `${i * STAGGER_MS}ms`;
      bar.style.height = `${targetHeight}px`;
    }
  }
}
