import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTests, saveTests, addTests, recordResults } from '../testlist.mjs';
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
