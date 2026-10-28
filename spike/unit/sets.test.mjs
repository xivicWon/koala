import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { safeId, setPaths, readSet, listSets, receiveSet, checkUpdate, createLocalSet, updateLocalSet, deleteSet, domainOfSet } from '../sets.mjs';

let root;
const put = (rel, doc) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, YAML.stringify(doc));
};
const baseSet = { id: 'a', name: '세트 A', version: 3, extra: 1, profile: { target: { base_url: 'https://svc-a.example/x' } }, roles: 'r', tags: ['t'] };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-sets-'));
  put('store/sets/a.yaml', baseSet);
  put('store/roles/r.yaml', { id: 'r', kind: 'role', version: 1, roles: [{ key: 'ADMIN' }] });
  put('store/tags/t.yaml', { id: 't', kind: 'tag', version: 1 });
  put('server-accounts/r.yaml', { accounts: { ADMIN: { user: 'u', pass: 'p' } } });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('받기: 참조 풀기, 계정 0600, 모르는 키 보관', () => {
  const r = receiveSet('a', root);
  assert.equal(r.ok, true);
  const p = setPaths('a', root);
  assert.ok(fs.existsSync(`${p.received}/roles.json`));
  assert.ok(fs.existsSync(`${p.received}/tags/t.json`));
  assert.equal(fs.statSync(`${p.secrets}/accounts.json`).mode & 0o777, 0o600);
  assert.equal(fs.statSync(p.secrets).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${p.secrets}/accounts.json`, 'utf8')), { ADMIN: { user: 'u', pass: 'p' } });
  assert.ok(!fs.readFileSync(`${p.received}/roles.json`, 'utf8').includes('"pass"'));
  const rec = readSet('a', root);
  assert.deepEqual(rec.refs.tags, ['t@v1']);
  assert.equal(rec.refs.roles, 'r@v1');
  assert.equal(rec.def.extra, 1);
  assert.equal(rec.source, 'server');
  assert.ok(!Number.isNaN(Date.parse(rec.received_at)));
  assert.equal(domainOfSet(rec), 'svc-a.example');
});

test('참조가 없으면 아무것도 쓰지 않는다', () => {
  put('store/sets/a.yaml', { ...baseSet, knowledge: ['none'] });
  assert.deepEqual(receiveSet('a', root), { ok: false, missing: ['knowledge/none'] });
  assert.ok(!fs.existsSync(setPaths('a', root).dir));
  assert.ok(!fs.existsSync(path.join(root, 'sets')));
});

test('이미 받은 세트는 실패해도 이전 파일 그대로, 받기는 작업 데이터를 남긴다', () => {
  receiveSet('a', root);
  const p = setPaths('a', root);
  fs.mkdirSync(p.tests, { recursive: true });
  fs.writeFileSync(p.testsFile, '[]');
  put('store/sets/a.yaml', { ...baseSet, version: 4, knowledge: ['none'] });
  assert.equal(receiveSet('a', root).ok, false);
  assert.equal(readSet('a', root).version, 3);
  put('store/sets/a.yaml', { ...baseSet, version: 4 });
  assert.equal(receiveSet('a', root).ok, true);
  assert.equal(readSet('a', root).version, 4);
  assert.equal(fs.readFileSync(p.testsFile, 'utf8'), '[]');
  assert.deepEqual(fs.readdirSync(path.join(root, 'sets')), ['a']);
});

test('새 판 확인: 받기 전에는 스냅숏 그대로', () => {
  receiveSet('a', root);
  assert.equal(checkUpdate('a', root), null);
  put('store/tags/t.yaml', { id: 't', kind: 'tag', version: 2 });
  assert.deepEqual(checkUpdate('a', root).changed, ['태그 t v1 → v2']);
  assert.deepEqual(readSet('a', root).refs.tags, ['t@v1']);
  put('store/sets/a.yaml', { ...baseSet, version: 4 });
  assert.deepEqual(checkUpdate('a', root).changed, ['세트 v3 → v4', '태그 t v1 → v2']);
  const l = listSets(root).find((s) => s.id === 'a');
  assert.equal(l.received, true);
  assert.equal(l.update.to, 4);
});

test('safeId 와 원래 id 보존', () => {
  assert.equal(safeId('서비스A/2.0 점검'), '___A_2.0___');
  assert.equal(safeId(''), 'default');
  const id = '서비스A/2.0 점검';
  put('store/sets/___A_2.0___.yaml', { id, name: 'n', version: 1 });
  assert.equal(receiveSet(id, root).ok, true);
  assert.equal(readSet(id, root).id, id);
});

test('목록: 저장소에만 있는 세트는 받지 않음, 로컬 세트 만들기·지우기', () => {
  const l = listSets(root).find((s) => s.id === 'a');
  assert.equal(l.received, false);
  assert.equal(l.domain, 'svc-a.example');
  const a = createLocalSet({ name: '내 세트', profile: { target: { base_url: 'http://localhost:3000' } } }, root);
  const b = createLocalSet({ name: '내 세트' }, root);
  assert.equal(a.id, 'local-____');
  assert.equal(b.id, 'local-____-2');
  assert.equal(b.source, 'local');
  assert.equal(domainOfSet(b), 'default');
  assert.equal(checkUpdate(a.id, root), null);
  deleteSet(a.id, root);
  assert.equal(readSet(a.id, root), null);
  receiveSet('a', root);
  assert.throws(() => deleteSet('a', root));
  assert.ok(readSet('a', root));
});

test('예시 세트는 공용 저장소의 참조를 모두 찾는다', () => {
  assert.equal(receiveSet('example-set', root).ok, true);
});

test('목록 상세: 받은 세트의 배포 서버·참조 판·역할(기본 계정 유무만)·테스트 수, 비밀번호는 싣지 않음', () => {
  put('store/sets/a.yaml', { ...baseSet, profile: { target: { base_url: 'https://svc-a.example/x', start_url: 'https://svc-a.example/login' }, deploy: { url: 'http://127.0.0.1:8765' }, prompt: '지식' }, knowledge: [] });
  put('store/roles/r.yaml', { id: 'r', kind: 'role', version: 1, default_role: 'ADMIN', roles: [{ key: 'ADMIN', label: '관리자', desc: '모두' }, { key: 'MEMBER', label: '회원' }] });
  receiveSet('a', root);
  const p = setPaths('a', root);
  fs.mkdirSync(p.tests, { recursive: true });
  fs.writeFileSync(p.testsFile, JSON.stringify({ scenarios: [{ id: 'SC-1' }, { id: 'SC-2' }], cases: [{ id: 'TC-1' }] }));
  const l = listSets(root).find((s) => s.id === 'a');
  assert.equal(l.start_url, 'https://svc-a.example/login');
  assert.equal(l.deploy_url, 'http://127.0.0.1:8765');
  assert.equal(l.prompt, '지식');
  assert.deepEqual(l.refs, { roles: 'r@v1', tags: ['t@v1'] });
  assert.equal(l.default_role, 'ADMIN');
  assert.deepEqual(l.roles, [{ key: 'ADMIN', label: '관리자', desc: '모두', has_default: true }, { key: 'MEMBER', label: '회원', desc: '', has_default: false }]);
  assert.deepEqual(l.tests, { scenarios: 2, cases: 1 });
  assert.ok(l.received_at);
  assert.ok(!JSON.stringify(listSets(root)).includes('"p"'));
});

test('이 PC 전용 세트 고치기: 이름·정의를 바꾸고 서버 세트는 거절', () => {
  const a = createLocalSet({ name: '내 세트', profile: { target: { base_url: 'http://localhost:3000' } } }, root);
  const r = updateLocalSet(a.id, { name: '바꾼 이름', profile: { target: { base_url: 'http://localhost:4000' } }, roles: [{ key: 'ADMIN', label: '관리자' }] }, root);
  assert.equal(r.name, '바꾼 이름');
  assert.equal(readSet(a.id, root).def.profile.target.base_url, 'http://localhost:4000');
  assert.equal(readSet(a.id, root).id, a.id);
  const l = listSets(root).find((s) => s.id === a.id);
  assert.equal(l.base_url, 'http://localhost:4000');
  assert.deepEqual(l.roles, [{ key: 'ADMIN', label: '관리자', desc: '', has_default: false }]);
  receiveSet('a', root);
  assert.throws(() => updateLocalSet('a', { name: 'x' }, root));
});
