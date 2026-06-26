/**
 * Discovery Dial — fully custom slider for the recommendation engine's
 * mainstream ↔ obscure axis. Replaces the native <input type="range">
 * entirely so we own every pixel of the interaction and the visual.
 *
 * Five named positions (read from config.js) — Charting / Familiar /
 * Roaming / Adventurous / Lost. As the user drags, the named position
 * label updates in real time. When the user crosses into a different
 * named zone, the subtitle phrase below the label fades out and the new
 * phrase fades in (200ms each direction). Holding the dial inside the
 * same zone does NOT re-trigger the fade.
 *
 * Interaction:
 *   - Pointer events drive drag (mouse + touch + pen via setPointerCapture).
 *   - touch-action: none on the control so vertical scroll doesn't fight
 *     horizontal dragging on mobile.
 *   - Keyboard: ArrowLeft/Down −5, ArrowRight/Up +5, Shift doubles the
 *     step to 10, Home → 0, End → 100.
 *   - ARIA: role=slider with aria-valuemin/max/now/text — screen readers
 *     announce the value AND the current named position.
 *
 * API:
 *   initDiscoveryDial(host, { value, onChange }) -> { setValue, getValue }
 *
 *   onChange(value) fires only on actual value changes — drag updates
 *   that land on the same integer don't re-fire. setValue() updates the
 *   visual without firing onChange (so external code can sync the dial
 *   without bouncing the callback).
 */

import { DISCOVERY_POSITIONS, getDiscoveryPosition } from '../config.js';

const THUMB_PX = 20;
// P-16 subtitle cross-fade durations. Out is slightly faster than in so
// the second half of the transition (the new phrase arriving) gets to
// breathe. translateY 4px gives the words a subtle "lifted into place"
// feel without the bounciness of a spring.
const SUB_OUT_MS = 150;
const SUB_IN_MS = 200;

// Gradient endpoints used to colour the centred position label as the
// user drags. These RGB values must match --color-warm (Charting end) and
// --color-glow (Lost end) in main.css. Kept in JS as literal numbers so
// the per-frame interpolation doesn't have to read CSS custom properties.
const COLOR_WARM_RGB = [201, 173, 122];
const COLOR_GLOW_RGB = [183, 175, 255];

const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));

/**
 * Linear blend from --color-warm to --color-glow across 0..100. Returns
 * a CSS rgb() string so the caller can assign it to .style.color.
 */
function gradientColorAt(value) {
  const t = Math.max(0, Math.min(1, value / 100));
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  return `rgb(${lerp(COLOR_WARM_RGB[0], COLOR_GLOW_RGB[0])}, ${lerp(COLOR_WARM_RGB[1], COLOR_GLOW_RGB[1])}, ${lerp(COLOR_WARM_RGB[2], COLOR_GLOW_RGB[2])})`;
}

