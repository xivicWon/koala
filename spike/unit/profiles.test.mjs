import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setPaths, readSet, listSets, createLocalSet, deleteSet, profileSlug, textFiles, profileFiles, profilesRoot, userDir } from '../sets.mjs';
import { migrateToFolders } from '../migrate-profiles.mjs';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-profiles-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const read = (f) => fs.readFileSync(f, 'utf8');

test('시험 root 를 주면 프로필·사용자 레벨은 그 안에(실제 ~/koala-profiles 를 건드리지 않음)', () => {
  assert.equal(profilesRoot(root), path.join(root, 'profiles'));
  assert.equal(userDir(root), path.join(root, 'user'));
  assert.equal(setPaths('a', root).dir, path.join(root, 'profiles', 'a', '.koala-work'));
  assert.equal(setPaths('a', root).rules, path.join(root, 'profiles', 'a', '.koala', 'rules'));
});

test('새 프로필: 이름에서 폴더 이름을 만들고(겹치면 -2) 기본 파일 틀을 넣는다. 한글 이름은 settings 의 name', () => {
  assert.equal(profileSlug('Shop Staging'), 'shop-staging');
  assert.equal(profileSlug('서비스A 2.0'), 'a-2.0');
  assert.equal(profileSlug('쇼핑몰'), 'profile');
  const a = createLocalSet({ name: '쇼핑몰 스테이징', base_url: 'https://shop.test' }, root);
  const b = createLocalSet({ name: '쇼핑몰 스테이징' }, root);
  assert.deepEqual([a.id, b.id], ['profile', 'profile-2']);
  assert.equal(a.name, '쇼핑몰 스테이징');
  const p = setPaths(a.id, root);
  assert.match(read(path.join(p.folder, 'KOALA.md')), /모두 AI 에게 전달/);
  assert.equal(JSON.parse(read(p.settings)).base_url, 'https://shop.test');
  assert.equal(read(path.join(p.folder, '.gitignore')).trim().split('\n').at(-1), '.koala-work/');
});

test('settings.json → 프로필 모양: 시작 경로는 대상 주소에 붙이고, 역할·태그·보내는 서버를 읽는다', () => {
  const p = setPaths('svc', root);
  put(p.settings, JSON.stringify({ name: '서비스', base_url: 'https://svc.test/', start_path: '/login', deploy_url: 'http://127.0.0.1:8765',
    roles: [{ key: 'ADMIN', label: '관리자' }], default_role: 'ADMIN', tags: { groups: [{ id: 'g' }] } }));
  const r = readSet('svc', root);
  assert.equal(r.name, '서비스');
  assert.deepEqual(r.def.profile.target, { base_url: 'https://svc.test', login_path: '/login', start_url: 'https://svc.test/login' });
  assert.equal(r.def.profile.deploy.url, 'http://127.0.0.1:8765');
  assert.equal(r.def.roles[0].key, 'ADMIN');
  assert.equal(r.def.tags.groups[0].id, 'g');
  assert.equal(readSet('none', root), null);
});

test('목록: 하위 폴더가 곧 프로필(숨김·이름이 맞지 않는 폴더 제외), 직접 만든 폴더에는 기본 틀을 넣는다', () => {
  fs.mkdirSync(path.join(profilesRoot(root), 'hand-made'), { recursive: true });
  fs.mkdirSync(path.join(profilesRoot(root), '.deleted'), { recursive: true });
  fs.mkdirSync(path.join(profilesRoot(root), '한글폴더'), { recursive: true });
  const warns = [];
  const list = listSets(root, (m) => warns.push(m));
  assert.deepEqual(list.map((s) => s.id), ['hand-made']);
  assert.equal(warns.length, 1);
  assert.ok(fs.existsSync(setPaths('hand-made', root).settings));
  assert.equal(list[0].domain, 'default');
});

test('AI 에게 주는 글: .md·.txt 를 하위까지, 숨김 폴더는 .koala 만, node_modules·큰 파일·규칙은 뺀다', () => {
  const f = setPaths('svc', root).folder;
  put(path.join(f, 'KOALA.md'), '#');
  put(path.join(f, 'docs', 'flow.md'), '#');
  put(path.join(f, 'notes.txt'), 'x');
  put(path.join(f, 'shot.png'), 'x');
  put(path.join(f, '.koala', 'extra.md'), '#');
  put(path.join(f, '.koala', 'rules', 'select.md'), '#');
  put(path.join(f, '.koala-work', 'work', 'claude', 'CLAUDE.md'), '#');
  put(path.join(f, '.git', 'x.md'), '#');
  put(path.join(f, 'node_modules', 'x.md'), '#');
  put(path.join(f, 'big.md'), 'x'.repeat(300 * 1024));
  const rel = (list) => list.map((x) => path.relative(f, x));
  assert.deepEqual(rel(textFiles(f, { skip: ['.koala/rules'] })), ['KOALA.md', 'notes.txt', '.koala/extra.md', 'docs/flow.md']);
  put(path.join(userDir(root), 'KOALA.md'), '#');
  put(path.join(userDir(root), 'rules', 'r.md'), '#');
  const layers = profileFiles('svc', root);
  assert.match(layers.koala[0], /prompts\/qa-common\.md$/);
  assert.deepEqual(layers.user.map((x) => path.basename(x)), ['KOALA.md']);
  assert.equal(layers.project.length, 4);
});

