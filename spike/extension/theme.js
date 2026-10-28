// 테마: 시스템 따름 · 밝게 · 어둡게. 고른 값은 이 브라우저에만 기억한다(사용자 편의 설정).
// 화면이 그려지기 전에 적용되도록 <head>에서 불러온다.
const THEMES = [['system', '시스템 따름'], ['light', '밝게'], ['dark', '어둡게']];
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
function savedTheme() { try { return localStorage.getItem('koala-theme') || 'system'; } catch { return 'system'; } }
applyTheme(savedTheme());

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('theme-btn');
  const render = () => {
    const t = savedTheme();
    btn.dataset.theme = t;
    btn.dataset.tip = `테마: ${THEMES.find(([k]) => k === t)[1]}\n누르면 바꿉니다(시스템 따름 → 밝게 → 어둡게)`;
    btn.setAttribute('aria-label', `테마: ${THEMES.find(([k]) => k === t)[1]}`);
  };
  btn.onclick = () => {
    const i = THEMES.findIndex(([k]) => k === savedTheme());
    const next = THEMES[(i + 1) % THEMES.length][0];
    try { localStorage.setItem('koala-theme', next); } catch {}
    applyTheme(next);
    render();
  };
  render();
});
