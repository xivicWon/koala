// 페이지 위에 덧씌우는 표시물(대상 강조, 가상 커서, 클릭 파동, 검증 결과).
// pointer-events:none 이라 실제 클릭·hit test에 끼어들지 않고, snapshot에서도 빠진다.
if (!window.__koala) {
  const host = document.createElement('div');
  host.setAttribute('data-koala-overlay', '');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    * { box-sizing: border-box; font-family: system-ui, sans-serif; }
    #box { position: fixed; border: 3px solid; border-radius: 6px; transition: all .15s; display: none; }
    #label { position: fixed; padding: 2px 8px; border-radius: 4px; color: #fff; font-size: 12px; font-weight: 600;
             white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; display: none; }
    #cursor { position: fixed; width: 22px; height: 22px; left: -40px; top: -40px; transition-property: left, top;
              transition-timing-function: cubic-bezier(.4,0,.2,1); filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
    .ripple { position: fixed; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
              border: 3px solid #0969da; animation: rp .5s ease-out forwards; }
    @keyframes rp { to { transform: scale(4); opacity: 0; } }
    #badge { position: fixed; top: 8px; left: 8px; padding: 2px 9px; border-radius: 999px; background: #141414; color: #ffd21f;
             font-size: 12px; font-weight: 700; box-shadow: 0 0 0 2px #ffd21f; display: none; }
    #banner { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); background: rgba(17,24,39,.88);
              color: #fff; font-size: 12px; padding: 4px 12px; border-radius: 999px; display: none; }
  </style>
  <div id="box"></div><div id="label"></div><div id="banner"></div><div id="badge"></div>
  <svg id="cursor" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>`;
  document.documentElement.appendChild(host);
  const $ = (id) => root.getElementById(id);
  const COLORS = { click: '#0969da', type: '#8250df', select: '#8250df', hover: '#0969da', press: '#8250df',
                   read: '#6e7781', ok: '#1a7f37', fail: '#cf222e' };
  let hideTimer;

  window.__koala = {
    show(rect, kind, text, holdMs = 0) {
      clearTimeout(hideTimer);
      const c = COLORS[kind] || '#0969da';
      Object.assign($('box').style, { display: 'block', borderColor: c, background: `${c}14`,
        left: `${rect.x - 4}px`, top: `${rect.y - 4}px`, width: `${rect.w + 8}px`, height: `${rect.h + 8}px` });
      Object.assign($('label').style, { display: text ? 'block' : 'none', background: c,
        left: `${rect.x - 4}px`, top: `${Math.max(0, rect.y - 26)}px` });
      $('label').textContent = text || '';
      if (holdMs) hideTimer = setTimeout(() => this.hide(), holdMs);
    },
    hide() { $('box').style.display = 'none'; $('label').style.display = 'none'; },
    cursor(x, y, ms) {
      $('cursor').style.transitionDuration = `${ms}ms`;
      $('cursor').style.left = `${x - 3}px`;
      $('cursor').style.top = `${y - 2}px`;
    },
    ripple(x, y) {
      const r = document.createElement('div');
      r.className = 'ripple';
      r.style.left = `${x}px`; r.style.top = `${y}px`;
      root.appendChild(r);
      setTimeout(() => r.remove(), 600);
    },
    // 이 탭이 koala 관리 탭 몇 번인지(창을 나란히 놓고 볼 때 구분용)
    badge(text) {
      $('badge').style.display = text ? 'block' : 'none';
      $('badge').textContent = text || '';
    },
    banner(text) {
      $('banner').style.display = text ? 'block' : 'none';
      $('banner').textContent = text || '';
    },
  };
}
