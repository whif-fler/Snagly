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

// The page ships both policies so it works without JavaScript. When the cloud
// server is present, show the mode that actually applies to this deployment.
(async function applyMode() {
  try {
    const res = await fetch('/api/session', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store'
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data?.capabilities?.mode !== 'cloud') return;
    const hours = window.SnaglyMode.retentionHours(data);
    const hoursText = window.SnaglyMode.hoursLabel(hours);
    document.getElementById('localPrivacy').hidden = true;
    document.getElementById('cloudPrivacy').hidden = false;
    document.getElementById('policyTitle').textContent = 'Your library is stored on this server';
    document.getElementById('policyLede').textContent =
      'This Snagly instance is self-hosted. The operator stores your jobs and files for a limited time so you can save them to your device.';
    document.getElementById('policyFooter').textContent =
      'Self-hosted. The server operator can access stored data.';
    const retention = document.getElementById('cloudRetentionCopy');
    if (retention) retention.textContent = hoursText;
    const summary = document.getElementById('policySummary');
    if (summary) {
      summary.innerHTML = `<ul><li>Anonymous session; no account or password.</li><li>Jobs and files are deleted after ${hoursText}.</li><li>The operator can access stored data.</li><li>Your own YouTube cookies are never read or uploaded.</li></ul>`;
    }
  } catch {
    // Static hosting or the local app: the local policy is correct.
  }
})();
