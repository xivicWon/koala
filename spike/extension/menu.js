// 메뉴 위치 읽기(메뉴 경로 지도). overlay.js 처럼 필요할 때 페이지에 넣는다.
// path(el): 클릭한 메뉴 항목의 위쪽 그룹 이름들 + 자기 이름. 클릭 순서가 아니라 지금 화면 구조로 정한다
// items(): 지금 보이는 메뉴 항목마다 { menu, href, group }
// 공식은 docs/superpowers/specs/2026-10-30-menu-map-design.md
if (!window.__koalaMenu) {
  const ROOT = 'nav, aside, [role=navigation], [role=menu], [role=menubar], [role=tree], [data-testid^="nav-"]';
  const ITEM = 'a[href], button, summary, [role=menuitem], [role=treeitem], [aria-expanded]';
  const LIST = 'ul, ol, [role=group], [role=menu], [role=tree], [class*="items"], [class*="sub"], [class*="children"], [class*="collapse"]';
  const SKIP = 'svg, i, [aria-hidden="true"], [class*="icon"]';
  const vis = (e) => e.offsetParent !== null || e.getClientRects().length > 0;
  const norm = (s) => (s || '').trim().replace(/\s+/g, ' ').slice(0, 40);

  // 자기 글자: 하위 목록·아이콘은 빼고 보이는 글자만
  const own = (e) => {
    let out = '';
    for (const n of e.childNodes) {
      if (n.nodeType === 3) out += ` ${n.textContent}`;
      else if (n.nodeType === 1 && !n.matches(LIST) && !n.matches(SKIP)) out += ` ${own(n)}`;
    }
    return out;
  };
  const name = (e) => norm(e.getAttribute('aria-label') || own(e));

  const HEADING = 'h1, h2, h3, h4, h5, h6, [role=heading], [class*="title"], [class*="header"]';
  // 목록 L 의 그룹 이름: aria-controls 로 가리키는 머리 → aria-label → 글자가 있는 앞쪽 형제.
  // 가장 바깥 목록의 앞쪽 형제는 제목일 때만 쓴다(로고·서비스 이름이 경로에 붙지 않게)
  const head = (L, outer) => {
    if (L.id) {
      const c = document.querySelector(`[aria-controls="${CSS.escape(L.id)}"]`);
      if (c && name(c)) return name(c);
    }
    if (L.getAttribute('aria-label')) return norm(L.getAttribute('aria-label'));
    for (let s = L.previousElementSibling; s; s = s.previousElementSibling) {
      if (!name(s)) continue;
      return !outer || s.matches(HEADING) ? name(s) : '';
    }
    return '';
  };

  const path = (el) => {
    const root = el.closest(ROOT);
    if (!root) return null;
    const item = el.closest(ITEM) || el;
    const lists = [];
    for (let cur = item.parentElement; cur && cur !== root && root.contains(cur); cur = cur.parentElement) if (cur.matches(LIST)) lists.push(cur);
    const out = [name(item)];
    lists.forEach((L, i) => {
      const h = head(L, i === lists.length - 1);
      if (h && h !== out[0]) out.unshift(h);
    });
    return out.filter(Boolean);
  };

  const items = () => {
    const out = [];
    const seen = new Set();
    for (const root of document.querySelectorAll(ROOT)) {
      if (root.parentElement?.closest(ROOT) || !vis(root)) continue; // 안쪽 메뉴 영역은 바깥에서 함께 본다
      for (const e of root.querySelectorAll(ITEM)) {
        if (!vis(e) || e.closest('[data-koala-overlay]')) continue;
        const menu = path(e);
        const key = menu?.join('›');
        if (!menu?.length || seen.has(key)) continue;
        seen.add(key);
        const href = e.matches('a[href]') && !/^(javascript:|#$)/.test(e.getAttribute('href')) ? e.href : undefined;
        const group = e.hasAttribute('aria-expanded') || e.matches('summary') || undefined;
        out.push({ menu, href, group });
        if (out.length >= 200) return out;
      }
    }
    return out;
  };

  window.__koalaMenu = { path, items };
}
