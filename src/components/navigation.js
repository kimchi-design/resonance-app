/**
 * Navigation — view switching for Home / Result / Library / Profile.
 *
 * Only one .view is `.active` at a time. Bottom-nav buttons reflect the
 * current view via their own `.active` class. This is a pure refactor of
 * the original prototype's onclick="showView(...)" pattern into a module API.
 *
 * Note: the bottom tab bar gets replaced in P-08 with a Listen/Explore mode
 * toggle + swipe drawer. For now, three-tab nav stays.
 */

/**
 * Switch to the named view ('home' | 'result' | 'library' | 'profile').
 * Resets scroll position and updates the bottom-nav active state.
 */
export function showView(viewId) {
  document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));

  const target = document.getElementById('view-' + viewId);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === viewId);
  });

  const content = document.getElementById('content');
  if (content) content.scrollTop = 0;
}

/**
 * Wire bottom-nav buttons and the result-screen back button.
 * Call once on app init from main.js.
 */
export function initNavigation() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view) showView(view);
    });
  });

  const backBtn = document.getElementById('backToHome');
  if (backBtn) backBtn.addEventListener('click', () => showView('home'));
}
