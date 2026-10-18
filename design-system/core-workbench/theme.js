// 在样式加载前恢复外观，避免深色偏好下先显示浅色页面。
(() => {
  'use strict';
  const storageKey = 'offline-sync-prototype-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const labels = { light: '浅色', dark: '深色', system: '跟随系统' };
  const icons = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    dark: '<path d="M20.6 13a8.7 8.7 0 0 1-9.6-9.6A8.8 8.8 0 1 0 20.6 13Z"/>',
    system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  };
  function validMode(value) {
    return ['light', 'dark', 'system'].includes(value) ? value : 'system';
  }
  let mode = 'system';
  try { mode = validMode(localStorage.getItem(storageKey)); } catch { /* 存储不可用时仍可切换。 */ }

  function applyTheme() {
    const resolved = mode === 'system' ? (system.matches ? 'dark' : 'light') : mode;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
    const menu = document.getElementById('appearance');
    if (!menu) return;
    const summary = menu.querySelector('summary');
    summary.setAttribute('aria-label', `外观：${labels[mode]}`);
    summary.title = `外观：${labels[mode]}`;
    document.getElementById('appearance-icon').innerHTML = icons[mode];
    menu.querySelectorAll('input[name="theme"]').forEach((input) => { input.checked = input.value === mode; });
  }

  applyTheme();
  system.addEventListener('change', () => { if (mode === 'system') applyTheme(); });
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    mode = validMode(event.newValue);
    applyTheme();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const menu = document.getElementById('appearance');
    applyTheme();
    menu.addEventListener('change', (event) => {
      if (event.target.name !== 'theme') return;
      mode = validMode(event.target.value);
      try { localStorage.setItem(storageKey, mode); } catch { /* 保留本次会话的选择。 */ }
      applyTheme();
      menu.open = false;
      menu.querySelector('summary').focus();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!menu.contains(event.target)) menu.open = false;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !menu.open) return;
      event.preventDefault();
      menu.open = false;
      menu.querySelector('summary').focus();
    });
  }, { once: true });
})();
