import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTests, saveTests, addTests, recordResults, applyPanelEdits, adoptedKey } from '../testlist.mjs';
import { setPaths } from '../sets.mjs';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-testlist-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const existing = () => ({
  id: 'a', name: '서비스A 2.0 취약점 점검', flow: [], coverage: [], code: null, applied: true, base_version: 2,
  scenarios: [{ id: 'SC-1', title: '로그인', use: false, tags: ['x'], extra: 1 }, { id: 'SC-2', title: '조회', use: true, tags: [] }],
  cases: [1, 2, 3].map((n) => ({ id: `TC-${n}`, scenario: n === 3 ? 'SC-2' : 'SC-1', title: `케이스${n}`, use: true, tags: [] })),
});
const draft = () => ({
  scenarios: [{ id: 'SC-1', title: '새 시나리오', tags: [] }],
  cases: [{ id: 'TC-1', scenario: 'SC-1', title: '새1' }, { id: 'TC-2', scenario: 'SC-1', title: '새2', use: false }],
});

test('없으면 빈 목록', () => {
  const s = loadTests('a', root);
  assert.deepEqual(s, { id: 'a', name: 'a', scenarios: [], cases: [], flow: [], coverage: [], code: null, applied: false, base_version: 0 });
});

test('더할 때 세트 안에서 id 다시 매김', () => {
  const { suite, renamed } = addTests(existing(), draft());
  assert.equal(renamed['SC-1'], 'SC-3');
  assert.deepEqual(suite.cases.map((c) => c.id), ['TC-1', 'TC-2', 'TC-3', 'TC-4', 'TC-5']);
  const c4 = suite.cases[3];
  assert.equal(c4.scenario, 'SC-3');
  assert.equal(suite.cases[4].scenario, 'SC-3');
  assert.equal(c4.added, true);
  assert.equal(c4.use, true);
  assert.equal(suite.cases[4].use, false);
  assert.equal(suite.scenarios[2].id, 'SC-3');
  assert.equal(suite.scenarios[0].use, false);
  assert.deepEqual(suite.scenarios[0].tags, ['x']);
  assert.equal(suite.scenarios[0].extra, 1);
  assert.equal(suite.applied, false);
});

test('번호는 숫자로 비교(SC-10 다음은 SC-11)', () => {
  const s = existing();
  s.scenarios.push({ id: 'SC-10', title: 't' });
  s.cases.push({ id: 'TC-10', scenario: 'SC-10', title: 't' });
  const { suite } = addTests(s, draft());
  assert.equal(suite.scenarios.at(-1).id, 'SC-11');
  assert.equal(suite.cases.at(-1).id, 'TC-12');
});

test('saveTests 뒤 loadTests가 같은 내용, 임시 파일은 남지 않음', () => {
  const s = existing();
  saveTests('a', s, root);
  assert.deepEqual(loadTests('a', root), s);
  assert.deepEqual(fs.readdirSync(setPaths('a', root).tests), ['tests.json']);
});

test('recordResults: 제목별 마지막 결과를 합치고 실행 이력을 남김', () => {
  recordResults('a', [{ title: 'TC-1', status: 'failed' }, { title: 'TC-2', status: 'passed' }], '2026-10-29T01-00-00', root);
  recordResults('a', [{ title: 'TC-1', status: 'passed' }], '2026-10-29T02-00-00', root);
  const { results } = setPaths('a', root);
  const last = JSON.parse(fs.readFileSync(`${results}/last.json`, 'utf8'));
  assert.equal(last['TC-1'].status, 'passed');
  assert.equal(last['TC-2'].status, 'passed');
  assert.equal(fs.readdirSync(`${results}/runs`).length, 2);
});

test('깨진 tests.json은 빈 목록으로 읽지 않고 .bad 사본을 남기며 던진다', () => {
  const { testsFile, tests } = setPaths('a', root);
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(testsFile, '{garbage');
  assert.throws(() => loadTests('a', root), /손상/);
  const bad = fs.readdirSync(tests).filter((f) => f.startsWith('tests.json.bad-'));
  assert.equal(bad.length, 1);
  assert.equal(fs.readFileSync(path.join(tests, bad[0]), 'utf8'), '{garbage');
  assert.equal(fs.existsSync(testsFile), false);
});

