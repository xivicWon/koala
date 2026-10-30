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
  assert.deepEqual(checkUpdate('a', root).changed, ['프로필 v3 → v4', '태그 t v1 → v2']);
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
  // 한글 이름은 영문·숫자가 남지 않아 'set' 으로, 겹치면 -2
  assert.equal(a.id, 'local-set');
  assert.equal(b.id, 'local-set-2');
  assert.equal(createLocalSet({ name: 'QA 세트 2.0' }, root).id, 'local-QA_2.0');
  assert.equal(createLocalSet({ name: '예시 서비스' }, root, 'example').id, 'local-example');
  assert.equal(b.source, 'local');
  assert.equal(domainOfSet(b), 'default');
  assert.equal(checkUpdate(a.id, root), null);
  // 지우면 deleted/ 로 옮긴다(되돌릴 수 있게)
  const gone = deleteSet(a.id, root);
  assert.equal(readSet(a.id, root), null);
  assert.equal(gone.source, 'local');
  assert.ok(fs.existsSync(path.join(gone.trash, 'set.json')));
  assert.ok(gone.trash.startsWith(path.join(root, 'deleted', 'local-set-')));
  // 받지 않은 서버 세트는 지울 것이 없다. 받은 서버 세트는 지우면 다시 '받지 않음'으로 목록에 남는다
  assert.throws(() => deleteSet('a', root), /지울 프로필이 없습니다/);
  receiveSet('a', root);
  assert.equal(deleteSet('a', root).source, 'server');
  assert.equal(listSets(root).find((s) => s.id === 'a').received, false);
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
  // 기본 계정 값(아이디·비밀번호)과 그 키는 목록에 없다
  put('server-accounts/r.yaml', { accounts: { ADMIN: { user: 'admin-user-zz', pass: 'secret-pass-zz' } } });
  receiveSet('a', root);
  const out = JSON.stringify(listSets(root));
  assert.ok(!out.includes('admin-user-zz') && !out.includes('secret-pass-zz'));
  assert.ok(!/"(user|pass)"\s*:/.test(out));
});

test('이 PC 전용 세트 고치기: 고친 칸만 바꾸고 나머지(역할 참조·claude·cleanup·모르는 키)는 보관, 서버 세트는 거절', () => {
  const a = createLocalSet({ name: '내 세트', roles: 'doc-id', knowledge: ['k'], tags: ['t'], extra_key: { keep: 1 },
    profile: { target: { base_url: 'http://localhost:3000', start_url: 'http://localhost:3000/login', login_path: '/login' }, deploy: { url: '' }, prompt: '옛 지식', claude: { model: 'm' }, cleanup: ['x'] } }, root);
  const r = updateLocalSet(a.id, { name: '바꾼 이름', profile: { target: { base_url: 'http://localhost:4000', start_url: '' }, deploy: { url: 'http://127.0.0.1:8765' }, prompt: '새 지식' } }, root);
  assert.equal(r.name, '바꾼 이름');
  const d = readSet(a.id, root).def;
  assert.equal(readSet(a.id, root).id, a.id);
  assert.equal(d.profile.target.base_url, 'http://localhost:4000');
  assert.equal('start_url' in d.profile.target, false);
  assert.equal(d.profile.target.login_path, '/login');
  assert.equal(d.profile.deploy.url, 'http://127.0.0.1:8765');
  assert.equal(d.profile.prompt, '새 지식');
  assert.deepEqual(d.profile.claude, { model: 'm' });
  assert.deepEqual(d.profile.cleanup, ['x']);
  assert.equal(d.roles, 'doc-id');
  assert.deepEqual(d.knowledge, ['k']);
  assert.deepEqual(d.extra_key, { keep: 1 });
  assert.equal(listSets(root).find((s) => s.id === a.id).base_url, 'http://localhost:4000');
  receiveSet('a', root);
  assert.throws(() => updateLocalSet('a', { name: 'x' }, root));
});

