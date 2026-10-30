// ── 메뉴 경로 지도 보기 ──
// 호스트가 지금 세트의 지도(트리)를 준다(GET /menu-map). 메뉴는 그룹별로 접고 펼치며, 방문 ✓ · 미방문 ○ 로 보인다.
// 공식은 docs/superpowers/specs/2026-10-30-menu-map-design.md
let menuMapData = null; // { set, base, file, tree } | { error }
let menuMapOnlyTodo = false; // 미방문만 보기
async function openMenuMap() {
  menuMapData = null;
  openSheet('menumap');
  try {
    const r = await fetch('http://127.0.0.1:8765/menu-map');
    menuMapData = r.ok ? await r.json() : { error: `호스트가 지도를 주지 못했습니다(${r.status})` };
  } catch { menuMapData = { error: '호스트와 연결되어 있지 않습니다' }; }
  if (sheetMode === 'menumap') renderSheet();
}

function renderMenuMapSheet(body) {
  $('sheet-title').textContent = '메뉴 경로 지도';
  const d = menuMapData;
  if (!d) { body.innerHTML = '<div class="none">불러오는 중…</div>'; return; }
  if (d.error) { body.innerHTML = `<div class="none">${esc(d.error)}</div>`; return; }
  if (!d.set) { body.innerHTML = '<div class="none">세트를 먼저 고르세요</div>'; return; }
  const { leaves, links, direct, progress } = d.tree;
  if (!leaves.length && !links.length && !direct.length) {
    body.innerHTML = '<div class="none">아직 지나간 메뉴가 없습니다.<br>AI가 화면을 조작하면 지나간 메뉴와 화면에 있는 메뉴가 여기에 쌓입니다.</div>';
    return;
  }
  const short = (k) => (k && d.base && k.startsWith(d.base) ? k.slice(d.base.length) || '/' : k);
  const pct = progress.total ? Math.round((progress.visited / progress.total) * 100) : 0;
  const shown = leaves.filter((l) => !menuMapOnlyTodo || !l.visited);

  // 메뉴 경로로 나무를 만든다: { name, kids: Map, leaf }
  const root = { kids: new Map() };
  for (const l of shown) {
    let n = root;
    for (const g of l.menu.slice(0, -1)) {
      if (!n.kids.has(g)) n.kids.set(g, { name: g, kids: new Map() });
      n = n.kids.get(g);
    }
    const last = l.menu.at(-1);
    const node = n.kids.get(last) || { name: last, kids: new Map() };
    node.leaf = l;
    n.kids.set(last, node);
  }
  const count = (n) => [...n.kids.values()].reduce((a, k) => {
    const c = count(k);
    return { v: a.v + c.v + (k.leaf?.visited ? 1 : 0), t: a.t + c.t + (k.leaf ? 1 : 0) };
  }, { v: 0, t: 0 });
  const subLinks = (screen) => links.filter((k) => k.from === screen)
    .map((k) => `<div class="mm-link">↳ "${esc(k.action)}" → <span class="mono">${esc(short(k.to))}</span></div>`).join('');
  const leafRow = (l, name) => `<div class="mm-leaf ${l.visited ? 'on' : ''}" title="${esc(l.menu.join(' › '))}">
      <span class="mm-dot" aria-label="${l.visited ? '방문' : '미방문'}">${l.visited ? '✓' : '○'}</span>
      <span class="mm-name">${esc(name)}</span>
      ${l.group ? '<span class="mm-meta">그룹 · 아직 펼쳐 보지 않음</span>' : `<span class="mono mm-to">${esc(short(l.screen) || '주소 모름')}</span>`}
      ${l.n ? `<span class="mm-meta">${l.n}회</span>` : ''}${l.roles?.length ? `<span class="mm-meta">${esc(l.roles.join(', '))}</span>` : ''}
    </div>${l.visited ? subLinks(l.screen) : ''}`;
  const draw = (n) => [...n.kids.values()].map((k) => {
    if (!k.kids.size) return leafRow(k.leaf, k.name);
    const c = count(k);
    return `<details class="mm-group" open><summary><span class="mm-name">${esc(k.name)}</span><span class="mm-meta">${c.v}/${c.t}</span></summary>
      ${k.leaf ? leafRow(k.leaf, `${k.name} (그룹 머리)`) : ''}<div class="mm-kids">${draw(k)}</div></details>`;
  }).join('');

  const seenScreens = new Set(leaves.filter((l) => l.visited).map((l) => l.screen));
  const rest = links.filter((k) => !seenScreens.has(k.from));
  body.innerHTML = `
    <div class="mm-head">
      <div class="mm-prog"><b>${progress.visited}</b> / ${progress.total} 메뉴 방문 <span class="mm-meta">${pct}%</span></div>
      <div class="mm-bar"><span style="width:${pct}%"></span></div>
      <label class="mm-filter"><input type="checkbox" data-mm="todo" ${menuMapOnlyTodo ? 'checked' : ''}> 미방문만</label>
    </div>
    <div class="mm-tree">${draw(root) || '<div class="none">미방문 메뉴가 없습니다</div>'}</div>
    ${rest.length && !menuMapOnlyTodo ? `<div class="mm-sec">메뉴 밖에서 이어진 화면</div>${rest.map((k) => `<div class="mm-link"><span class="mono">${esc(short(k.from))}</span> 에서 "${esc(k.action)}" → <span class="mono">${esc(short(k.to))}</span></div>`).join('')}` : ''}
    ${direct.length && !menuMapOnlyTodo ? `<div class="mm-sec">주소로만 들어간 화면</div>${direct.map((k) => `<div class="mm-link mono">${esc(short(k))}</div>`).join('')}` : ''}
    <div class="pf-hint mm-file">파일: <span class="mono">${esc(d.file)}</span> (AI는 지시할 때 이 지도의 요약을 받습니다)</div>`;
}
$('sheet-body').addEventListener('change', (e) => {
  if (sheetMode === 'menumap' && e.target.dataset?.mm === 'todo') { menuMapOnlyTodo = e.target.checked; renderSheet(); }
});
