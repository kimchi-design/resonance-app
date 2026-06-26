/**
 * Waveform — the breathing waveform on the home screen.
 *
 * Two lighting layers, both alive:
 *   1. Each bar's height + opacity breathes via the Web Animations API.
 *   2. Two per-bar gradient stops slide in counter-phase, so the bright
 *      lavender "head" rides up and down inside each bar as it crests.
 *
 * Both layers run at the same per-bar duration with a shared centre-out
 * phase delay; setWaveformState() ramps every animation's playbackRate
 * together so listening accelerates the whole motion as one.
 *
 * Real-audio mode (P-09): when mic data starts flowing, the per-bar rect
 * animations are *cancelled* (WAAPI overrides inline styles, so pausing
 * isn't enough) and setBarHeights drives bar scaleY + opacity directly
 * from mic amplitudes. The apex stop animations keep running, so the
 * lavender heads still shift rhythmically while heights respond to the
 * room sound. resumeBars() recreates the rect animations when listening
 * ends, restoring the idle breathing.
 *
 * API:
 *   initWaveform(container) -> svg
 *   setWaveformState(svg, 'idle' | 'listening')
 *   setBarHeights(svg, amplitudes)   // P-09: mic-driven bar heights
 *   resumeBars(svg)                  // P-09: restore WAAPI breathing
 */

import { WAVEFORM_BAR_COUNT } from '../config.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const BAR_GRADIENT_ID = 'resonanceWaveGradient';

// Geometry
const BAR_WIDTH = 5;
const BAR_GAP = 7;
const BAR_PITCH = BAR_WIDTH + BAR_GAP;
const BAR_HEIGHT = 160;
const VIEW_HEIGHT = 200;
const VIEW_WIDTH = WAVEFORM_BAR_COUNT * BAR_PITCH - BAR_GAP;
const BAR_Y = (VIEW_HEIGHT - BAR_HEIGHT) / 2;

// Apex stops
const APEX_HIGH_OFFSET = '0.15';
const APEX_LOW_OFFSET = '0.30';
const APEX_BRIGHT = '1';
const APEX_DIM = '0.3';

// Motion
const BAR_CYCLE_MS = 4600;
const LISTENING_RATE = 3.0;
const RAMP_MS = 1100;

// Per-bar brightness range (idle breathing). Mic-driven mode uses the
// same range so the transition from idle into listening is smooth.
const OPACITY_LOW = 0.55;
const OPACITY_HIGH = 0.95;

// Per-bar height range as a fraction of the bar's envelopeAmp. Matches
// the idle keyframe values (low = amp * 0.12, peak = amp * 0.62) — mic
// energy modulates within this same range.
const SCALE_LOW_FACTOR = 0.12;
const SCALE_PEAK_FACTOR = 0.62;
const SCALE_RANGE = SCALE_PEAK_FACTOR - SCALE_LOW_FACTOR;

function envelope(index, count) {
  const t = index / (count - 1);
  const bell = Math.sin(t * Math.PI);
  const variation = 0.94 + 0.12 * Math.sin(index * 1.7);
  return (0.4 + 0.6 * bell) * variation;
}

function createBarGradient(barIndex) {
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  const id = `${BAR_GRADIENT_ID}_${barIndex}`;
  grad.setAttribute('id', id);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');

  const stop = (offset, opacity, className) => {
    const el = document.createElementNS(SVG_NS, 'stop');
    el.setAttribute('offset', offset);
    el.setAttribute('stop-opacity', opacity);
    el.setAttribute('class', className);
    grad.appendChild(el);
    return el;
  };

  stop('0', '0', 'wave-stop-fade-top');
  const apexHigh = stop(APEX_HIGH_OFFSET, APEX_BRIGHT, 'wave-stop-apex');
  const apexLow  = stop(APEX_LOW_OFFSET,  APEX_DIM,    'wave-stop-apex');
  stop('0.6', '0.5', 'wave-stop-body');
  stop('1', '0', 'wave-stop-fade-bottom');

  return { gradient: grad, id, apexHigh, apexLow };
}

/** Start (or restart) the rect's idle breathing animation. Returns the Animation. */
function createBarAnimation(rect, envelopeAmp, delay) {
  const low = envelopeAmp * SCALE_LOW_FACTOR;
  const peak = envelopeAmp * SCALE_PEAK_FACTOR;
  return rect.animate(
    [
      { transform: `scaleY(${low})`,  opacity: OPACITY_LOW },
      { transform: `scaleY(${peak})`, opacity: OPACITY_HIGH },
      { transform: `scaleY(${low})`,  opacity: OPACITY_LOW },
    ],
    {
      duration: BAR_CYCLE_MS,
      iterations: Infinity,
      easing: 'ease-in-out',
      delay,
    }
  );
}