export function initDiscoveryDial(host, { value = 50, onChange = () => {} } = {}) {
  if (!host) return null;

  // First + last positions become the endpoint labels. Each gets a
  // position-id class (e.g. dial-end--charting) so CSS can colour it to
  // match its end of the track gradient.
  const firstPos = DISCOVERY_POSITIONS[0];
  const lastPos  = DISCOVERY_POSITIONS[DISCOVERY_POSITIONS.length - 1];

  host.innerHTML = `
    <div class="dial-ends">
      <span class="dial-end dial-end--${firstPos.id}">${firstPos.label}</span>
      <span class="dial-end dial-end--${lastPos.id}">${lastPos.label}</span>
    </div>
    <div class="dial-control" tabindex="0" role="slider"
         aria-label="Discovery range"
         aria-valuemin="0" aria-valuemax="100">
      <div class="dial-track">
        <div class="dial-thumb"></div>
      </div>
    </div>
    <div class="dial-label-main"></div>
    <div class="dial-subtitle"></div>
  `;

  const control = host.querySelector('.dial-control');
  const track   = host.querySelector('.dial-track');
  const thumb   = host.querySelector('.dial-thumb');
  const labelEl = host.querySelector('.dial-label-main');
  const subEl   = host.querySelector('.dial-subtitle');

  let current = clamp(value);
  let positionId = null;
  let dragging = false;
  // P-16: keep a handle on the in-flight subtitle exit animation so a
  // rapid drag across multiple zones cancels the previous transition
  // instead of stacking them.
  let subExitAnim = null;
  let subEnterAnim = null;

  function apply(rawValue, { silent = false } = {}) {
    const v = clamp(rawValue);
    const changed = v !== current;
    current = v;

    // Thumb stays fully inside the track (no half-thumb hanging off the
    // ends). There's no fill element any more — the track gradient IS the
    // spectrum, and the thumb alone indicates where on it the user sits.
    thumb.style.left = `calc((100% - ${THUMB_PX}px) * ${v} / 100)`;

    const position = getDiscoveryPosition(v);
    labelEl.textContent = position.label;
    // Position label colour shifts smoothly across the warm→cool gradient
    // as the user drags — the name visually anchors to its place on the
    // spectrum (amber at Charting, mauve at Roaming, lavender at Lost).
    labelEl.style.color = gradientColorAt(v);
    control.setAttribute('aria-valuenow', String(v));
    control.setAttribute('aria-valuetext', position.label);

    if (position.id !== positionId) {
      const isFirst = positionId === null;
      positionId = position.id;

      if (isFirst) {
        // First render — set subtitle directly with no fade.
        subEl.textContent = position.subtitle;
        subEl.style.opacity = '1';
        subEl.style.transform = 'translateY(0)';
      } else {
        // P-16 — Crossed into a new zone. WAAPI cross-fade with vertical
        // motion: old slides up & out, swap text, new slides up from
        // below into place. Cancels any in-flight transition so a rapid
        // drag across multiple zones doesn't stack animations.
        crossFadeSubtitle(subEl, position.subtitle);
      }
    }

    if (changed && !silent) onChange(v);
  }

  /**
   * P-16 — Cross-fade the subtitle text with a vertical motion via WAAPI.
   * Old fades to opacity 0 + translateY -4px, text swap, new comes in
   * from opacity 0 + translateY 4px → 0. Cancellable so a rapid drag
   * doesn't stack transitions.
   *
   * Respects prefers-reduced-motion: instant text swap, no motion.
   */
  function crossFadeSubtitle(el, nextText) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      el.textContent = nextText;
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
      return;
    }

    if (subExitAnim) subExitAnim.cancel();
    if (subEnterAnim) subEnterAnim.cancel();

    subExitAnim = el.animate(
      [
        { opacity: 1, transform: 'translateY(0)' },
        { opacity: 0, transform: 'translateY(-4px)' },
      ],
      { duration: SUB_OUT_MS, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
    );
    subExitAnim.onfinish = () => {
      el.textContent = nextText;
      subEnterAnim = el.animate(
        [
          { opacity: 0, transform: 'translateY(4px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: SUB_IN_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'forwards' }
      );
    };
  }

  /** Convert a clientX coordinate to a 0–100 dial value. */
  function valueFromPointer(clientX) {
    const rect = track.getBoundingClientRect();
    // Thumb centre sweeps between (rect.left + thumbHalf) and
    // (rect.right - thumbHalf), so map the pointer X to that range.
    const min = rect.left + THUMB_PX / 2;
    const max = rect.left + rect.width - THUMB_PX / 2;
    if (max <= min) return current;
    const pct = (clientX - min) / (max - min);
    return pct * 100;
  }

  control.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { control.setPointerCapture(e.pointerId); } catch (_) { /* not all browsers */ }
    apply(valueFromPointer(e.clientX));
    e.preventDefault();
  });

  control.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    apply(valueFromPointer(e.clientX));
  });

  const release = (e) => {
    if (!dragging) return;
    dragging = false;
    try { control.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  control.addEventListener('pointerup', release);
  control.addEventListener('pointercancel', release);

  control.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 5;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      apply(current - step); e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      apply(current + step); e.preventDefault();
    } else if (e.key === 'Home') {
      apply(0); e.preventDefault();
    } else if (e.key === 'End') {
      apply(100); e.preventDefault();
    }
  });

  // Initial render — silent so we don't bounce onChange on mount.
  apply(current, { silent: true });

  return {
    setValue: (v) => apply(v, { silent: true }),
    getValue: () => current,
  };
}
