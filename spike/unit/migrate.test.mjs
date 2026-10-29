import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { planMigration, applyMigration } from '../migrate-sets.mjs';
import { setPaths, readSet, listSets } from '../sets.mjs';
import { loadTests } from '../testlist.mjs';

let root, spikeDir;
const put = (base, rel, body) => {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
};
const putYaml = (base, rel, doc) => put(base, rel, YAML.stringify(doc));
const read = (f) => fs.readFileSync(f, 'utf8');
const json = (f) => JSON.parse(read(f));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const archive = () => path.join(root, `migrated-${today()}`);
// 폴더 안 모든 파일의 상대 경로 → 내용
const tree = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = read(f);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};

const profA = { id: 'pa', name: '프로필 A', version: 4, target: { base_url: 'https://site-a.test', start_url: 'https://site-a.test/login' }, deploy: { url: '' }, prompt: 'A 안내', default_role: 'ADMIN' };
const profB = { id: 'pb', name: '프로필 B', version: 1, target: { base_url: 'https://site-a.test' } };
const suite = { id: 'pa--s1', name: '묶음', scenarios: [{ id: 'SC-1', title: '로그인' }], cases: [], flow: [], coverage: [], code: { file: 'tests/suites/site-a.test/pa--s1.spec.ts', source: "import { cleanup } from '../../support/cleanup';\n" } };
const input = (extra = {}) => ({
  root, spikeDir,
  profiles: { pa: { data: profA }, pb: { data: profB } },
  activeId: 'pb',
  extSuites: { 'site-a.test': { suite, suiteBase: 2, suiteApplied: true } },
  extTimelines: ['site-a.test'],
  ...extra,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-mig-root-'));
  spikeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-mig-spike-'));
  const b = 'domains/site-a.test';
  put(root, 'state.json', { domain: 'site-a.test', aliasSeq: 3 });
  put(root, `${b}/state.json`, { domain: 'site-a.test', sessionId: 'sess-1', sessionAlias: 'kaa-3', steps: [{ action: 'goto' }], curScreen: null, lastStamp: null, actor: 'ADMIN', savedAt: 'x' });
  put(root, `${b}/recording.json`, [{ action: 'goto' }]);
  put(root, `${b}/recordings/x.json`, [{ action: 'click' }]);
  put(root, `${b}/drafts/d.json`, { id: 'pa--old' });
  put(root, `${b}/logs/2026-10-29.jsonl`, '{"k":"sys"}\n');
  put(spikeDir, 'tests/suites/site-a.test/pa--s1.spec.ts', "import { cleanup } from '../../support/cleanup';\ntest('x', () => {});\n");
  putYaml(root, 'store/profiles/pa.yaml', { ...profA, kind: 'profile' });
  putYaml(root, 'store/profiles/pb.yaml', { ...profB, kind: 'profile' });
});
afterEach(() => {
  for (const d of [root, spikeDir]) {
    try { fs.chmodSync(path.join(d, 'sets'), 0o755); } catch {}
    try { fs.chmodSync(path.join(d, `migrated-${today()}`), 0o755); } catch {}
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('계획: 묶음은 접두 프로필 세트로, 수행 기록·타임라인은 활성 프로필 세트로', () => {
  const plan = planMigration(input());
  assert.deepEqual(plan.setByProfile, { pa: 'pa', pb: 'pb' });
  assert.deepEqual(plan.timelineKeys, { 'site-a.test': 'pb' });
  assert.equal(plan.archive, archive());
  const pa = plan.sets.find((s) => s.setId === 'pa');
  const pb = plan.sets.find((s) => s.setId === 'pb');
  assert.equal(pa.source, 'server');
  assert.equal(pa.domain, 'site-a.test');
  assert.equal(pa.suite.id, 'pa'); // 세트는 세트 id로 v1부터 새로 보낸다
  assert.equal(pa.suite.applied, true);
  assert.equal(pa.suite.base_version, 0);
  assert.equal(pb.suite, undefined);
  assert.deepEqual(plan.skipped, []);
  // 계획만으로는 디스크가 바뀌지 않는다
  assert.ok(!fs.existsSync(path.join(root, 'sets')));
  assert.ok(!fs.existsSync(path.join(root, 'store/sets')));
});

test('적용: 세트 자리로 옮기고 원본은 보관 폴더로', () => {
  const r = applyMigration(planMigration(input()));
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.ok(r.moved > 0);
  const pa = setPaths('pa', root);
  const pb = setPaths('pb', root);

  // 서버 프로필 → 서버 흉내 세트 정의 → 받기
  const def = YAML.parse(read(path.join(root, 'store/sets/pa.yaml')));
  assert.equal(def.version, 4);
  assert.equal(def.profile.target.base_url, 'https://site-a.test');
  assert.equal(def.default_role, 'ADMIN'); // 기본 역할은 호스트·세트 상세가 읽는 정의 맨 위
  assert.equal(def.profile.default_role, undefined);
  assert.equal(def.profile.prompt, 'A 안내');
  assert.equal(readSet('pa', root).source, 'server');
  assert.equal(readSet('pb', root).source, 'server');

  // 묶음·코드는 pa
  const t = loadTests('pa', root);
  assert.equal(t.id, 'pa');
  assert.equal(t.applied, true);
  assert.equal(t.base_version, 0);
  assert.equal(t.code.file, path.relative(spikeDir, `${pa.code}/pa.spec.ts`));
  assert.equal(t.code.source, "import { cleanup } from '@support/cleanup';\n");
  assert.equal(read(`${pa.code}/pa.spec.ts`), "import { cleanup } from '@support/cleanup';\ntest('x', () => {});\n");
  assert.ok(!fs.existsSync(pb.testsFile));

  // 수행 기록·세션·로그는 pb
  const st = json(pb.state);
  assert.equal(st.domain, undefined);
  assert.equal(st.sessionId, 'sess-1');
  assert.deepEqual(json(`${pb.work}/recording.json`), [{ action: 'goto' }]);
  assert.deepEqual(json(`${pb.recordings}/x.json`), [{ action: 'click' }]);
  assert.equal(read(`${pb.logs}/2026-10-29.jsonl`), '{"k":"sys"}\n');
  assert.ok(!fs.existsSync(pa.state));
  assert.ok(!fs.existsSync(`${pa.work}/recording.json`));

  // 초안은 보관만
  assert.ok(fs.existsSync(path.join(archive(), 'domains/site-a.test/drafts/d.json')));
  assert.ok(!Object.keys(tree(path.join(root, 'sets'))).some((f) => f.includes('drafts') || f.endsWith('d.json')));

  // 원본은 보관 폴더로 옮겨졌다
  assert.ok(!fs.existsSync(path.join(root, 'domains')));
  assert.ok(!fs.existsSync(path.join(spikeDir, 'tests/suites')));
  assert.equal(read(path.join(archive(), 'tests/suites/site-a.test/pa--s1.spec.ts')), "import { cleanup } from '../../support/cleanup';\ntest('x', () => {});\n");
  assert.deepEqual(json(path.join(archive(), 'domains/site-a.test/recording.json')), [{ action: 'goto' }]);
  // 프로필 문서·서비스 상태는 그대로
  assert.ok(fs.existsSync(path.join(root, 'store/profiles/pa.yaml')));
  assert.ok(fs.existsSync(path.join(root, 'state.json')));

  const done = json(path.join(root, 'sets/.migrated'));
  assert.deepEqual(done.setByProfile, { pa: 'pa', pb: 'pb' });
  assert.equal(done.archive, archive());
});

test('두 번째 적용은 아무것도 하지 않는다', () => {
  applyMigration(planMigration(input()));
  const before = { sets: tree(path.join(root, 'sets')), arc: tree(archive()) };
  const r = applyMigration(planMigration(input()));
  assert.deepEqual(r, { ok: true, moved: 0, errors: [] });
  assert.deepEqual({ sets: tree(path.join(root, 'sets')), arc: tree(archive()) }, before);
});

test('이 PC 전용 프로필은 이 PC 전용 세트가 된다', () => {
  const local = { id: 'local-x', name: '로컬 X', target: { base_url: 'https://site-b.test' }, accounts: { ADMIN: { user: 'u', pass: 'secret-pw-1' } } };
  const plan = planMigration(input({ profiles: { pa: { data: profA }, pb: { data: profB }, 'local-x': { local: true, data: local } }, extTimelines: ['site-a.test', 'site-b.test'] }));
  const s = plan.sets.find((x) => x.fromProfile === 'local-x');
  assert.equal(s.source, 'local');
  assert.equal(s.domain, 'site-b.test');
  assert.equal(plan.setByProfile['local-x'], s.setId);
  assert.equal(plan.timelineKeys['site-b.test'], s.setId);
  const r = applyMigration(plan);
  assert.equal(r.ok, true, r.errors.join());
  const rec = readSet(s.setId, root);
  assert.equal(rec.source, 'local');
  assert.equal(rec.def.profile.target.base_url, 'https://site-b.test');
  // 계정 비밀번호는 세트·결과 어디에도 남지 않는다
  const all = JSON.stringify(tree(path.join(root, 'sets'))) + JSON.stringify(tree(path.join(root, 'store')));
  assert.ok(!all.includes('secret-pw-1'));
});

test('중간에 실패하면 원본이 남고 .migrated 가 없다 · 고친 뒤 다시 돌리면 같은 결과', () => {
  const local = { id: 'local-x', name: '로컬 X', target: { base_url: 'https://site-b.test' } };
  const args = input({ profiles: { pa: { data: profA }, pb: { data: profB }, 'local-x': { local: true, data: local } } });
  const originals = { domains: tree(path.join(root, 'domains')), suites: tree(path.join(spikeDir, 'tests/suites')) };

  // 보관 폴더를 쓸 수 없게: 세트 복사까지는 되고 원본 보관에서 실패
  fs.mkdirSync(archive());
  fs.chmodSync(archive(), 0o500);
  const plan1 = planMigration(args);
  const r = applyMigration(plan1);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length);
  assert.ok(!fs.existsSync(path.join(root, 'sets/.migrated')));
  assert.deepEqual({ domains: tree(path.join(root, 'domains')), suites: tree(path.join(spikeDir, 'tests/suites')) }, originals);

  // 고친 뒤: 이미 만든 이 PC 전용 세트를 다시 쓴다(local-…-2 가 생기지 않는다)
  fs.chmodSync(archive(), 0o755);
  const plan2 = planMigration(args);
  assert.deepEqual(plan2.setByProfile, plan1.setByProfile);
  const r2 = applyMigration(plan2);
  assert.equal(r2.ok, true, r2.errors.join());
  assert.deepEqual(fs.readdirSync(path.join(root, 'sets')).sort(), ['.migrated', 'local-X', 'pa', 'pb'].sort());
  assert.equal(json(setPaths('pb', root).state).sessionId, 'sess-1');
  assert.ok(!fs.existsSync(path.join(root, 'domains')));
});

test('세트 폴더를 만들 수 없으면 원본이 남고 .migrated 가 없다', () => {
  fs.mkdirSync(path.join(root, 'sets'));
  fs.chmodSync(path.join(root, 'sets'), 0o500);
  const before = tree(path.join(root, 'domains'));
  const r = applyMigration(planMigration(input()));
  assert.equal(r.ok, false);
  assert.equal(r.moved, 0);
  assert.deepEqual(tree(path.join(root, 'domains')), before);
  assert.ok(fs.existsSync(path.join(spikeDir, 'tests/suites/site-a.test/pa--s1.spec.ts')));
  assert.ok(!fs.existsSync(path.join(root, 'sets/.migrated')));
});

test('공용 예시를 가리던 qa-tags 사본은 <세트>-tags 로 세트마다 복사해 참조한다', () => {
  const tagDoc = (desc) => ({ id: 'qa-tags', kind: 'tag', version: 1, name: 'QA 태그', description: desc, groups: [] });
  putYaml(spikeDir, 'store/tags/qa-tags.yaml', tagDoc('공용'));
  putYaml(root, 'store/tags/qa-tags.yaml', tagDoc('이 서비스에 맞게 고침'));
  putYaml(root, 'store/profiles/pa.yaml', { ...profA, kind: 'profile', tags: 'qa-tags' });
  const plan = planMigration(input());
  const r = applyMigration(plan);
  assert.equal(r.ok, true, r.errors.join());
  const copy = YAML.parse(read(path.join(root, 'store/tags/pa-tags.yaml')));
  assert.equal(copy.id, 'pa-tags');
  assert.equal(copy.description, '이 서비스에 맞게 고침');
  assert.deepEqual(YAML.parse(read(path.join(root, 'store/sets/pa.yaml'))).tags, 'pa-tags');
  assert.deepEqual(readSet('pa', root).refs.tags, ['pa-tags@v1']);
  // pb 는 태그를 참조하지 않았으므로 사본이 없다
  assert.ok(!fs.existsSync(path.join(root, 'store/tags/pb-tags.yaml')));
  // 가리던 사본은 보관 폴더로
  assert.ok(!fs.existsSync(path.join(root, 'store/tags/qa-tags.yaml')));
  assert.ok(fs.existsSync(path.join(archive(), 'store/tags/qa-tags.yaml')));
});

test('같은 내용의 qa-tags 사본이면 이름을 바꾸지 않는다', () => {
  const tagDoc = { id: 'qa-tags', kind: 'tag', version: 1, name: 'QA 태그', groups: [] };
  putYaml(spikeDir, 'store/tags/qa-tags.yaml', tagDoc);
  putYaml(root, 'store/tags/qa-tags.yaml', tagDoc);
  putYaml(root, 'store/profiles/pa.yaml', { ...profA, kind: 'profile', tags: ['qa-tags'] });
  const plan = planMigration(input());
  assert.deepEqual(plan.sets.find((s) => s.setId === 'pa').def.tags, ['qa-tags']);
});

test('default 버킷: 활성 프로필이 있으면 그 세트로, 없으면 건너뛰고 보관', () => {
  put(root, 'domains/default/recording.json', [{ action: 'default' }]);
  const plan = planMigration(input({ activeId: 'pa' }));
  // 활성이 pa 이므로 site-a.test 수행 기록도 pa. default 버킷의 recording.json 은 같은 자리를 다투므로 건너뛴다
  assert.equal(plan.timelineKeys['site-a.test'], 'pa');
  assert.ok(plan.skipped.includes('domains/default/recording.json'));

  const plan2 = planMigration(input({ activeId: null, extTimelines: ['site-a.test', 'default'] }));
  assert.ok(plan2.skipped.includes('domains/default'));
  assert.ok(plan2.skipped.includes('timeline@default'));
  assert.equal(plan2.timelineKeys['site-a.test'], 'pa'); // 활성 없음 → 그 도메인 프로필 중 id 순 첫 번째
  const r = applyMigration(plan2);
  assert.equal(r.ok, true, r.errors.join());
  assert.deepEqual(json(path.join(archive(), 'domains/default/recording.json')), [{ action: 'default' }]);

  // 활성 프로필은 다른 도메인, default 버킷만 있을 때
  fs.rmSync(path.join(root, 'sets'), { recursive: true });
  put(root, 'domains/default/recording.json', [{ action: 'default' }]);
  const plan3 = planMigration({ root, spikeDir, profiles: { pa: { data: profA } }, activeId: 'pa', extSuites: {}, extTimelines: [] });
  const pa = plan3.sets.find((s) => s.setId === 'pa');
  assert.ok(pa.moves.some((m) => m.from === path.join(root, 'domains/default/recording.json')));
});

test('예전 위치의 코드(tests/suites/<id>.spec.ts)와 감싸지 않은 묶음', () => {
  fs.rmSync(path.join(spikeDir, 'tests/suites/site-a.test'), { recursive: true });
  put(spikeDir, 'tests/suites/pb--abcd1234.spec.ts', "import { a } from '../support/cleanup';\n");
  const plain = { id: 'pb--abcd1234', scenarios: [], cases: [], code: null };
  const plan = planMigration(input({ extSuites: { 'site-a.test': plain } }));
  const pb = plan.sets.find((s) => s.setId === 'pb');
  assert.equal(pb.suite.applied, false);
  assert.equal(pb.suite.base_version, 0);
  const r = applyMigration(plan);
  assert.equal(r.ok, true, r.errors.join());
  assert.equal(read(`${setPaths('pb', root).code}/pb.spec.ts`), "import { a } from '@support/cleanup';\n");
  assert.ok(fs.existsSync(path.join(archive(), 'tests/suites/pb--abcd1234.spec.ts')));
});

test('공용 예시를 가리던 프로필 사본은 이 PC 전용 세트가 된다', () => {
  const ex = { id: 'example', kind: 'profile', name: '예시 서비스', version: 1, target: { base_url: 'http://localhost:3000' } };
  putYaml(spikeDir, 'store/profiles/example.yaml', ex);
  putYaml(root, 'store/profiles/example.yaml', { ...ex, target: { base_url: 'https://svc-a.example' } });
  const plan = planMigration({ root, spikeDir, profiles: { example: { data: ex } }, activeId: 'example', extSuites: {}, extTimelines: [] });
  const s = plan.sets[0];
  assert.equal(s.source, 'local');
  assert.equal(s.domain, 'svc-a.example');
  assert.notEqual(s.setId, 'example');
});

test('.migrated 를 쓰지 못하면 치운 원본을 제자리로 되돌린다', () => {
  const before = { domains: tree(path.join(root, 'domains')), suites: tree(path.join(spikeDir, 'tests/suites')) };
  // 결과 파일의 임시 경로를 폴더로 막아 둔다
  fs.mkdirSync(path.join(root, `sets/.migrated.${process.pid}.tmp`), { recursive: true });
  const r = applyMigration(planMigration(input()));
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(path.join(root, 'sets/.migrated')));
  assert.deepEqual({ domains: tree(path.join(root, 'domains')), suites: tree(path.join(spikeDir, 'tests/suites')) }, before);
  assert.ok(!fs.readdirSync(root).some((f) => f.includes('.migrating-')));
});

test('인라인 역할의 계정 비밀번호는 세트 정의 어디에도 남지 않는다', () => {
  putYaml(root, 'store/profiles/pa.yaml', { ...profA, kind: 'profile', roles: [{ key: 'ADMIN', name: '관리자', account: { user: 'u', pass: 'secret-xyz' } }] });
  const local = { id: 'local-y', name: 'Y', target: { base_url: 'https://site-c.test' }, roles: [{ key: 'U', accounts: [{ password: 'secret-xyz' }] }] };
  const r = applyMigration(planMigration(input({ profiles: { pa: { data: profA }, pb: { data: profB }, 'local-y': { local: true, data: local } } })));
  assert.equal(r.ok, true, r.errors.join());
  assert.deepEqual(readSet('pa', root).def.roles, [{ key: 'ADMIN', name: '관리자' }]);
  assert.equal(readSet('pa', root).def.profile.roles, undefined);
  const all = JSON.stringify(tree(path.join(root, 'sets'))) + JSON.stringify(tree(path.join(root, 'store/sets')));
  assert.ok(!all.includes('secret-xyz'));
});

test('저장소에 없는 참조 문서는 정의에서 빼고 표시한다 · 세트 받기는 성공', () => {
  putYaml(root, 'store/knowledges/k1.yaml', { id: 'k1', kind: 'knowledge', version: 1 });
  putYaml(root, 'store/profiles/pa.yaml', { ...profA, kind: 'profile', roles: 'no-roles', knowledge: ['k1', 'no-k'], tags: 'no-tags' });
  const plan = planMigration(input());
  const pa = plan.sets.find((s) => s.setId === 'pa');
  assert.deepEqual(pa.def.migration_missing, ['role/no-roles', 'knowledge/no-k', 'tag/no-tags']);
  assert.deepEqual(pa.def.knowledge, ['k1']);
  assert.equal(pa.def.roles, undefined);
  assert.equal(pa.def.tags, undefined);
  assert.ok(plan.skipped.includes('pa: 참조 문서 없음 knowledge/no-k'));
  const r = applyMigration(plan);
  assert.equal(r.ok, true, r.errors.join());
  const rec = readSet('pa', root);
  assert.deepEqual(rec.refs.knowledge, ['k1@v1']);
  assert.deepEqual(rec.def.migration_missing, ['role/no-roles', 'knowledge/no-k', 'tag/no-tags']);
});

test('손상된 도메인 state.json 은 보관만 하고 세트는 빈 상태로 시작한다', () => {
  put(root, 'domains/site-a.test/state.json', '{ 깨짐');
  const plan = planMigration(input());
  assert.ok(plan.skipped.some((x) => x.startsWith('domains/site-a.test/state.json')));
  const r = applyMigration(plan);
  assert.equal(r.ok, true, r.errors.join());
  assert.ok(!fs.existsSync(setPaths('pb', root).state));
  assert.ok(fs.existsSync(`${setPaths('pb', root).work}/recording.json`));
  assert.equal(read(path.join(archive(), 'domains/site-a.test/state.json')), '{ 깨짐');
});

test('앞선 실행이 치우다 멈춘 <이름>.migrating-<pid> 는 원본으로 다시 옮기고 남기지 않는다', () => {
  fs.renameSync(path.join(root, 'domains'), path.join(root, 'domains.migrating-123'));
  fs.renameSync(path.join(spikeDir, 'tests/suites'), path.join(spikeDir, 'tests/suites.migrating-123'));
  const r = applyMigration(planMigration(input()));
  assert.equal(r.ok, true, r.errors.join());
  assert.ok(!fs.readdirSync(root).some((f) => f.includes('.migrating-')));
  assert.ok(!fs.readdirSync(path.join(spikeDir, 'tests')).some((f) => f.includes('.migrating-')));
  assert.equal(json(setPaths('pb', root).state).sessionId, 'sess-1');
  assert.ok(fs.existsSync(`${setPaths('pa', root).code}/pa.spec.ts`));
  assert.ok(fs.existsSync(path.join(archive(), 'domains/site-a.test/drafts/d.json')));
  assert.ok(fs.existsSync(path.join(archive(), 'tests/suites/site-a.test/pa--s1.spec.ts')));
});

test('원본과 함께 남은 .migrating-<pid> 도 보관한 뒤 지운다', () => {
  put(root, 'domains.migrating-77/old.test/recording.json', [{ action: 'old' }]);
  const r = applyMigration(planMigration(input()));
  assert.equal(r.ok, true, r.errors.join());
  assert.ok(!fs.existsSync(path.join(root, 'domains.migrating-77')));
  assert.deepEqual(json(path.join(archive(), 'domains.migrating-77/old.test/recording.json')), [{ action: 'old' }]);
  assert.equal(json(setPaths('pb', root).state).sessionId, 'sess-1');
});

test('패널이 프로필을 보내지 않으면(확장 저장소를 지움) 이 PC 저장소의 서버 프로필로 옮기고 나머지는 건너뛴다', () => {
  put(root, 'domains/site-z.test/recording.json', [{ action: 'z' }]);
  const plan = planMigration({ root, spikeDir, profiles: {}, activeId: null, extSuites: {}, extTimelines: [] });
  assert.deepEqual(plan.setByProfile, { pa: 'pa', pb: 'pb' });
  assert.ok(plan.sets.every((s) => s.source === 'server'));
  // 활성 프로필을 모르므로 그 도메인 프로필 중 id 순 첫 번째(pa)
  assert.deepEqual(plan.sets.find((s) => s.setId === 'pa').moves.map((m) => path.basename(m.to)).sort(), ['logs', 'recording.json', 'recordings', 'state.json']);
  assert.deepEqual(plan.skipped, ['domains/site-z.test']);
  const r = applyMigration(plan);
  assert.equal(r.ok, true, r.errors.join());
  assert.equal(json(setPaths('pa', root).state).sessionId, 'sess-1');
  assert.deepEqual(json(path.join(archive(), 'domains/site-z.test/recording.json')), [{ action: 'z' }]);
});

test('역할: 서버 프로필의 인라인 역할·기본 역할은 정의 맨 위로, 이 PC 전용 프로필의 역할 문서 id 는 (계정을 빼고) 정의에 넣는다', () => {
  putYaml(root, 'store/profiles/pa.yaml', { ...profA, kind: 'profile', default_role: 'MEMBER',
    roles: [{ key: 'ADMIN', label: '관리자', account: { user: 'u', pass: 'secret-r1' } }, { key: 'MEMBER', label: '회원' }] });
  putYaml(root, 'store/roles/doc-roles.yaml', { id: 'doc-roles', kind: 'role', version: 3, default_role: 'B',
    roles: [{ key: 'A', label: '가', account: { user: 'd', pass: 'secret-r2' } }, { key: 'B', label: '나' }] });
  const local = { id: 'local-r', name: '로컬 R', target: { base_url: 'https://site-c.test' }, roles: 'doc-roles' };
  const gone = { id: 'local-g', name: '로컬 G', target: { base_url: 'https://site-d.test' }, roles: 'no-such-roles' };
  const plan = planMigration(input({ profiles: { pa: { data: profA }, pb: { data: profB }, 'local-r': { local: true, data: local }, 'local-g': { local: true, data: gone } } }));
  const r = applyMigration(plan);
  assert.equal(r.ok, true, r.errors.join());
  const pa = readSet('pa', root);
  assert.deepEqual(pa.def.roles, [{ key: 'ADMIN', label: '관리자' }, { key: 'MEMBER', label: '회원' }]);
  assert.equal(pa.def.default_role, 'MEMBER');
  const lr = readSet(plan.setByProfile['local-r'], root);
  assert.deepEqual(lr.def.roles, [{ key: 'A', label: '가' }, { key: 'B', label: '나' }]);
  assert.equal(lr.def.default_role, 'B');
  const lg = readSet(plan.setByProfile['local-g'], root);
  assert.equal(lg.def.roles, undefined);
  assert.deepEqual(lg.def.migration_missing, ['role/no-such-roles']);
  assert.ok(plan.skipped.includes(`${plan.setByProfile['local-g']}: 참조 문서 없음 role/no-such-roles`));
  // 세트 상세에도 역할·기본 역할이 보인다
  const l = listSets(root, () => {});
  const of = (id) => l.find((s) => s.id === id);
  assert.deepEqual(of('pa').roles.map((x) => x.key), ['ADMIN', 'MEMBER']);
  assert.equal(of('pa').default_role, 'MEMBER');
  assert.deepEqual(of(lr.id).roles.map((x) => x.key), ['A', 'B']);
  assert.equal(of(lr.id).default_role, 'B');
  const all = JSON.stringify(tree(path.join(root, 'sets'))) + JSON.stringify(tree(path.join(root, 'store/sets')));
  assert.ok(!all.includes('secret-r1') && !all.includes('secret-r2'));
});