export function initWaveform(container) {
  if (!container) return null;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`);
  svg.setAttribute('class', 'waveform-svg');
  svg.setAttribute('aria-hidden', 'true');

  const defs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(defs);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mid = (WAVEFORM_BAR_COUNT - 1) / 2;

  // bars[i] = { rect, envelopeAmp, delay, animation } — animation may be
  // null when bars are externally controlled (mic-driven mode) or under
  // prefers-reduced-motion.
  const bars = [];
  // stops[k] = { animation } — apex stop animations, never externally
  // controlled. They keep running regardless of bar mode.
  const stops = [];

  for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
    const { gradient, id, apexHigh, apexLow } = createBarGradient(i);
    defs.appendChild(gradient);

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'waveform-bar');
    rect.setAttribute('x', String(i * BAR_PITCH));
    rect.setAttribute('y', String(BAR_Y));
    rect.setAttribute('width', String(BAR_WIDTH));
    rect.setAttribute('height', String(BAR_HEIGHT));
    rect.setAttribute('rx', String(BAR_WIDTH / 2));
    rect.setAttribute('fill', `url(#${id})`);
    svg.appendChild(rect);

    const envelopeAmp = envelope(i, WAVEFORM_BAR_COUNT);
    const delay = -(mid - Math.abs(i - mid)) * 55;

    if (reduceMotion) {
      const low = envelopeAmp * SCALE_LOW_FACTOR;
      const peak = envelopeAmp * SCALE_PEAK_FACTOR;
      rect.style.transform = `scaleY(${(low + peak) / 2})`;
      rect.style.opacity = String((OPACITY_LOW + OPACITY_HIGH) / 2);
      bars.push({ rect, envelopeAmp, delay, animation: null });
      continue;
    }

    const animation = createBarAnimation(rect, envelopeAmp, delay);
    bars.push({ rect, envelopeAmp, delay, animation });

    // Apex stops slide in counter-phase — perceived apex glides between
    // 15% and 30% as the bar peaks vs. troughs.
    const apexHighAnim = apexHigh.animate(
      [
        { stopOpacity: APEX_DIM },
        { stopOpacity: APEX_BRIGHT },
        { stopOpacity: APEX_DIM },
      ],
      { duration: BAR_CYCLE_MS, iterations: Infinity, easing: 'ease-in-out', delay }
    );
    const apexLowAnim = apexLow.animate(
      [
        { stopOpacity: APEX_BRIGHT },
        { stopOpacity: APEX_DIM },
        { stopOpacity: APEX_BRIGHT },
      ],
      { duration: BAR_CYCLE_MS, iterations: Infinity, easing: 'ease-in-out', delay }
    );
    stops.push({ animation: apexHighAnim }, { animation: apexLowAnim });
  }

  container.replaceChildren(svg);

  svg._waveform = {
    bars,
    stops,
    current: 1,
    target: 1,
    raf: null,
    externalControl: false, // true while mic-driven bar heights are active
  };
  return svg;
}

/**
 * Switch the waveform between idle and listening. Every animation's
 * playbackRate eases toward the target so the heights, brightness, and
 * apex slide accelerate together — no part drifts out of sync.
 */
export function setWaveformState(svg, state) {
  const w = svg && svg._waveform;
  if (!w) return;

  const listening = state === 'listening';
  svg.classList.toggle('waveform-svg--listening', listening);
  w.target = listening ? LISTENING_RATE : 1;
  rampRate(svg);
}

/**
 * P-09: feed real mic amplitudes into the bars. The FIRST call cancels
 * each rect's WAAPI animation (since WAAPI overrides inline styles even
 * when paused) and switches to manual control. Apex stop animations are
 * untouched — the lavender heads keep their rhythm while heights respond
 * to the room. Mic energy is mapped into the bar's existing envelope
 * range, so the wave's bell shape is preserved even mid-recording.
 *
 * @param {SVGSVGElement} svg
 * @param {ArrayLike<number>} amplitudes - 32 values in [0..1]
 */
export function setBarHeights(svg, amplitudes) {
  const w = svg && svg._waveform;
  if (!w) return;

  if (!w.externalControl) {
    // First mic-driven frame — hand control of the rects to JS.
    for (const bar of w.bars) {
      if (bar.animation) {
        bar.animation.cancel();
        bar.animation = null;
      }
    }
    w.externalControl = true;
  }

  for (let i = 0; i < w.bars.length; i++) {
    const bar = w.bars[i];
    const v = Math.max(0, Math.min(1, amplitudes[i] || 0));
    // Map mic energy into the same envelope range the idle animation
    // uses, so center bars dance more than edge bars and the wave shape
    // is preserved.
    const scale = bar.envelopeAmp * (SCALE_LOW_FACTOR + SCALE_RANGE * v);
    const opacity = OPACITY_LOW + (OPACITY_HIGH - OPACITY_LOW) * v;
    bar.rect.style.transform = `scaleY(${scale})`;
    bar.rect.style.opacity = String(opacity);
  }
}

/**
 * P-09: restore idle breathing after mic-driven recording ends. Clears
 * the manual inline styles and recreates each bar's WAAPI animation from
 * its original envelopeAmp + delay so the rhythm resumes seamlessly.
 * No-op if bars were never externally controlled.
 */
export function resumeBars(svg) {
  const w = svg && svg._waveform;
  if (!w || !w.externalControl) return;

  for (const bar of w.bars) {
    bar.rect.style.removeProperty('transform');
    bar.rect.style.removeProperty('opacity');
    const animation = createBarAnimation(bar.rect, bar.envelopeAmp, bar.delay);
    // Match whatever playbackRate the rest of the waveform is currently
    // at (might still be the listening rate while the ramp eases down).
    animation.playbackRate = w.current;
    bar.animation = animation;
  }

  w.externalControl = false;
}

function rampRate(svg) {
  const w = svg._waveform;
  if (w.raf) cancelAnimationFrame(w.raf);

  let last = performance.now();
  const tau = RAMP_MS / 3;

  const step = (now) => {
    const dt = Math.min(now - last, 50);
    last = now;
    const k = 1 - Math.exp(-dt / tau);
    w.current += (w.target - w.current) * k;

    if (Math.abs(w.target - w.current) < 0.015) w.current = w.target;

    // Apply to every running animation — bars (when not externally
    // controlled) and apex stops.
    for (const bar of w.bars) {
      if (bar.animation) bar.animation.playbackRate = w.current;
    }
    for (const stop of w.stops) {
      if (stop.animation) stop.animation.playbackRate = w.current;
    }

    w.raf = w.current === w.target ? null : requestAnimationFrame(step);
  };

  w.raf = requestAnimationFrame(step);
}
