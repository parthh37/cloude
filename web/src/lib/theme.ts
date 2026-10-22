/** Night is the default instrument mode; Day for sunlight; Auto follows the OS. */
export type ThemePref = 'night' | 'day' | 'auto';

const KEY = 'cloude.theme';
const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: light)') : null;

export function themePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'day' || v === 'auto' ? v : 'night';
}

function apply() {
  const pref = themePref();
  const day = pref === 'day' || (pref === 'auto' && !!media?.matches);
  if (day) document.documentElement.dataset.theme = 'day';
  else delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', day ? '#e8edf2' : '#070b10');
}

export function setThemePref(pref: ThemePref) {
  localStorage.setItem(KEY, pref);
  apply();
  window.dispatchEvent(new Event('cloude:theme'));
}

export function initTheme() {
  apply();
  media?.addEventListener('change', apply);
}
