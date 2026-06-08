// Gestion du toggle thème (kitchen.html uniquement)
(function () {
  const STORAGE_KEY = 'pizzia-theme';
  const html = document.documentElement;

  function getEffectiveTheme() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    html.dataset.theme = theme;
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
  }

  function toggle() {
    const current = getEffectiveTheme();
    const next = current === 'light' ? 'dark' : 'light';
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  }

  // Appliquer au chargement
  applyTheme(getEffectiveTheme());

  // Réagir aux changements OS si pas de préférence manuelle enregistrée
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (!localStorage.getItem(STORAGE_KEY)) applyTheme(e.matches ? 'light' : 'dark');
  });

  window.__themeToggle = toggle;
})();
