'use strict';

// Match the theme the app last used. Kept in a file so the page stays
// compatible with a strict Content-Security-Policy (no inline scripts).
(function applyTheme() {
  const saved = localStorage.getItem('reel-theme');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (systemDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#1C1C1E' : '#F5F5F7');
})();
