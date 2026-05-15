import './styles/main.css';
import { ANCHOR, RECOMMENDATIONS, RECENT, HISTORY_EXTRA } from './data/sampleData.js';
import { showView, initNavigation } from './components/navigation.js';
import { initWaveform } from './components/waveform.js';

/* =====================================================================
   Resonance — main entry.
   Pure refactor of the prototype HTML in P-02. Same behavior, modular shape.
   Phase 3+ replaces the simulated pieces with real services.
   ===================================================================== */

/* ---------- State ---------- */
let hideAi = true;
let discovery = 50;
let listenTimer = null;

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

/* ---------- Renderers ---------- */
function renderHistory() {
  const all = [...RECENT, ...HISTORY_EXTRA];
  document.getElementById('historyList').innerHTML = all
    .map(
      (r) => `
    <div class="recent-row">
      <div class="recent-art ${r.art}"></div>
      <div class="recent-info">
        <div class="recent-title">${escapeHtml(r.t)}</div>
        <div class="recent-artist">${escapeHtml(r.a)}</div>
      </div>
      <div class="recent-time">${escapeHtml(r.time)}</div>
    </div>
  `
    )
    .join('');
}

function renderRecs() {
  let list = RECOMMENDATIONS.filter((r) => !(hideAi && r.ai));

  // Re-rank by Discovery Dial. At 0 we prefer mainstream (high-listener)
  // tracks that are still acoustically similar. At 100 we prefer obscure.
  const obscurity = discovery / 100;
  list = list
    .map((r) => {
      const logListeners = Math.log10(Math.max(r.listeners, 100));
      const mainstreamness = Math.min(logListeners / 7, 1); // 0..1
      const pull = (1 - obscurity) * mainstreamness + obscurity * (1 - mainstreamness);
      const score = r.sim * 0.7 + pull * 0.3;
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score);

  document.getElementById('recCount').textContent = list.length + ' tracks';

  const host = document.getElementById('recList');
  host.innerHTML = list
    .map(
      (r) => `
    <div class="rec-card" data-title="${escapeAttr(r.t)}" data-artist="${escapeAttr(r.a)}">
      <div class="rec-art ${r.art}"></div>
      <div class="rec-info">
        <div class="rec-title-text">${escapeHtml(r.t)}</div>
        <div class="rec-artist">${escapeHtml(r.a)}</div>
        <div class="rec-meta">
          <span class="chip chip-match">${Math.round(r.sim * 100)}% match</span>
          ${r.indie ? '<span class="chip chip-indie">◆ Indie</span>' : ''}
          ${r.ai ? '<span class="chip chip-ai">⚠ AI</span>' : ''}
          <span class="listeners">${formatListeners(r.listeners)}</span>
        </div>
      </div>
      <button class="rec-play" aria-label="Listen">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </button>
    </div>
  `
    )
    .join('');

  host.querySelectorAll('.rec-card').forEach((el) => {
    const open = () =>
      window.open(buildLinks(el.dataset.title, el.dataset.artist).spotify, '_blank');
    el.addEventListener('click', open);
    el.querySelector('.rec-play').addEventListener('click', (e) => {
      e.stopPropagation();
      open();
    });
  });
}

/* ---------- Listening simulation ---------- */
function initVizBars() {
  const host = document.getElementById('vizBars');
  host.innerHTML = '';
  for (let i = 0; i < 16; i++) {
    const bar = document.createElement('div');
    bar.className = 'viz-bar';
    bar.style.animationDelay = Math.random() * 0.6 + 's';
    bar.style.animationDuration = 0.4 + Math.random() * 0.5 + 's';
    host.appendChild(bar);
  }
}

function startListen() {
  initVizBars();
  document.getElementById('listeningSub').textContent = 'Hold your phone near the music.';
  document.getElementById('listeningOverlay').classList.add('active');

  listenTimer = setTimeout(() => {
    document.getElementById('listeningOverlay').classList.remove('active');
    simulateResult(ANCHOR.title, ANCHOR.artist, ANCHOR.artClass);
  }, 2300);
}

function cancelListen() {
  if (listenTimer) clearTimeout(listenTimer);
  document.getElementById('listeningOverlay').classList.remove('active');
}

function simulateResult(title, artist, art) {
  document.getElementById('resultTitle').textContent = title;
  const suffix =
    title === ANCHOR.title && artist === ANCHOR.artist ? " · Hurry Up, We're Dreaming" : '';
  document.getElementById('resultArtist').textContent = artist + suffix;
  document.getElementById('resultArt').className = 'result-art ' + art;

  const links = buildLinks(title, artist);
  document.getElementById('linkSpotify').href = links.spotify;
  document.getElementById('linkApple').href = links.apple;
  document.getElementById('linkYoutube').href = links.youtube;

  renderRecs();
  showView('result');
}

/* ---------- Controls ---------- */
function toggleAi() {
  hideAi = !hideAi;
  document.getElementById('aiToggle').classList.toggle('active', hideAi);
  renderRecs();
}

function onDiscChange(e) {
  discovery = parseInt(e.target.value, 10);
  const label =
    discovery < 20
      ? 'Mainstream'
      : discovery < 45
      ? 'Leaning Popular'
      : discovery < 60
      ? 'Balanced'
      : discovery < 85
      ? 'Adventurous'
      : 'Deep Cuts';
  document.getElementById('discValue').textContent = label;
  renderRecs();
}

/* ---------- Wire-up ----------
   The home screen is now a single full-screen tap target (#listenStage).
   The Hum / Upload / Lyrics quick-actions were removed in P-04 — hum and
   lyric recognition are explicitly out of MVP scope.
*/
document.getElementById('listenStage').addEventListener('click', startListen);
document.getElementById('cancelBtn').addEventListener('click', cancelListen);
document.getElementById('aiToggle').addEventListener('click', toggleAi);
document.getElementById('discSlider').addEventListener('input', onDiscChange);

/* ---------- Boot ---------- */
initWaveform(document.getElementById('waveform'));
initNavigation();
renderHistory();
renderRecs();