test('recordResults: ranAt의 위험한 글자는 파일 이름에서 바뀌고 본문에는 그대로', () => {
  const iso = new Date().toISOString();
  recordResults('a', [{ title: 'TC-1', status: 'passed' }], iso, root);
  recordResults('a', [{ title: 'TC-1', status: 'passed' }], '../x', root);
  const { results } = setPaths('a', root);
  const files = fs.readdirSync(`${results}/runs`);
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => !/[:/]/.test(f)));
  assert.ok(files.includes('..-x.json'));
  assert.equal(JSON.parse(fs.readFileSync(`${results}/runs/${iso.replace(/[^0-9A-Za-z._-]/g, '-')}.json`, 'utf8')).ranAt, iso);
  assert.equal(fs.existsSync(`${results}/x.json`), false);
});

test('addTests: 명시한 use:false는 유지, 없으면 true', () => {
  const { suite } = addTests(existing(), { scenarios: [{ id: 'SC-1', use: false }], cases: [{ id: 'TC-1', scenario: 'SC-1', use: null }] });
  assert.equal(suite.scenarios.at(-1).use, false);
  assert.equal(suite.cases.at(-1).use, true);
});

test('applyPanelEdits: 보낸 필드만 바꾸고(null 은 지움) 항목 내용·코드·기준 버전은 호스트 것', () => {
  const cur = { ...existing(), base_version: 3, code: { source: 'S', results: [{ title: 'SC-2', status: 'passed' }], key: 'k0' } };
  cur.scenarios[0].issue = 'I-1';
  cur.scenarios[1].added = true;
  cur.scenarios[1].tags = ['@ai'];
  const panel = {
    applied: true, base_version: 0, code: { source: '패널 코드', key: 'k1' },
    scenarios: [
      { id: 'SC-1', title: '패널이 바꾼 제목', use: true, issue: null }, // issue 지움, tags 는 안 보냄 → 그대로
      { id: 'SC-2', added: null },                                      // added 만 지움, 호스트 태그는 그대로
      { id: 'SC-9', title: '패널에만 있는 항목', use: true },
    ],
  };
  const next = applyPanelEdits(cur, panel);
  assert.deepEqual(next.scenarios.map((c) => c.id), ['SC-1', 'SC-2']);
  assert.equal(next.scenarios[0].title, '로그인');
  assert.equal(next.scenarios[0].extra, 1);
  assert.equal(next.scenarios[0].use, true);
  assert.deepEqual(next.scenarios[0].tags, ['x']);
  assert.equal('issue' in next.scenarios[0], false);
  assert.equal(next.scenarios[1].use, true);
  assert.deepEqual(next.scenarios[1].tags, ['@ai']);
  assert.equal('added' in next.scenarios[1], false);
  assert.equal(next.cases.length, 3);
  assert.equal(next.base_version, 3);
  assert.deepEqual(next.code, cur.code);
  assert.equal(next.applied, true);
  assert.equal(next.name, cur.name);
});

test('applyPanelEdits: applied 를 보내지 않으면 호스트 값 그대로', () => {
  const next = applyPanelEdits({ ...existing(), applied: false }, { scenarios: [{ id: 'SC-1', use: true }] });
  assert.equal(next.applied, false);
  assert.equal(next.scenarios[0].use, true);
});

test('adoptedKey: 채택한 것의 id·태그·이슈(패널 suite.js 와 같은 식)', () => {
  const s = { scenarios: [{ id: 'SC-1', tags: ['@a', '@b'], issue: 'I-1' }, { id: 'SC-2', use: false, tags: ['@x'] }], cases: [{ id: 'TC-1' }, { id: 'TC-2', use: true, tags: ['@c'] }] };
  assert.equal(adoptedKey(s), 'SC-1:@a+@b:I-1,TC-1::,TC-2:@c:');
  assert.equal(adoptedKey({}), '');
});