test('지우기: 폴더째(정의·규칙·작업 데이터) .deleted/ 로 옮기고 목록에서 빠진다', () => {
  const a = createLocalSet({ name: 'a' }, root);
  put(path.join(setPaths(a.id, root).dir, 'tests', 'tests.json'), '{}');
  const gone = deleteSet(a.id, root);
  assert.ok(gone.trash.startsWith(path.join(profilesRoot(root), '.deleted', 'a-')));
  assert.ok(fs.existsSync(path.join(gone.trash, '.koala-work', 'tests', 'tests.json')));
  assert.deepEqual(listSets(root), []);
  assert.throws(() => deleteSet(a.id, root), /지울 프로필이 없습니다/);
});

test('옛 프로필 옮기기: 글은 KOALA.md·knowledge/, 값은 settings.json, 작업 데이터·규칙은 복사, 원본은 그대로, 두 번째는 건너뜀', () => {
  const old = path.join(root, 'sets', 'svc');
  put(path.join(old, 'set.json'), JSON.stringify({ id: 'svc', name: '서비스 목업', version: 6, source: 'server',
    def: { profile: { target: { base_url: 'http://svc.test', login_path: '/login' }, prompt: '- 로그인은 /login', cleanup: [{ name: 'c' }], deploy: { url: 'http://127.0.0.1:8765' } },
      knowledge: ['qa-common', 'svc-k'], tags: 'svc-tags', roles: 'svc-roles' } }));
  put(path.join(old, 'received', 'roles.json'), JSON.stringify({ roles: [{ key: 'ADMIN', label: '관리자', account: { user: 'x' } }], default_role: 'ADMIN' }));
  put(path.join(old, 'received', 'knowledge', 'svc-k.json'), JSON.stringify({ id: 'svc-k', files: { 'SITE.md': '# 사이트' } }));
  put(path.join(old, 'received', 'knowledge', 'qa-common.json'), JSON.stringify({ id: 'qa-common', files: { 'QA.md': '# 공통' } }));
  put(path.join(old, 'received', 'tags', 'svc-tags.json'), JSON.stringify({ id: 'svc-tags', version: 1, groups: [{ id: 'area' }] }));
  put(path.join(old, 'tests', 'tests.json'), JSON.stringify({ id: 'svc', scenarios: [{ id: 'SC-1' }], cases: [] }));
  put(path.join(old, 'work', 'state.json'), '{}');
  put(path.join(old, 'work', 'claude', 'CLAUDE.md'), 'old');
  put(path.join(old, 'map', 'menu.json'), '{}');
  put(path.join(old, 'secrets', 'accounts.json'), '{"ADMIN":{"user":"u","pass":"p"}}');
  put(path.join(old, 'rules', 'select.md'), '# 셀렉트');

  assert.deepEqual(migrateToFolders(root), ['svc']);
  const p = setPaths('svc', root);
  assert.match(read(path.join(p.folder, 'KOALA.md')), /# 서비스 목업[\s\S]*- 로그인은 \/login/);
  assert.equal(read(path.join(p.folder, 'knowledge', 'svc-k', 'SITE.md')), '# 사이트');
  assert.ok(!fs.existsSync(path.join(p.folder, 'knowledge', 'qa-common'))); // koala 기본 파일이 됨
  const st = JSON.parse(read(p.settings));
  assert.deepEqual({ name: st.name, base_url: st.base_url, start_path: st.start_path, deploy_url: st.deploy_url, default_role: st.default_role },
    { name: '서비스 목업', base_url: 'http://svc.test', start_path: '/login', deploy_url: 'http://127.0.0.1:8765', default_role: 'ADMIN' });
  assert.deepEqual(st.roles, [{ key: 'ADMIN', label: '관리자' }]); // 계정은 빠진다
  assert.equal(st.tags.groups[0].id, 'area');
  assert.equal(JSON.parse(read(p.testsFile)).scenarios[0].id, 'SC-1');
  assert.ok(fs.existsSync(path.join(p.dir, 'map', 'menu.json')));
  assert.ok(!fs.existsSync(path.join(p.claude, 'CLAUDE.md'))); // 작업 폴더는 새로 만든다
  assert.equal(read(path.join(p.rules, 'select.md')), '# 셀렉트');
  assert.equal(fs.statSync(path.join(p.secrets, 'accounts.json')).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(old, 'set.json'))); // 원본은 그대로
  assert.ok(fs.existsSync(path.join(userDir(root), 'KOALA.md'))); // 사용자 레벨 틀
  assert.equal(readSet('svc', root).def.profile.target.start_url, 'http://svc.test/login');
  assert.deepEqual(migrateToFolders(root), []);
});
