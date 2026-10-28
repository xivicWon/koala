import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// sync 는 모듈 로드 때 데이터 폴더를 정하므로, 가져오기 전에 임시 폴더·다른 포트를 건다
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-outbox-'));
process.env.KOALA_DATA_DIR = root;
process.env.KOALA_PORT = '8798';
const { buildPayload, send, FORMAT } = await import('../outbox.mjs');
const { saveTests, loadTests, adoptedKey } = await import('../testlist.mjs');
const { setPaths } = await import('../sets.mjs');

const PASS = 'p@ss-시험용-비밀번호-7391';
const THIS = 'http://127.0.0.1:8798';
const code = "import { x } from '@support/none';\nprocess.env.KOALA_BASE_URL;\ntest('SC-1 로그인', async () => {});\n";
const suite = (over = {}) => ({
  id: 's1', name: '서비스A 2.0 취약점 점검', flow: [], coverage: [], applied: true, base_version: 0,
  scenarios: [{ id: 'SC-1', title: '로그인', use: true }, { id: 'SC-2', title: '제외', use: false }],
  cases: [{ id: 'TC-1', scenario: 'SC-1', title: '실패', use: true }],
  code: { source: code, file: 's1.spec.ts', env: ['KOALA_BASE_URL'], summary: { passed: 1, failed: 0 }, ran_at: 'x', results: [{ title: 'SC-1 로그인', status: 'passed', extra: 1 }] },
  ...over,
});
const seed = (id = 's1', s = suite()) => {
  const p = setPaths(id, root);
  fs.mkdirSync(p.secrets, { recursive: true });
  fs.writeFileSync(`${p.secrets}/accounts.json`, JSON.stringify({ ADMIN: { user: 'u', pass: PASS } }));
  // 호스트가 코드를 만들 때 남기는 채택 목록 표시(code.key)를 지금 채택 목록으로 맞춰 둔다
  const key = s.code && s.code.key === undefined ? { code: { ...s.code, key: adoptedKey(s) } } : {};
  saveTests(id, { ...s, ...key, id }, root);
};

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('보낼 JSON: 형태 표시, 미채택 항목, 비밀번호 없음', () => {
  seed();
  const p = buildPayload('s1', root);
  assert.equal(p.format, FORMAT);
  assert.equal(p.format, 'koa-temp-json-1');
  assert.equal(p.scenarios.find((x) => x.id === 'SC-2').adopted, false);
  assert.equal(p.scenarios.find((x) => x.id === 'SC-1').adopted, true);
  assert.ok(!('use' in p.scenarios[0]));
  assert.deepEqual(p.code.env, ['KOALA_BASE_URL']);
  assert.deepEqual(p.code.local_run.results, [{ title: 'SC-1 로그인', status: 'passed' }]);
  assert.ok(!JSON.stringify(p).includes(PASS));
});

test('이 호스트로 두 번 보내면 두 번째는 옛 기준 버전이라 충돌', async () => {
  seed();
  const a = await send('s1', { server: THIS, baseVersion: 0 }, root);
  assert.equal(a.ok, true);
  assert.equal(a.version, 1);
  const b = await send('s1', { server: THIS, baseVersion: 0 }, root);
  assert.equal(b.ok, false);
  assert.equal(b.conflict, true);
  assert.equal(b.current.version, 1);
});

test('성공하면 tests.json 의 기준 버전과 outbox/last.json 이 갱신', async () => {
  seed('s2');
  const r = await send('s2', { server: THIS, baseVersion: 0 }, root);
  assert.equal(r.ok, true);
  assert.equal(loadTests('s2', root).base_version, r.version);
  const last = JSON.parse(fs.readFileSync(`${setPaths('s2', root).outbox}/last.json`, 'utf8'));
  assert.equal(last.version, r.version);
  assert.equal(last.format, 'koa-temp-json-1');
  assert.ok(last.sent_at);
  // 새 기준으로 바로 다시 보내도 거짓 충돌이 아니다
  const again = await send('s2', { server: THIS, baseVersion: loadTests('s2', root).base_version }, root);
  assert.equal(again.ok, true);
});

test('코드나 채택 항목이 없으면 보내지 않음', async () => {
  seed('s3', suite({ code: null }));
  const r1 = await send('s3', { server: THIS, baseVersion: 0 }, root);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /코드/);
  seed('s4', suite({ scenarios: [{ id: 'SC-1', title: 'a', use: false }], cases: [] }));
  const r2 = await send('s4', { server: THIS, baseVersion: 0 }, root);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /채택/);
  assert.equal((await send('s1', { baseVersion: 0 }, root)).ok, false);
});

