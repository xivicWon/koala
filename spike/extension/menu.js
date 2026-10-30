// 메뉴 위치 읽기(메뉴 경로 지도). overlay.js 처럼 필요할 때 페이지에 넣는다.
// path(el): 클릭한 메뉴 항목의 위쪽 그룹 이름들 + 자기 이름. 클릭 순서가 아니라 지금 화면 구조로 정한다
// items(): 메뉴 항목마다 { menu, href, group, hidden } (접힌 그룹 안의 숨은 항목 포함)
// 공식은 docs/superpowers/specs/2026-10-30-menu-map-design.md
if (!window.__koalaMenu) {
  const ROOT = 'nav, aside, [role=navigation], [role=menu], [role=menubar], [role=tree], [data-testid^="nav-"]';
  const ITEM = 'a[href], button, summary, [role=menuitem], [role=treeitem], [aria-expanded]';
  const LIST = 'ul, ol, [role=group], [role=menu], [role=tree], [class*="items"], [class*="sub"], [class*="children"], [class*="collapse"]';
  const SKIP = 'svg, i, img, [aria-hidden="true"], [class*="icon"], [class*="badge"], [class*="count"]';
  // 본문의 페이지 넘김·이동 경로 표시는 메뉴가 아니다
  const NOT_MENU = '[class*="pagination"], [class*="breadcrumb"], [aria-label*="page" i], [aria-label*="페이지"]';
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

  // 메뉴 영역: 가장 바깥 것(testid 가 nav- 로 시작하는 항목·그룹이 겹쳐 있어도 메뉴 전체를 본다)
  const rootOf = (el) => {
    let root = null;
    for (let cur = el.closest(ROOT); cur; cur = cur.parentElement?.closest(ROOT)) root = cur;
    return root && !root.matches(NOT_MENU) ? root : null;
  };

  const path = (el) => {
    const root = rootOf(el);
    if (!root) return null;
    const item = el.closest(ITEM) || el;
    const lists = [];
    for (let cur = item.parentElement; cur && cur !== root && root.contains(cur); cur = cur.parentElement) if (cur.matches(LIST)) lists.push(cur);
    const out = [name(item)];
    lists.forEach((L, i) => {
      const h = head(L, i === lists.length - 1);
      if (h) out.unshift(h); // 그룹과 항목 이름이 같아도 줄이지 않는다(컴플라이언스 › 컴플라이언스 같은 메뉴가 있다)
    });
    return out.filter(Boolean);
  };

  // 보이는 메뉴 영역의 항목 전부. 접힌 그룹 안(숨김)도 DOM 에 있으면 함께 읽는다(펼치지 않아도 지도에 오른다).
  // 그룹 머리: 하위 목록 바로 앞의 형제(버튼·aria-expanded 가 아니어도)
  const items = () => {
    const out = [];
    const seen = new Set();
    const add = (e, group) => {
      const menu = path(e);
      const key = menu?.join('›');
      if (!menu?.length || seen.has(key)) return;
      seen.add(key);
      const href = e.matches('a[href]') && !/^(javascript:|#$)/.test(e.getAttribute('href')) ? e.href : undefined;
      out.push({ menu, href, group: group || e.hasAttribute('aria-expanded') || e.matches('summary') || undefined, hidden: !vis(e) || undefined });
    };
    for (const root of document.querySelectorAll(ROOT)) {
      if (rootOf(root) !== root || !vis(root)) continue; // 안쪽 메뉴 영역은 바깥에서 함께 본다
      for (const L of root.querySelectorAll(LIST)) {
        const h = L.previousElementSibling;
        const up = L.parentElement?.closest(LIST);
        if (!h || h.matches(LIST) || !head(L, !up || !root.contains(up))) continue; // 바깥 목록 앞의 로고 등은 그룹이 아니다
        add(h.closest(ITEM) && root.contains(h.closest(ITEM)) ? h.closest(ITEM) : h, true);
      }
      for (const e of root.querySelectorAll(ITEM)) {
        if (e.closest('[data-koala-overlay]')) continue;
        add(e);
        if (out.length >= 300) return out;
      }
    }
    return out;
  };

  window.__koalaMenu = { path, items };
}
