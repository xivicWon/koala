import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failDetail, createFixLog } from '../fixlog.mjs';

test('failDetail: 실패한 단계·줄·코드·화면을 뽑는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-fixlog-'));
  const ctx = path.join(dir, 'error-context.md');
  fs.writeFileSync(ctx, '# Page snapshot\n- button "저장"');
  const d = failDetail({
    error: { message: 'x', location: { file: '/a/b/s.spec.ts', line: 5 }, snippet: '\u001b[31m> 5 |\u001b[39m expect' },
    steps: [{ title: 'When 누른다' }, { title: 'Then 보인다', error: {}, steps: [{ title: '확인', error: {} }] }],
    attachments: [{ name: 'screenshot', path: '/x.png' }, { name: 'error-context', path: ctx }],
  });
  assert.deepEqual(d, { at: 's.spec.ts:5', step: 'Then 보인다 > 확인', snippet: '> 5 | expect', page: '# Page snapshot\n- button "저장"' });
  assert.equal(failDetail({ status: 'passed' }), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

const fail = (title, error, step = 'Then 보인다', at = 's.spec.ts:5') => ({ title, status: 'failed', error, debug: { step, at, page: 'P' } });
const pass = (title) => ({ title, status: 'passed' });

test('같은 실패가 이어지면 repeat 이 늘고, 지난 시도와 note 를 돌려준다', () => {
  const log = createFixLog();
  log.record('s', [fail('TC-1 a', 'Timeout 5000ms\nCall log'), pass('TC-2 b')], '');
  const r = log.record('s', [fail('TC-1 a', 'Timeout 5000ms\nother'), pass('TC-2 b')], 'TC-1 a: B · 응답 대기 앞으로\nTC-9: 무관');
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].repeat, 2);
  assert.deepEqual(r.failures[0].tries, [{ try: 1, status: 'failed', step: 'Then 보인다', at: 's.spec.ts:5', error: 'Timeout 5000ms', note: undefined }]);
  const r3 = log.record('s', [fail('TC-1 a', 'Timeout 5000ms')], '');
  assert.equal(r3.failures[0].repeat, 3);
  assert.equal(r3.failures[0].tries.at(-1).note, 'TC-1 a: B · 응답 대기 앞으로');
  // 다른 줄에서 실패하면 다른 실패다
  const r4 = log.record('s', [fail('TC-1 a', 'Timeout 5000ms', 'Then 보인다', 's.spec.ts:9')], '');
  assert.equal(r4.failures[0].repeat, undefined);
});

test('지난번 통과했던 테스트가 실패하면 regressed', () => {
  const log = createFixLog();
  log.record('s', [pass('SC-1 a'), fail('TC-1 b', 'e')]);
  const r = log.record('s', [fail('SC-1 a', 'e'), pass('TC-1 b')]);
  assert.deepEqual(r.regressed, ['SC-1 a']);
  assert.equal(r.failures[0].regressed, true);
});

test('세트가 바뀌거나 reset 하면 기록을 비운다. 화면은 앞쪽 실패만 싣는다', () => {
  const log = createFixLog({ pageLimit: 1 });
  log.record('s', [fail('TC-1 a', 'e')]);
  const r = log.record('t', [fail('TC-1 a', 'e'), fail('TC-2 b', 'e')]);
  assert.equal(r.failures[0].tries, undefined);
  assert.equal(r.failures[0].page, 'P');
  assert.match(r.failures[1].page, /생략/);
  log.reset('t');
  assert.equal(log.record('t', [fail('TC-1 a', 'e')]).failures[0].repeat, undefined);
});
