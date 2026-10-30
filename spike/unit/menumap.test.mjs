import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { screenKey, emptyMap, observe, buildTree, describe, toMarkdown, loadMap, saveMap } from '../menumap.mjs';

const H = 'https://app.test';

test('screenKey: id 조각은 :id, 쿼리는 버리고 해시 라우팅은 붙인다', () => {
  assert.equal(screenKey(`${H}/admin/users/123?tab=1`), 'app.test/admin/users/:id');
  assert.equal(screenKey(`${H}/#/board/9f8e7d6c5b4a39281706?x=1`), 'app.test/#/board/:id');
  assert.equal(screenKey(`${H}/page#section`), 'app.test/page');
});

test('공식 2: 메뉴 클릭·링크·goto 를 길로 남기고, 같은 화면 클릭은 남기지 않는다', () => {
  const m = emptyMap();
  const at = '2026-10-30T00:00:00Z';
  assert.equal(observe(m, { tool: 'click', from: `${H}/dash`, url: `${H}/dash`, menu: ['운영관리'] }, { at }), false);
  observe(m, { tool: 'click', from: `${H}/dash`, url: `${H}/admin/users`, menu: ['운영관리', '사용자 관리'] }, { role: 'ADMIN', at });
  observe(m, { tool: 'click', from: `${H}/x`, url: `${H}/admin/users`, menu: ['운영관리', '사용자 관리'] }, { role: 'MANAGER', at });
  observe(m, { tool: 'click', from: `${H}/admin/users`, url: `${H}/admin/users/7`, label: '상세' }, { at });
  observe(m, { tool: 'goto', url: `${H}/reports` }, { at });
  const u = m.screens['app.test/admin/users'];
  assert.equal(u.via.length, 1);
  assert.deepEqual({ n: u.via[0].n, roles: u.via[0].roles }, { n: 2, roles: { ADMIN: 1, MANAGER: 1 } });
  assert.deepEqual(m.screens['app.test/admin/users/:id'].via[0], { kind: 'link', from: 'app.test/admin/users', action: '상세', n: 1, roles: {}, last: at });
  assert.equal(m.screens['app.test/reports'].via[0].kind, 'direct');
});

test('공식 3·4: 본 메뉴는 미방문 잎, 펼친 그룹 머리는 잎이 아니고 안 펼친 그룹은 잎, 진척', () => {
  const m = emptyMap();
  observe(m, { tool: 'snapshot', url: `${H}/dash`, navItems: [
    { menu: ['운영관리'], group: true },
    { menu: ['운영관리', '사용자 관리'], href: `${H}/admin/users` },
    { menu: ['운영관리', '권한'], href: `${H}/admin/roles` },
    { menu: ['통계'], group: true },
  ] });
  observe(m, { tool: 'click', from: `${H}/dash`, url: `${H}/admin/users`, menu: ['운영관리', '사용자 관리'] });
  const t = buildTree(m);
  assert.deepEqual(t.leaves.map((l) => [l.menu.join('›'), l.visited, !!l.group]), [
    ['운영관리›권한', false, false], ['운영관리›사용자 관리', true, false], ['통계', false, true]]);
  assert.deepEqual(t.progress, { visited: 1, total: 3 });
});

test('describe: AI용 요약(호스트 생략·하위 화면·주소로만·줄 수 제한)', () => {
  const m = emptyMap();
  observe(m, { tool: 'click', from: `${H}/dash`, url: `${H}/admin/users`, menu: ['운영관리', '사용자 관리'] }, { role: 'ADMIN' });
  observe(m, { tool: 'click', from: `${H}/admin/users`, url: `${H}/admin/users/7`, label: '상세' });
  observe(m, { tool: 'goto', url: `${H}/reports` });
  assert.equal(describe(m, { base: 'app.test' }), [
    '진척: 메뉴 1개 중 1개 방문',
    '- 운영관리 › 사용자 관리 → /admin/users (방문 1회 · ADMIN)',
    '  - "상세" 클릭 → /admin/users/:id',
    '- (메뉴 경로 모름, 주소로 들어감) /reports',
  ].join('\n'));
  assert.match(describe(m, { base: 'app.test', limit: 1 }), /… 2줄 더 있음$/);
  assert.equal(describe(emptyMap()), '');
});

test('저장하면 menu.json 과 사람용 menu-map.md 를 함께 쓰고, 깨진 파일은 빈 지도로 읽는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-menumap-'));
  const file = path.join(dir, 'map', 'menu.json');
  const m = emptyMap();
  observe(m, { tool: 'click', from: `${H}/dash`, url: `${H}/admin/users`, menu: ['운영관리', '사용자 관리'] });
  saveMap(file, m);
  assert.deepEqual(loadMap(file).screens, m.screens);
  const md = fs.readFileSync(path.join(dir, 'map', 'menu-map.md'), 'utf8');
  assert.match(md, /- 운영관리\n {2}- ✅ 사용자 관리 → `app.test\/admin\/users` · 1회/);
  assert.equal(md, toMarkdown(m));
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(loadMap(file), emptyMap());
  fs.rmSync(dir, { recursive: true, force: true });
});
