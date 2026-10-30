// 메뉴 경로 지도: 지나간 메뉴·화면을 세트마다 쌓아 '대상 화면까지 어떤 메뉴를 거쳐 가는지'를 남긴다.
// 공식은 docs/superpowers/specs/2026-10-30-menu-map-design.md (1: 메뉴 경로는 확장 menu.js, 2~4: 여기)
import fs from 'node:fs';
import path from 'node:path';

const SEP = '›';

// 화면 키 K(url): 호스트 + 경로(숫자·긴 hex 조각은 :id). 해시 라우팅(#/…)이면 해시 경로도 붙인다. 쿼리는 버린다
export function screenKey(url) {
  try {
    const u = new URL(url);
    const ids = (p) => p.split('/').map((s) => (/^\d+$|^[0-9a-f-]{16,}$/i.test(s) ? ':id' : s)).join('/');
    const hash = u.hash.startsWith('#/') ? `#${ids(u.hash.slice(1).split('?')[0])}` : '';
    return `${u.host}${ids(u.pathname)}${hash}`;
  } catch { return String(url || ''); }
}

export const emptyMap = () => ({ v: 1, screens: {}, seen: {} });

export function loadMap(file) {
  try { return { ...emptyMap(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return emptyMap(); }
}
export function saveMap(file, map) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 1));
  fs.writeFileSync(path.join(path.dirname(file), 'menu-map.md'), toMarkdown(map));
}

const sameVia = (a, b) => a.kind === b.kind && (a.kind === 'menu' ? a.menu.join(SEP) === b.menu.join(SEP)
  : a.kind === 'link' ? a.from === b.from && a.action === b.action : true);

// 화면에 닿는 길 하나를 더한다(공식 2). 같은 길은 횟수·시각·역할만 늘린다
function addVia(map, key, url, via, { role, title, at }) {
  const s = (map.screens[key] ||= { title: '', url, via: [] });
  s.url = url || s.url;
  if (title) s.title = title;
  let v = s.via.find((x) => sameVia(x, via));
  if (!v) s.via.push((v = { ...via, n: 0, roles: {} }));
  v.n += 1;
  v.last = at;
  if (role) v.roles[role] = (v.roles[role] || 0) + 1;
}

// 도구 한 번의 결과를 지도에 올린다. 바뀌었으면 true
//   click: { tool, from(이전 주소), url(새 주소), menu?(P(e)), label?(name(e)) } · goto: { tool, url } · snapshot: { tool, url, navItems }
export function observe(map, ev, { role = null, at = new Date().toISOString() } = {}) {
  const meta = { role, title: ev.title, at };
  if (ev.tool === 'goto' && ev.url) { addVia(map, screenKey(ev.url), ev.url, { kind: 'direct' }, meta); return true; }
  if (ev.tool === 'click' && ev.url && ev.from) {
    const a = screenKey(ev.from), b = screenKey(ev.url);
    if (a === b) return false; // 그룹 펼치기·같은 화면 안의 클릭
    if (ev.menu?.length) addVia(map, b, ev.url, { kind: 'menu', menu: ev.menu }, meta);
    else addVia(map, b, ev.url, { kind: 'link', from: a, action: ev.label || '' }, meta);
    return true;
  }
  if (ev.tool === 'snapshot' && ev.navItems?.length) {
    let changed = false;
    for (const it of ev.navItems) {
      const k = it.menu.join(SEP);
      const cur = map.seen[k];
      const next = { menu: it.menu, href: it.href, screen: it.href ? screenKey(it.href) : undefined, group: it.group, last: at };
      if (!cur || cur.href !== next.href || cur.group !== next.group) changed = true;
      map.seen[k] = { ...cur, ...next, roles: { ...cur?.roles, ...(role ? { [role]: at } : {}) } };
    }
    return changed;
  }
  return false;
}

const short = (key, base) => (base && key.startsWith(base) ? key.slice(base.length) || '/' : key);
const rolesOf = (v) => Object.keys(v?.roles || {});