test('다른 서버로는 HTTP PUT, 버전이 다르면 409', async () => {
  seed('r1');
  const docs = new Map();
  const srv = http.createServer((req, res) => {
    const m = /^\/sync\/suites\/([^/]+)$/.exec(req.url);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'PUT' || !m) { res.writeHead(404).end('{}'); return; }
      const { base_version, data } = JSON.parse(body);
      const cur = docs.get(m[1]);
      res.setHeader('content-type', 'application/json');
      if (cur && cur.version !== base_version) { res.writeHead(409).end(JSON.stringify({ current: cur })); return; }
      const doc = { ...data, version: (cur?.version ?? 0) + 1 };
      docs.set(m[1], doc);
      res.writeHead(200).end(JSON.stringify(doc));
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const server = `http://127.0.0.1:${srv.address().port}`;
  try {
    const a = await send('r1', { server, baseVersion: 0 }, root);
    assert.equal(a.ok, true);
    assert.equal(docs.get('r1').format, 'koa-temp-json-1');
    assert.ok(!JSON.stringify(docs.get('r1')).includes(PASS));
    const b = await send('r1', { server, baseVersion: 0 }, root);
    assert.equal(b.conflict, true);
    assert.equal(b.current.version, 1);
  } finally { srv.close(); }
  const down = await send('r1', { server: 'http://127.0.0.1:1', baseVersion: 0 }, root);
  assert.equal(down.ok, false);
  assert.match(down.error, /보내지 못했습니다/);
});

test('보낼 JSON 의 코드 경로는 세트 폴더 기준(이 PC의 절대 경로를 싣지 않는다)', () => {
  seed('rel', suite({ code: { ...suite().code, file: path.join(root, 'sets', 'rel', 'tests', 'code', 'rel.spec.ts') } }));
  const p = buildPayload('rel', root);
  assert.equal(p.code.file, 'tests/code/rel.spec.ts');
  assert.ok(!JSON.stringify(p).includes(root));
});

test('use 표시가 없는 항목은 채택으로 본다(패널과 같다)', async () => {
  seed('nouse', suite({ scenarios: [{ id: 'SC-1', title: '표시 없음' }], cases: [] }));
  const p = buildPayload('nouse', root);
  assert.equal(p.scenarios[0].adopted, true);
  const r = await send('nouse', { server: THIS, baseVersion: 0 }, root);
  assert.equal(r.ok, true, r.error);
});

test('호스트도 막는다: 반영하지 않았거나 코드가 지금 채택 목록으로 만든 것이 아니면 보내지 않음', async () => {
  seed('g1', suite({ applied: false }));
  const a = await send('g1', { server: THIS, baseVersion: 0 }, root);
  assert.equal(a.ok, false);
  assert.match(a.error, /반영하지 않은/);
  seed('g2', suite({ code: { ...suite().code, key: 'SC-1::' } })); // TC-1 을 채택하기 전에 만든 코드
  const b = await send('g2', { server: THIS, baseVersion: 0 }, root);
  assert.equal(b.ok, false);
  assert.match(b.error, /코드를 다시/);
  assert.ok(!fs.existsSync(`${setPaths('g2', root).outbox}/last.json`));
});

test('목록이 깨졌거나 보낸 뒤 기준 버전을 저장하지 못하면 던지지 않고 ok:false', async () => {
  const p = setPaths('bad', root);
  fs.mkdirSync(p.tests, { recursive: true });
  fs.writeFileSync(p.testsFile, '{깨짐');
  const a = await send('bad', { server: THIS, baseVersion: 0 }, root);
  assert.equal(a.ok, false);
  assert.match(a.error, /테스트 목록을 읽지 못해/);

  seed('ro');
  const t = setPaths('ro', root).tests;
  fs.chmodSync(t, 0o555);
  try {
    const b = await send('ro', { server: THIS, baseVersion: 0 }, root);
    assert.equal(b.ok, false);
    assert.equal(b.sent, true);
    assert.equal(b.version, 1);
    assert.match(b.error, /v1으로 보냈지만 기준 버전을 저장하지 못했습니다/);
  } finally { fs.chmodSync(t, 0o755); }
});