test('깨진 세트 YAML·이름과 다른 id 는 목록에서 건너뛰고 알린다(던지지 않는다)', () => {
  fs.mkdirSync(path.join(root, 'store/sets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'store/sets/bad.yaml'), 'id: [깨짐\n  name: :');
  put('store/sets/other.yaml', { id: 'not-other', name: '다른 이름', version: 1 });
  const warns = [];
  const l = listSets(root, (m) => warns.push(m));
  assert.ok(l.some((s) => s.id === 'a'));
  assert.ok(!l.some((s) => s.id === 'not-other'));
  assert.equal(warns.length, 2, warns.join('\n'));
  assert.match(warns.find((w) => w.includes('bad.yaml')), /읽지 못해 건너뜁니다/);
  assert.match(warns.find((w) => w.includes('other.yaml')), /id\(not-other\)가 파일 이름과 달라/);
});

test('받은 세트가 가리키는 문서가 깨지면 checkUpdate 는 바뀐 것으로 알리고 목록은 그대로 나온다', () => {
  receiveSet('a', root);
  fs.writeFileSync(path.join(root, 'store/tags/t.yaml'), 'id: [깨짐');
  assert.deepEqual(checkUpdate('a', root).changed, ['참조 문서를 읽지 못함 tag/t']);
  fs.writeFileSync(path.join(root, 'store/sets/a.yaml'), 'id: [깨짐');
  assert.deepEqual(checkUpdate('a', root).changed, ['참조 문서를 읽지 못함 set/a']);
  const warns = [];
  const l = listSets(root, (m) => warns.push(m));
  assert.equal(l.find((s) => s.id === 'a').received, true);
  assert.ok(warns.some((w) => w.includes('a.yaml')));
});

test('참조 판 가르기: id 안에 @v 가 있어도 마지막 @v 로 가른다', () => {
  put('store/tags/x@vy.yaml'.replace('@', '_'), { id: 'x@vy', kind: 'tag', version: 1 });
  put('store/sets/a.yaml', { ...baseSet, tags: ['x@vy'] });
  assert.equal(receiveSet('a', root).ok, true);
  assert.deepEqual(readSet('a', root).refs.tags, ['x@vy@v1']);
  assert.equal(checkUpdate('a', root), null);
  put('store/tags/x_vy.yaml', { id: 'x@vy', kind: 'tag', version: 2 });
  assert.deepEqual(checkUpdate('a', root).changed, ['태그 x@vy v1 → v2']);
});

test('세트 상세 역할: 정의 맨 위 인라인 역할, 예전 옮기기가 profile 아래 둔 것, 이 PC 전용 세트의 역할 문서 id', () => {
  const top = createLocalSet({ name: '맨 위', roles: [{ key: 'ADMIN', label: '관리자' }, { key: 'MEMBER', label: '회원' }], default_role: 'MEMBER' }, root);
  const under = createLocalSet({ name: '아래', profile: { roles: [{ key: 'U', label: '사용자' }], default_role: 'U' } }, root);
  put('store/roles/doc-roles.yaml', { id: 'doc-roles', kind: 'role', version: 2, default_role: 'B', roles: [{ key: 'A', label: '가', account: { user: 'u', pass: 'pw-zz' } }, { key: 'B', label: '나' }] });
  const ref = createLocalSet({ name: '참조', roles: 'doc-roles' }, root);
  const l = listSets(root, () => {});
  const of = (id) => l.find((s) => s.id === id);
  assert.deepEqual(of(top.id).roles.map((r) => r.key), ['ADMIN', 'MEMBER']);
  assert.equal(of(top.id).default_role, 'MEMBER');
  assert.deepEqual(of(under.id).roles.map((r) => r.key), ['U']);
  assert.equal(of(under.id).default_role, 'U');
  assert.deepEqual(of(ref.id).roles.map((r) => r.key), ['A', 'B']);
  assert.equal(of(ref.id).default_role, 'B');
  assert.ok(!JSON.stringify(l).includes('pw-zz'));
});