// 지도 = 트리(공식 4): 메뉴 잎(방문·미방문), 하위 화면(출발 화면 아래), 주소로만 들어간 화면, 진척
export function buildTree(map) {
  const leaves = new Map(); // 메뉴 경로 → { menu, screen, visited, n, roles, group }
  for (const [key, s] of Object.entries(map.screens)) {
    for (const v of s.via.filter((x) => x.kind === 'menu')) {
      const k = v.menu.join(SEP);
      const cur = leaves.get(k);
      leaves.set(k, { menu: v.menu, screen: key, title: s.title, visited: true, n: (cur?.n || 0) + v.n, roles: [...new Set([...(cur?.roles || []), ...rolesOf(v)])] });
    }
  }
  for (const [k, it] of Object.entries(map.seen)) {
    if (leaves.has(k)) continue;
    // 펼친 그룹 머리는 잎이 아니다(아래 항목이 보이면 그쪽이 잎)
    if (it.group && Object.keys(map.seen).some((o) => o.startsWith(`${k}${SEP}`))) continue;
    const visited = it.screen && map.screens[it.screen];
    leaves.set(k, { menu: it.menu, screen: it.screen, visited: !!visited, n: 0, roles: Object.keys(it.roles || {}), group: it.group });
  }
  const links = []; // 하위 화면: { from, to, action, n }
  const direct = [];
  for (const [key, s] of Object.entries(map.screens)) {
    for (const v of s.via.filter((x) => x.kind === 'link')) links.push({ from: v.from, to: key, action: v.action, n: v.n });
    if (s.via.every((v) => v.kind === 'direct')) direct.push(key);
  }
  const menuLeaves = [...leaves.values()].sort((a, b) => a.menu.join(SEP).localeCompare(b.menu.join(SEP)));
  const done = menuLeaves.filter((l) => l.visited).length;
  return { leaves: menuLeaves, links, direct, progress: { visited: done, total: menuLeaves.length } };
}

// AI에게 줄 요약(최대 limit 줄). base = 세트 주소의 호스트(같으면 경로만 쓴다)
export function describe(map, { base = '', limit = 80 } = {}) {
  const t = buildTree(map);
  if (!t.leaves.length && !t.links.length && !t.direct.length) return '';
  const lines = [];
  const linksFrom = (key) => t.links.filter((l) => l.from === key);
  for (const l of t.leaves) {
    const where = l.screen ? short(l.screen, base) : '(주소 모름)';
    lines.push(`- ${l.menu.join(' › ')}${l.group ? ' (그룹 · 아직 펼쳐 보지 않음)' : ` → ${where} (${l.visited ? `방문 ${l.n || 1}회` : '미방문 · 메뉴에서 봄'}`}${l.roles.length ? ` · ${l.roles.join(', ')}` : ''}${l.group ? '' : ')'}`);
    if (l.visited) for (const k of linksFrom(l.screen)) lines.push(`  - "${k.action}" 클릭 → ${short(k.to, base)}`);
  }
  const shown = new Set(t.leaves.filter((l) => l.visited).map((l) => l.screen));
  for (const k of t.links.filter((x) => !shown.has(x.from))) lines.push(`- ${short(k.from, base)} 에서 "${k.action}" 클릭 → ${short(k.to, base)}`);
  for (const k of t.direct) lines.push(`- (메뉴 경로 모름, 주소로 들어감) ${short(k, base)}`);
  const head = `진척: 메뉴 ${t.progress.total}개 중 ${t.progress.visited}개 방문`;
  return [head, ...lines.slice(0, limit), ...(lines.length > limit ? [`… ${lines.length - limit}줄 더 있음`] : [])].join('\n');
}

// 사람용 지도(menu-map.md): 메뉴 트리 + 하위 화면 + 주소로만
export function toMarkdown(map) {
  const t = buildTree(map);
  const out = ['# 메뉴 경로 지도', '', `진척: 메뉴 ${t.progress.total}개 중 **${t.progress.visited}개 방문**`, '', '## 메뉴', ''];
  const printed = new Set();
  for (const l of t.leaves) {
    l.menu.slice(0, -1).forEach((g, i) => {
      const k = l.menu.slice(0, i + 1).join(SEP);
      if (!printed.has(k)) { printed.add(k); out.push(`${'  '.repeat(i)}- ${g}`); }
    });
    const d = l.menu.length - 1;
    out.push(`${'  '.repeat(d)}- ${l.visited ? '✅' : '⬜'} ${l.menu.at(-1)}${l.group ? ' (그룹 · 펼쳐 보지 않음)' : ` → \`${l.screen || '주소 모름'}\``}${l.n ? ` · ${l.n}회` : ''}${l.roles.length ? ` · ${l.roles.join(', ')}` : ''}`);
    for (const k of t.links.filter((x) => l.visited && x.from === l.screen)) out.push(`${'  '.repeat(d + 1)}- ↳ "${k.action}" → \`${k.to}\``);
  }
  const shown = new Set(t.leaves.filter((l) => l.visited).map((l) => l.screen));
  const rest = t.links.filter((x) => !shown.has(x.from));
  if (rest.length) out.push('', '## 메뉴 밖에서 이어진 화면', '', ...rest.map((k) => `- \`${k.from}\` 에서 "${k.action}" → \`${k.to}\``));
  if (t.direct.length) out.push('', '## 주소로만 들어간 화면', '', ...t.direct.map((k) => `- \`${k}\``));
  return `${out.join('\n')}\n`;
}

