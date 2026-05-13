import './styles/global.css';

// P-01 placeholder. P-02 will migrate the prototype into a real component tree.
// Keeping this intentionally minimal so the first `npm run dev` proves the pipeline works
// (fonts load, CSS variables apply, dark background renders) without committing to UI yet.
const app = document.getElementById('app');

app.innerHTML = `
  <main class="scaffold">
    <h1 class="scaffold__title">Resonance</h1>
    <p class="scaffold__subtitle">Scaffold ready · P-01</p>
  </main>
`;
