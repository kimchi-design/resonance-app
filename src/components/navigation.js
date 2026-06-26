/**
 * Navigation — view switching driven by the topbar pill (Listen / Explore)
 * and the avatar (Profile).
 *
 * Replaces the prototype's three-tab bottom nav. The pill is the primary
 * mode toggle; the avatar is a discreet right-side access point for
 * Profile so we don't need a third pill option.
 *
 * The Result view is *part of Listen mode* — when the user is on
 * view-result, the Listen pill stays active (Result is a phase of the
 * Listen flow, not its own destination).
 */

// Which views belong to which pill mode. Profile has no pill mode — it's
// accessed via the avatar and shows neither pill as active.
const VIEW_TO_MODE = {
  home: 'listen',
  result: 'listen',
  library: 'explore',
  profile: null,
};

/**
 * Switch to the named view. Updates the active .view element, syncs the
 * pill's active state (based on which mode the view belongs to), and
 * resets the content scroll position so each view starts from the top.
 */
export function showView(viewId) {
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById('view-' + viewId);
  if (target) target.classList.add('active');

  const mode = VIEW_TO_MODE[viewId] || null;
  document.querySelectorAll('.pill-option').forEach((el) => {
    const isActive = el.dataset.mode === mode;
    el.classList.toggle('pill-option--active', isActive);
    el.setAttribute('aria-selected', String(isActive));
  });

  const content = document.getElementById('content');
  if (content) content.scrollTop = 0;
}

/**
 * Wire the pill, the avatar, and the result-screen back button. Call once
 * on app boot. The pill always returns Listen mode to view-home (Result
 * is ephemeral — toggling away clears it; you re-identify to get it back).
 *
 * P-16 — the back button gets a tailored exit animation (result slides
 * down + fades) so leaving the result feels weighted rather than a
 * sudden snap. Other navigation paths (pill, avatar) use the existing
 * fadeIn — they're context switches, not the same "this moment is
 * ending" gesture the back button represents.
 */
export function initNavigation() {
  document.querySelectorAll('.pill-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === 'listen') showView('home');
      else if (mode === 'explore') showView('library');
    });
  });

  const profileBtn = document.getElementById('profileButton');
  if (profileBtn) profileBtn.addEventListener('click', () => showView('profile'));

  const backBtn = document.getElementById('backToHome');
  if (backBtn) {
    backBtn.addEventListener('click', async () => {
      const resultView = document.getElementById('view-result');
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      // P-17 (library reopen) — contextual back target. Live recognition
      // sets data-return-to='home' inside renderResult; library-originated
      // reopens override it to 'library' in openHistoricalResult so the
      // user returns where they came from instead of home. Default is
      // 'home' for the live-recognition default + any unset case.
      const returnTo = (resultView && resultView.dataset.returnTo) || 'home';
      if (resultView && resultView.classList.contains('active') && !reduce) {
        // Mark the view as "leaving" so any nested mount animations stop
        // fighting the exit transform; CSS in main.css disables pointer
        // events while the exit plays.
        resultView.classList.add('view--leaving');
        const exit = resultView.animate(
          [
            { opacity: 1, transform: 'translateY(0)' },
            { opacity: 0, transform: 'translateY(40px)' },
          ],
          { duration: 280, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
        );
        try {
          await exit.finished;
        } catch (_) {
          // Animation cancelled (rare — only if the page navigated away
          // mid-transition); proceed regardless.
        }
        resultView.classList.remove('view--leaving');
        // Swap to home FIRST (display:none takes effect), THEN cancel the
        // WAAPI animation. This is the critical step that fixes the
        // "result shows briefly then page blanks" bug on second+
        // identifications: without cancel(), fill:'forwards' kept the
        // animation effect (opacity 0, translateY 40px) attached to
        // view-result. The next time view-result became .active and the
        // CSS resultEnter animation ran, WAAPI's higher cascade priority
        // overrode CSS during resultEnter's after-phase — view went
        // invisible the instant the slide-up completed. Cancelling now,
        // after the view is hidden, leaves no flicker (display:none
        // covers any transient repaint) and clears the slate for the
        // next mount. Belt-and-braces: also clear any inline opacity/
        // transform a browser variation might have written.
        showView(returnTo);
        exit.cancel();
        resultView.style.opacity = '';
        resultView.style.transform = '';
      } else {
        showView(returnTo);
      }
    });
  }
}