test('clearTests: BDD 를 지우면 딸린 TDD 도 지우고, 지우기 전 목록을 보관한다', async () => {
  const { clearTests, saveTests, loadTests } = await import('../testlist.mjs');
  const { setPaths } = await import('../sets.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koa-clear-'));
  try {
    const sc = (id) => ({ id, title: id, given: [], when: [], then: [], use: true });
    saveTests('s', { id: 's', name: '세트', scenarios: [sc('SC-1'), sc('SC-2')], cases: [{ id: 'TC-1', scenario: 'SC-1' }, { id: 'TC-9', scenario: 'SC-X' }], flow: [{ step: 'a' }], coverage: [{ category: 'c' }], code: { source: 'x' }, applied: true, base_version: 3 }, root);
    const r = clearTests('s', 'bdd', root);
    assert.deepEqual(r.removed, { scenarios: 2, cases: 1, flow: 0 });
    const t = loadTests('s', root);
    assert.deepEqual(t.scenarios, []);
    assert.deepEqual(t.cases.map((c) => c.id), ['TC-9']);
    assert.equal(t.applied, false);
    assert.equal(t.base_version, 3);
    assert.equal(JSON.parse(fs.readFileSync(r.archive, 'utf8')).scenarios.length, 2);
    clearTests('s', 'flow', root);
    assert.deepEqual(loadTests('s', root).flow, []);
    // 전부: 목록·점검표·코드·결과를 지우고 이름·서버 기준 버전은 둔다
    fs.mkdirSync(setPaths('s', root).code, { recursive: true });
    fs.writeFileSync(path.join(setPaths('s', root).code, 's.spec.ts'), '//');
    fs.mkdirSync(setPaths('s', root).results, { recursive: true });
    const all = clearTests('s', 'all', root);
    const e = loadTests('s', root);
    assert.deepEqual([e.scenarios, e.cases, e.flow, e.coverage, e.code], [[], [], [], [], null]);
    assert.equal(e.name, '세트');
    assert.equal(e.base_version, 3);
    assert.ok(!fs.existsSync(setPaths('s', root).code) && !fs.existsSync(setPaths('s', root).results));
    assert.ok(fs.existsSync(all.archive));
    assert.throws(() => clearTests('s', 'nope', root), /지울 수 없는 항목/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('deleteTests: 항목 하나씩 지운다 · BDD 는 딸린 TDD 와 함께 · 채택 항목을 지우면 다시 반영해야 한다', async () => {
  const { deleteTests, saveTests, loadTests } = await import('../testlist.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koa-del-'));
  try {
    const sc = (id, use) => ({ id, title: id, given: [], when: [], then: [], use });
    saveTests('s', { id: 's', name: '세트', scenarios: [sc('SC-1', true), sc('SC-2', false)], cases: [{ id: 'TC-1', scenario: 'SC-1', use: true }, { id: 'TC-2', scenario: 'SC-2', use: false }, { id: 'TC-3', scenario: 'SC-1', use: true }], applied: true }, root);
    // 미채택 항목을 지우면 반영 상태는 그대로
    let r = deleteTests('s', ['SC-2'], root);
    assert.deepEqual(r.ids, ['SC-2', 'TC-2']);
    assert.deepEqual(r.removed, { scenarios: 1, cases: 1 });
    assert.equal(loadTests('s', root).applied, true);
    // 채택된 TDD 하나를 지우면 다시 반영해야 한다
    r = deleteTests('s', ['TC-3'], root);
    assert.deepEqual(r.ids, ['TC-3']);
    const t = loadTests('s', root);
    assert.deepEqual([t.scenarios.map((x) => x.id), t.cases.map((x) => x.id), t.applied], [['SC-1'], ['TC-1'], false]);
    assert.equal(fs.readdirSync(path.join(root, 'sets', 's', 'tests', 'archive')).length, 2);
    assert.throws(() => deleteTests('s', ['SC-404'], root), /지울 항목이 목록에 없습니다/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
