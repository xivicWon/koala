// 서버가 내려주는 태그 문서로 테스트(BDD 시나리오·TDD 케이스)에 태그를 붙이고 검사한다.
//   자동 규칙(auto)은 호스트가 붙이고, 판단 태그(apply_when)는 AI가 제안하며, 사람 몫(assign: human)은 사용자가 붙인다.
import * as sync from './sync.mjs';

export const load = (id = 'qa-tags') => sync.get('tag', id);

// 역할 태그는 서비스마다 달라 서버 공통 태그 문서에 없다. 프로필의 역할 목록으로 '실행 역할' 축을 덧붙인다.
//   시나리오의 as(역할)나 roles(역할별 기대)로 자동으로 붙고, 딸린 케이스가 물려받는다. 여러 역할로 확인한 시나리오는 여럿 붙는다
export function withRoles(doc, roles) {
  if (!doc || !roles?.length || doc.groups?.some((g) => g.id === 'role')) return doc;
  const group = {
    id: 'role', name: '실행 역할', inherit: true, auto_only: true, // AI가 고르지 않는다
    tags: roles.map((r) => ({ id: `@role-${r.key.toLowerCase()}`, description: `${r.label}로 로그인해 수행`,
      auto: { any: [{ field: 'as', equals: r.key }, { field: 'roles', has: r.key }] } })),
  };
  return { ...doc, groups: [...doc.groups, group] };
}

export function index(doc) {
  const byId = new Map();
  for (const g of doc?.groups || []) for (const t of g.tags) byId.set(t.id, { ...t, group: g });
  return byId;
}

const matches = (rule, item) => {
  if (rule.any) return rule.any.some((r) => matches(r, item));
  const v = item[rule.field];
  if ('has' in rule) return !!v && typeof v === 'object' && rule.has in v;
  if (v === undefined) return false;
  return 'equals' in rule ? v === rule.equals : rule.in?.includes(v);
};

// 시나리오가 물려주는 태그(inherit 그룹만)
export const inherited = (doc, scenario) => (scenario?.tags || []).filter((t) => index(doc).get(t)?.group.inherit);

// 자동 태그 + AI 제안(허용된 것만) → 축마다 하나만 규칙 적용(자동 규칙이 우선)
export function assign(doc, item, suggested = []) {
  const byId = index(doc);
  const auto = [...byId.values()].filter((t) => t.auto && matches(t.auto, item)).map((t) => t.id);
  const keepHuman = (item.tags || []).filter((t) => byId.get(t)?.assign === 'human'); // 사람이 붙인 것은 유지
  const ai = suggested.filter((t) => byId.has(t) && byId.get(t).assign !== 'human' && !byId.get(t).group.auto_only);
  const out = [];
  for (const t of [...auto, ...keepHuman, ...ai]) {
    if (out.includes(t)) continue;
    const g = byId.get(t).group;
    if (g.exclusive && out.some((x) => byId.get(x).group.id === g.id)) continue;
    out.push(t);
  }
  return out;
}

// AI에게 줄 태그 안내(사람 몫은 제외)
export function prompt(doc) {
  if (!doc) return '';
  return (doc.groups || []).map((g) => `[${g.name}${g.exclusive ? ' · 하나만' : ''}${g.inherit ? ' · 시나리오에 붙이면 케이스가 물려받음' : ''}]\n${
    g.tags.filter((t) => t.assign !== 'human').map((t) => `- ${t.id}: ${t.description}${t.auto ? ' (자동으로 붙음)' : ''}${t.apply_when ? ` · 붙이는 경우: ${t.apply_when}` : ''}`).join('\n')}`).join('\n');
}
