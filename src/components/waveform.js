/**
 * Waveform — the 32-bar breathing waveform on the home screen.
 *
 * P-04: idle "breathing" state only — a calm, ambient animation that signals
 * the app is listening-ready without the urgency of a Shazam pulse.
 *
 * Later phases build on this same component:
 *   - P-05 adds a "listening" state (bars intensify in place, no overlay).
 *   - P-09 drives bar heights from real mic data via the Web Audio API.
 *
 * The bars are SVG <rect>s; the breathing motion is pure CSS (see main.css).
 * initWaveform returns the <svg> element so later phases can target it.
 */

import { WAVEFORM_BAR_COUNT } from '../config.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const BAR_WIDTH = 6;
const BAR_PITCH = 12; // bar width + gap
const BAR_HEIGHT = 150;
const VIEW_HEIGHT = 200;
const VIEW_WIDTH = WAVEFORM_BAR_COUNT * BAR_PITCH - (BAR_PITCH - BAR_WIDTH);
const BAR_Y = (VIEW_HEIGHT - BAR_HEIGHT) / 2;

/**
 * Build the waveform SVG and mount it inside `container`.
 * @param {HTMLElement} container - element to render the SVG into
 * @returns {SVGSVGElement} the mounted <svg>, for later phases to animate
 */
export function initWaveform(container) {
  if (!container) return null;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`);
  svg.setAttribute('class', 'waveform-svg');
  svg.setAttribute('aria-hidden', 'true'); // decorative — the button has the label

  const mid = (WAVEFORM_BAR_COUNT - 1) / 2;

  for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
    const bar = document.createElementNS(SVG_NS, 'rect');
    bar.setAttribute('class', 'waveform-bar');
    bar.setAttribute('x', String(i * BAR_PITCH));
    bar.setAttribute('y', String(BAR_Y));
    bar.setAttribute('width', String(BAR_WIDTH));
    bar.setAttribute('height', String(BAR_HEIGHT));
    bar.setAttribute('rx', String(BAR_WIDTH / 2));

    // Stagger the animation from the centre outward so the motion ripples
    // gently rather than flickering randomly — reads as "breathing".
    const distanceFromCentre = Math.abs(i - mid);
    bar.style.animationDelay = `${distanceFromCentre * 0.07}s`;

    svg.appendChild(bar);
  }

  container.replaceChildren(svg);
  return svg;
}
