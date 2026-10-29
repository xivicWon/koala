// 호스트 통합 시험: 임시 데이터 폴더·빈 포트로 호스트를 띄우고 가짜 패널(토큰·Origin 헤더)과 가짜 Claude로 세트 흐름을 본다.
// 사용자가 쓰는 호스트(8765)와 실제 Claude CLI는 건드리지 않는다
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import WebSocket from 'ws';

const spike = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = 'chrome-extension://hgeagihneebddhldphmjhjpeeigmeahc';
const FAKE_CLAUDE = path.join(spike, 'unit', 'fixtures', 'fake-claude.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`기다렸지만 오지 않음: ${what}`);
    await sleep(25);
  }
}
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const putYaml = (root, rel, doc) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, YAML.stringify(doc));
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
let data;
const writeTests = (id, suite) => {
  const f = path.join(data, 'sets', id, 'tests', 'tests.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(suite));
};

const hosts = [];
// 호스트가 예전 테스트 코드(tests/suites/)를 찾는 spike 폴더: 개발 폴더의 것을 옮기거나 게이트에 걸리지 않게 임시 폴더로
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-host-spike-'));
// 가짜 Claude 가 받은 지시를 남기는 파일(관리 탭 목록이 지시에 붙는지 본다)
const dump = path.join(legacyDir, 'claude-input.txt');
// API 키 파일도 임시 폴더로(사용자의 ~/.koala/anthropic-api-key 를 덮어쓰지 않게)
const keyFile = path.join(legacyDir, 'anthropic-api-key');
async function startHost(data, extraEnv = {}) {
  const port = await freePort();
  assert.notEqual(port, 8765);
  const env = { ...process.env, KOALA_PORT: String(port), KOALA_DATA_DIR: data, KOALA_SPIKE_DIR: legacyDir, KOALA_HEADED: '0', CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_DUMP: dump, KOALA_API_KEY_FILE: keyFile,
    KOALA_PG: 'postgres://koala:koala@127.0.0.1:9/koala', ...extraEnv }; // 그래프 DB는 없는 것으로(사용자 DB에 쓰지 않게)
  delete env.CLAUDECODE;
  const p = spawn(process.execPath, ['host.mjs'], { cwd: spike, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  hosts.push(p);
  await until(() => out.includes('koala host:') || p.exitCode !== null, '호스트 시작', 15000);
  assert.equal(p.exitCode, null, out);
  return { p, port, out: () => out, token: fs.readFileSync(path.join(data, 'host-token'), 'utf8').trim() };
}

async function stopHost(p) {
  if (p.exitCode !== null) return;
  p.kill('SIGTERM');
  await until(() => p.exitCode !== null, '호스트 종료', 5000).catch(() => p.kill('SIGKILL'));
}
const stateOf = (root, id) => readJson(path.join(root, 'sets', id, 'work', 'state.json'));
const logsOf = (root, id) => {
  const d = path.join(root, 'sets', id, 'work', 'logs');
  return fs.existsSync(d) ? fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('') : '';
};
// 가짜 Claude 의 세션 id 는 fake-<세트>-… 다
const notFromSet = (sid, id) => !sid || !sid.startsWith(`fake-${id}-`);

// 가짜 패널: 받은 메시지를 모으고, 도구 호출에는 지금 탭 주소(url)로 답한다
async function connectPanel(h) {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}`, { headers: { Origin: EXT, 'x-koala-token': h.token } });
  const pn = {
    ws, msgs: [], url: 'http://site-a.test/',
    send: (m) => ws.send(JSON.stringify(m)),
    mark: () => pn.msgs.length,
    waitFor: (pred, since = 0, what = '메시지') => until(() => pn.msgs.slice(since).find(pred), what),
  };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    pn.msgs.push(m);
    if (m.type === 'tool') {
      if (m.name === 'goto') pn.url = m.args.url;
      pn.send({ type: 'tool_result', id: m.id, ok: true, result: { url: pn.url, elements: [] } });
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  pn.send({ type: 'run_where', where: 'browser' }); // 가짜 패널은 작업 탭 중계를 하지 않는다(실제 패널은 연결할 때 고른 위치를 알린다)
  return pn;
}

let host, pn;
const siteSet = (id, version = 1) => ({ id, kind: 'set', name: `세트 ${id}`, version,
  profile: { target: { base_url: 'http://site-a.test', start_url: 'http://site-a.test/' } } });

before(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-host-sets-'));
  putYaml(data, 'store/sets/a.yaml', siteSet('a'));
  putYaml(data, 'store/sets/b.yaml', siteSet('b'));
  // 보강·생성 지시에는 가짜 Claude 가 답을 끝내지 않는다(작업이 진행 중인 채로 save_tests 를 부를 수 있게)
  host = await startHost(data, { FAKE_CLAUDE_HOLD: '\\[예외·오류 보강\\]|\\[테스트 생성\\]' });
  pn = await connectPanel(host);
  await pn.waitFor((m) => m.type === 'sets', 0, '연결 시 sets');
});

after(async () => {
  pn?.ws.close();
  for (const p of hosts) await stopHost(p);
  if (data) fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(legacyDir, { recursive: true, force: true });
});

const receivedIds = (m) => m.sets.filter((s) => s.received).map((s) => s.id).sort();

test('새 데이터 폴더는 옮기기 안내 없이 바로 쓴다', () => {
  assert.ok(!pn.msgs.some((m) => m.type === 'migration_needed'));
});

test('set_receive 로 두 세트를 받으면 sets 에 received:true', async () => {
  let at = pn.mark();
  pn.send({ type: 'set_receive', id: 'a' });
  await pn.waitFor((m) => m.type === 'sets' && receivedIds(m).includes('a'), at, 'a 받기 뒤 sets');
  at = pn.mark();
  pn.send({ type: 'set_receive', id: 'b' });
  const m = await pn.waitFor((x) => x.type === 'sets' && receivedIds(x).includes('b'), at, 'b 받기 뒤 sets');
  assert.deepEqual(receivedIds(m).filter((id) => ['a', 'b'].includes(id)), ['a', 'b']);
});

test('테스트 목록은 세트마다 따로: a 에 저장한 것이 b 에 보이지 않는다', async () => {
  let at = pn.mark();
  pn.send({ type: 'set', id: 'a', prefs: { accounts: [] } });
  const first = await pn.waitFor((m) => m.type === 'tests' && m.set === 'a', at, 'a 의 tests');
  assert.equal(first.suite.scenarios.length, 0);
  assert.equal(first.suite.id, 'a');
  assert.ok(pn.msgs.slice(at).some((m) => m.type === 'set_active' && m.id === 'a' && m.domain === 'site-a.test'));

  // 항목은 AI 저장으로만 생긴다(패널 tests_save 는 항목을 더하지 않는다). 여기서는 파일로 넣는다
  writeTests('a', { ...first.suite, scenarios: [{ id: 'SC-1', title: '로그인', use: true }] });
  at = pn.mark();
  pn.send({ type: 'set', id: 'b', prefs: { accounts: [] } });
  const b = await pn.waitFor((m) => m.type === 'tests' && m.set === 'b', at, 'b 의 tests');
  assert.equal(b.suite.scenarios.length, 0);
  at = pn.mark();
  pn.send({ type: 'set', id: 'a', prefs: { accounts: [] } });
  const a = await pn.waitFor((m) => m.type === 'tests' && m.set === 'a', at, '다시 a 의 tests');
  assert.equal(a.suite.scenarios.length, 1);
  assert.ok(fs.existsSync(path.join(data, 'sets', 'a', 'tests', 'tests.json')));
});

test('세트 a 에서 지시하면 세션·작업 로그가 a 에만 남는다', async () => {
  pn.url = 'http://site-a.test/';
  const at = pn.mark();
  pn.send({ type: 'instruct', text: '로그인 화면 확인-통합시험', roles: [], set: 'a' });
  await pn.waitFor((m) => m.type === 'session' && m.alias, at, '세션 이름');
  pn.send({ type: 'stop' });
  const a = await until(() => stateOf(data, 'a')?.sessionAlias, 'a 의 sessionAlias');
  assert.match(a, /^kaa-\d+$/);
  const aSid = stateOf(data, 'a').sessionId;
  assert.ok(aSid.startsWith('fake-a-'));
  const bSid = stateOf(data, 'b')?.sessionId;
  assert.ok(bSid !== aSid && notFromSet(bSid, 'a'));
  await until(() => logsOf(data, 'a').includes('로그인 화면 확인-통합시험'), 'a 의 작업 로그');
  assert.ok(!logsOf(data, 'b').includes('로그인 화면 확인-통합시험'));
  assert.ok(!fs.existsSync(path.join(data, 'domains')));
});

test('관리 탭이 둘 이상이면 지시에 #라벨 목록이 붙고 작업 로그에 남는다', async () => {
  pn.url = 'http://site-a.test/';
  const at = pn.mark();
  const tabs = [{ tab: '#1', title: '목록', url: 'http://site-a.test/list', current: true }, { tab: '#2', title: '신청서', url: 'http://site-a.test/form', current: false }];
  pn.send({ type: 'instruct', text: '#2 탭에서 신청서 확인-탭시험', roles: [], set: 'a', tabs });
  await until(() => fs.existsSync(dump) && fs.readFileSync(dump, 'utf8').includes('탭시험'), 'Claude 가 받은 지시');
  pn.send({ type: 'stop' });
  const got = fs.readFileSync(dump, 'utf8').split('\n').find((l) => l.includes('탭시험'));
  assert.match(got, /\[관리 탭\] #1\(지금 작업 탭\) 목록 .* \/ #2 신청서/);
  assert.match(got, /use_tab/);
  await until(() => logsOf(data, 'a').includes('"tabs":["#1","#2"]'), '작업 로그의 tabs');
  void at;
});

test('claude_prefs: 모델·effort 를 바꾸면 그 값으로 Claude 를 다시 띄운다', async () => {
  pn.url = 'http://site-a.test/';
  pn.send({ type: 'set', id: 'a', prefs: {} });
  await until(() => fs.existsSync(dump) && fs.readFileSync(dump, 'utf8').includes('ARGS'), 'Claude 기동');
  pn.send({ type: 'claude_prefs', model: 'opus', effort: 'high' });
  await until(() => fs.readFileSync(dump, 'utf8').split('\n').some((l) => l === 'ARGS --model opus --effort high'), '새 설정으로 다시 띄움');
  pn.send({ type: 'claude_prefs', model: 'bad name;rm', effort: 'high' });
  await until(() => logsOf(data, 'a').includes('모델 이름이 올바르지 않습니다'), '잘못된 모델 이름 거절');
  pn.send({ type: 'claude_prefs', model: '', effort: '' }); // 다음 시험을 위해 기본으로
});

test('요금제·API 키: 키가 없으면 API 요금제는 쓸 수 없다고 알리고, 저장한 키는 0600 파일에만 남는다', async () => {
  const KEY = `sk-ant-api03-${'k'.repeat(40)}`;
  let at = pn.mark();
  pn.send({ type: 'claude_prefs', model: '', effort: '', billing: 'api' });
  let env = await pn.waitFor((m) => m.type === 'env', at, 'API 요금제 env');
  assert.equal(env.claude.ok, false);
  assert.equal(env.claude.reason, 'no_api_key');
  at = pn.mark();
  pn.send({ type: 'claude_prefs', model: '', effort: '', billing: 'sub' }); // 키 저장 뒤 SDK 를 띄우지 않게 구독으로 돌려 둔다
  env = await pn.waitFor((m) => m.type === 'env', at, '구독 env');
  assert.equal(env.claude.ok, true);
  at = pn.mark();
  pn.send({ type: 'api_key', action: 'save', key: 'nope' });
  assert.equal((await pn.waitFor((m) => m.type === 'api_key_status', at, '형식 오류')).key.saved, false);
  at = pn.mark();
  pn.send({ type: 'api_key', action: 'save', key: KEY });
  assert.equal((await pn.waitFor((m) => m.type === 'api_key_status', at, '저장')).key.saved, true);
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), KEY);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  // 키 값은 데이터 폴더(작업 기록·로그·상태) 어디에도 남지 않는다
  const leaks = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (fs.readFileSync(f, 'utf8').includes(KEY)) leaks.push(f); } };
  walk(data);
  assert.deepEqual(leaks, []);
  at = pn.mark();
  pn.send({ type: 'api_key', action: 'delete' });
  assert.equal((await pn.waitFor((m) => m.type === 'api_key_status', at, '삭제')).key.saved, false);
  assert.equal(fs.existsSync(keyFile), false);
});

test('탭이 다른 도메인이면 domain_mismatch(can_force)', async () => {
  pn.url = 'http://other.test/';
  const at = pn.mark();
  pn.send({ type: 'instruct', text: '다른 사이트', roles: [], set: 'a' });
  const m = await pn.waitFor((x) => x.type === 'domain_mismatch', at, 'domain_mismatch');
  assert.equal(m.can_force, true);
  assert.equal(m.expected, 'site-a.test');
  assert.equal(m.actual, 'other.test');
});

const callTool = (name, args) => fetch(`http://127.0.0.1:${host.port}/tool`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-koala-token': host.token }, body: JSON.stringify({ name, args }),
}).then((r) => r.json());
const sc = (id, title, extra = {}) => ({ id, title, given: ['g'], when: ['w'], then: ['t'], ...extra });
const testsOf = (id) => readJson(path.join(data, 'sets', id, 'tests', 'tests.json'));
async function holdJob(kind, msg) {
  const at = pn.mark();
  pn.send(msg);
  await pn.waitFor((m) => m.type === 'job' && m.kind === kind && !m.done, at, `${kind} 작업 시작`);
}
async function stopJob() {
  const at = pn.mark();
  pn.send({ type: 'stop' });
  await pn.waitFor((m) => m.type === 'job' && m.done, at, '작업 끝');
}

test('예외·오류 보강의 save_tests 는 같은 id를 고쳐 쓰고(채택·태그·이슈 유지), 생성은 새 번호로 더한다', async () => {
  pn.url = 'http://site-a.test/';
  writeTests('a', { id: 'a', name: 'a',
    scenarios: [sc('SC-1', '옛 제목', { use: false, tags: ['@mine'], issue: 'ISSUE-1' })],
    cases: [{ id: 'TC-1', scenario: 'SC-1', title: '옛 케이스', use: false, tags: ['@mine'] }] });

  await holdJob('reinforce', { type: 'reinforce', summary: '요약' });
  const r = await callTool('save_tests', { title: '보강', scope: '', flow: [], coverage: [],
    scenarios: [sc('SC-1', '새 제목', { tags: ['@other'] }), sc('SC-2', '새 예외')], cases: [] });
  assert.equal(r.ok, true, JSON.stringify(r));
  await stopJob();
  let t = testsOf('a');
  assert.deepEqual(t.scenarios.map((c) => c.id), ['SC-1', 'SC-2']);
  const s1 = t.scenarios[0];
  assert.equal(s1.title, '새 제목');
  assert.equal(s1.use, false);
  assert.deepEqual(s1.tags, ['@mine']);
  assert.equal(s1.issue, 'ISSUE-1');
  assert.equal(t.scenarios[1].title, '새 예외');
  assert.deepEqual(t.cases.map((c) => c.id), ['TC-1']);

  await holdJob('derive', { type: 'derive' });
  const d = await callTool('save_tests', { title: '생성', scope: '', flow: [], coverage: [], scenarios: [sc('SC-1', '다시 만든 것')], cases: [] });
  assert.equal(d.ok, true, JSON.stringify(d));
  await stopJob();
  t = testsOf('a');
  assert.deepEqual(t.scenarios.map((c) => c.id), ['SC-1', 'SC-2', 'SC-3']);
  assert.equal(t.scenarios[0].title, '새 제목');
  assert.equal(t.scenarios[2].title, '다시 만든 것');
});

test('패널 tests_save: 보낸 필드만 받고 호스트의 기준 버전·코드(code.key 포함)·항목 내용은 그대로, 작업 중에는 거절하고 목록을 다시 보낸다', async () => {
  pn.url = 'http://site-a.test/';
  writeTests('a', { id: 'a', name: 'a', applied: false, base_version: 5,
    code: { source: '호스트 코드', results: [{ title: 'SC-1 x', status: 'passed' }], key: 'k0' },
    scenarios: [sc('SC-1', '호스트 제목', { use: true, tags: ['@host'] }), sc('SC-2', '둘째', { use: true, tags: ['@ai'] })], cases: [] });
  let at = pn.mark();
  pn.send({ type: 'tests_save', set: 'a', seq: 1, suite: { applied: true, base_version: 0,
    code: { source: '패널 코드', key: 'k1' },
    scenarios: [{ id: 'SC-1', title: '패널 제목', use: false, tags: ['@t'] }, { id: 'SC-7', title: '패널에만', use: true }], cases: [] } });
  const ack = await pn.waitFor((m) => m.type === 'tests_saved' && m.set === 'a', at, 'tests_saved');
  assert.equal(ack.seq, 1);
  let t = testsOf('a');
  assert.equal(t.applied, true);
  assert.equal(t.base_version, 5);
  assert.equal(t.code.source, '호스트 코드');
  assert.equal(t.code.results.length, 1);
  assert.equal(t.code.key, 'k0');
  assert.deepEqual(t.scenarios.map((c) => c.id), ['SC-1', 'SC-2']);
  assert.equal(t.scenarios[0].title, '호스트 제목');
  assert.equal(t.scenarios[0].use, false);
  assert.deepEqual(t.scenarios[0].tags, ['@t']);
  assert.deepEqual(t.scenarios[1].tags, ['@ai']); // 보내지 않은 항목은 그대로

  await holdJob('reinforce', { type: 'reinforce', summary: '요약' });
  at = pn.mark();
  pn.send({ type: 'tests_save', set: 'a', seq: 2, suite: { applied: false, scenarios: [{ id: 'SC-1', use: true }], cases: [] } });
  await pn.waitFor((m) => m.type === 'log' && m.kind === 'err' && /작업.*테스트 목록/.test(m.text), at, '작업 중 거절 안내');
  const back = await pn.waitFor((m) => m.type === 'tests' && m.set === 'a' && m.refused, at, '거절 뒤 tests{refused}');
  assert.equal(back.refused, 'busy');
  assert.equal(back.suite.scenarios[0].use, false);
  assert.ok(!pn.msgs.slice(at).some((m) => m.type === 'tests_saved'));

  // 작업 중에 새로 연결한 패널은 진행 중인 작업 상태를 받는다
  const p2 = await connectPanel(host);
  const j = await p2.waitFor((m) => m.type === 'job', 0, '새 연결에 작업 상태');
  assert.equal(j.kind, 'reinforce');
  assert.ok(!j.done);
  p2.ws.close();
  await until(() => p2.ws.readyState === WebSocket.CLOSED, '두 번째 패널 닫힘');
  await sleep(50);
  await stopJob();

  // 받지 않은 세트에 저장하면 언제나 답한다(refused:'error')
  at = pn.mark();
  pn.send({ type: 'tests_save', set: 'no-such-set', seq: 3, suite: { scenarios: [{ id: 'SC-1', use: true }] } });
  const err = await pn.waitFor((m) => m.type === 'tests' && m.set === 'no-such-set', at, '받지 않은 세트 저장의 답');
  assert.equal(err.refused, 'error');
  assert.match(err.error, /받지 않아/);
  assert.equal(err.suite, undefined);
  t = testsOf('a');
  assert.equal(t.applied, true);
  assert.equal(t.scenarios[0].use, false);
});

test('code.key 는 호스트가 실행할 때 받은 채택 목록으로 정한다(패널 값은 무시)', async () => {
  pn.url = 'http://site-a.test/';
  writeTests('a', { id: 'a', name: 'a', applied: true, base_version: 0, code: null,
    scenarios: [sc('SC-1', '로그인', { use: true, tags: ['@t'], issue: 'I-1' })], cases: [] });
  const file = path.join(data, 'sets', 'a', 'tests', 'code', 'a.spec.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "import { test } from '@playwright/test';\ntest('SC-1 로그인', { tag: '@t' }, async () => {});\n");
  const at = pn.mark();
  pn.send({ type: 'run_code', suite: { id: 'a', scenarios: [sc('SC-1', '로그인', { tags: ['@t'], issue: 'I-1' })], cases: [] }, ids: [], only: false });
  const fin = await until(() => pn.msgs.slice(at).find((m) => m.type === 'suite_code' && !m.running), '실행 끝 suite_code', 60000);
  assert.ok(fin.results.length > 0, JSON.stringify(fin.error));
  assert.equal(fin.key, 'SC-1:@t:I-1');
  assert.equal(testsOf('a').code.key, 'SC-1:@t:I-1');
  const at2 = pn.mark();
  pn.send({ type: 'tests_save', set: 'a', suite: { code: { key: '패널 값' }, scenarios: [{ id: 'SC-1', use: true }] } });
  await pn.waitFor((m) => m.type === 'tests_saved', at2, 'tests_saved');
  assert.equal(testsOf('a').code.key, 'SC-1:@t:I-1');
});

// 새 대화를 열고(reset → 지시) 세션 이름을 돌려준다
async function newSession(text) {
  const at = pn.mark();
  pn.send({ type: 'reset' });
  pn.send({ type: 'instruct', text, roles: [], set: 'a' });
  const m = await pn.waitFor((x) => x.type === 'session' && x.alias, at, '새 세션 이름');
  await pn.waitFor((x) => x.type === 'job' && x.done, at, '지시 끝').catch(() => {});
  return m.alias;
}

test('같은 대화에서 다시 저장한 초안은 그 항목을 고쳐 쓰고(채택·태그·이슈 유지), 새 대화의 저장은 더한다', async () => {
  pn.url = 'http://site-a.test/';
  writeTests('a', { id: 'a', name: 'a', scenarios: [], cases: [], flow: [], coverage: [] });
  const s1 = await newSession('첫 대화-다시저장');
  let r = await callTool('save_tests', { title: '초안', scope: '', flow: [], coverage: [],
    scenarios: [sc('SC-1', '첫째'), sc('SC-2', '둘째')], cases: [{ id: 'TC-1', scenario: 'SC-1', title: '케이스' }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  // 사용자가 SC-1 을 미채택·태그·이슈로 고쳤다
  const t0 = testsOf('a');
  writeTests('a', { ...t0, scenarios: t0.scenarios.map((c) => (c.id === 'SC-1' ? { ...c, use: false, tags: ['@mine'], issue: 'ISSUE-9' } : c)) });
  r = await callTool('save_tests', { title: '초안', scope: '', flow: [], coverage: [],
    scenarios: [sc('SC-1', '첫째 고침'), sc('SC-3', '셋째')], cases: [{ id: 'TC-1', scenario: 'SC-1', title: '케이스 고침' }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  let t = testsOf('a');
  assert.deepEqual(t.scenarios.map((c) => [c.id, c.title]), [['SC-1', '첫째 고침'], ['SC-2', '둘째'], ['SC-3', '셋째']]);
  assert.equal(t.scenarios[0].use, false);
  assert.deepEqual(t.scenarios[0].tags, ['@mine']);
  assert.equal(t.scenarios[0].issue, 'ISSUE-9');
  assert.deepEqual(t.cases.map((c) => [c.id, c.title, c.scenario]), [['TC-1', '케이스 고침', 'SC-1']]);
  assert.deepEqual(r.result.renamed, { 'SC-1': 'SC-1', 'SC-3': 'SC-3', 'TC-1': 'TC-1' });

  // 새 대화: 같은 id 라도 더한다
  const s2 = await newSession('둘째 대화-다시저장');
  assert.notEqual(s2, s1);
  r = await callTool('save_tests', { title: '새 초안', scope: '', flow: [], coverage: [], scenarios: [sc('SC-1', '새 대화의 첫째')], cases: [] });
  assert.equal(r.ok, true, JSON.stringify(r));
  t = testsOf('a');
  assert.deepEqual(t.scenarios.map((c) => c.id), ['SC-1', 'SC-2', 'SC-3', 'SC-4']);
  assert.equal(t.scenarios[0].title, '첫째 고침');
  assert.equal(t.scenarios[3].title, '새 대화의 첫째');
  // 그 대화에서 다시 저장: 초안 id SC-1 → 세트 SC-4 를 고쳐 쓰고, 세트 id 와 겹치는 새 초안 id SC-4 는 새로 더한다
  r = await callTool('save_tests', { title: '새 초안', scope: '', flow: [], coverage: [], scenarios: [sc('SC-1', '새 대화의 첫째 고침'), sc('SC-4', '새 대화의 둘째')], cases: [] });
  assert.equal(r.ok, true, JSON.stringify(r));
  t = testsOf('a');
  assert.deepEqual(t.scenarios.map((c) => [c.id, c.title]).slice(3), [['SC-4', '새 대화의 첫째 고침'], ['SC-5', '새 대화의 둘째']]);
});

test('패널 tests_save 는 세트 id 를 그대로 적는다(/ 나 한글이 있어도)', async () => {
  const id = '서비스A/점검';
  putYaml(data, 'store/sets/___A___.yaml', siteSet(id));
  let at = pn.mark();
  pn.send({ type: 'set_receive', id });
  await pn.waitFor((m) => m.type === 'sets' && receivedIds(m).includes(id), at, '받기');
  writeTests('___A___', { id, name: 'n', scenarios: [sc('SC-1', 'x', { use: true })], cases: [] });
  at = pn.mark();
  pn.send({ type: 'tests_save', set: id, seq: 9, suite: { scenarios: [{ id: 'SC-1', use: false }] } });
  await pn.waitFor((m) => m.type === 'tests_saved' && m.set === id, at, 'tests_saved');
  const t = testsOf('___A___');
  assert.equal(t.id, id);
  assert.equal(t.scenarios[0].use, false);
});

test('tests_clear: BDD(딸린 TDD 포함)를 지우고 목록을 다시 보낸다 · 지우기 전 목록은 보관', async () => {
  writeTests('a', { id: 'a', name: 'n', scenarios: [sc('SC-1', 'x', { use: true })], cases: [{ id: 'TC-1', scenario: 'SC-1', use: true }], flow: [{ step: 's' }], applied: true });
  const at = pn.mark();
  pn.send({ type: 'tests_clear', set: 'a', part: 'bdd' });
  const m = await pn.waitFor((x) => x.type === 'tests' && x.set === 'a' && x.suite && !x.suite.scenarios.length, at, '지운 목록');
  assert.equal(m.suite.cases.length, 0);
  assert.equal(m.suite.flow.length, 1);
  assert.equal(m.suite.applied, false);
  const arch = path.join(data, 'sets', 'a', 'tests', 'archive');
  assert.equal(fs.readdirSync(arch).length, 1);
});

test('tests_delete: 카드 하나를 지우고(BDD 는 딸린 TDD 포함) 목록을 다시 보낸다', async () => {
  writeTests('a', { id: 'a', name: 'n', scenarios: [sc('SC-1', 'x', { use: true }), sc('SC-2', 'y', { use: true })], cases: [{ id: 'TC-1', scenario: 'SC-1', use: true }, { id: 'TC-2', scenario: 'SC-2', use: true }], applied: true });
  const at = pn.mark();
  pn.send({ type: 'tests_delete', set: 'a', ids: ['SC-1'] });
  const m = await pn.waitFor((x) => x.type === 'tests' && x.set === 'a' && x.suite?.scenarios.length === 1, at, '지운 목록');
  assert.deepEqual(m.suite.scenarios.map((x) => x.id), ['SC-2']);
  assert.deepEqual(m.suite.cases.map((x) => x.id), ['TC-2']);
  assert.equal(m.suite.applied, false);
  await until(() => logsOf(data, 'a').includes('SC-1, TC-1을(를) 지웠습니다') || pn.msgs.slice(at).some((x) => x.type === 'log' && x.text.includes('SC-1, TC-1을(를) 지웠습니다')), '지운 항목 안내');
});

test('보내기: 목록이 깨졌거나 보낸 뒤 기준 버전 저장에 실패해도 호스트는 살아 있고 suite_published{ok:false}', async () => {
  const id = 'pub';
  putYaml(data, `store/sets/${id}.yaml`, { ...siteSet(id), profile: { target: { base_url: 'http://site-a.test', start_url: 'http://site-a.test/' }, deploy: { url: `http://127.0.0.1:${host.port}` } } });
  let at = pn.mark();
  pn.send({ type: 'set_receive', id });
  await pn.waitFor((m) => m.type === 'sets' && receivedIds(m).includes(id), at, '받기');
  at = pn.mark();
  pn.send({ type: 'set', id, prefs: { accounts: [] } });
  await pn.waitFor((m) => m.type === 'tests' && m.set === id, at, 'pub 의 tests');
  const tests = path.join(data, 'sets', id, 'tests');
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(tests, 'tests.json'), '{깨짐');
  at = pn.mark();
  pn.send({ type: 'publish', set: id, base_version: 0 });
  const a = await pn.waitFor((m) => m.type === 'suite_published', at, '깨진 목록의 suite_published');
  assert.equal(a.ok, false);
  assert.match(a.error, /테스트 목록을 읽지 못해/);
  assert.equal(host.p.exitCode, null);

  writeTests(id, { id, name: 'n', applied: true, base_version: 0, flow: [], coverage: [],
    scenarios: [sc('SC-1', '로그인', { use: true })], cases: [], code: { source: "test('SC-1 로그인', async () => {});\n", key: 'SC-1::' } });
  fs.chmodSync(tests, 0o555);
  try {
    at = pn.mark();
    pn.send({ type: 'publish', set: id, base_version: 0 });
    const b = await pn.waitFor((m) => m.type === 'suite_published', at, '저장 실패의 suite_published');
    assert.equal(b.ok, false);
    assert.match(b.error, /보냈지만 기준 버전을 저장하지 못했습니다/);
  } finally { fs.chmodSync(tests, 0o755); }
  await sleep(100);
  assert.equal(host.p.exitCode, null);
  // 호스트는 계속 답한다
  at = pn.mark();
  pn.send({ type: 'publish', set: id, base_version: 1 });
  const c = await pn.waitFor((m) => m.type === 'suite_published', at, '다시 보내기');
  assert.equal(c.ok, true, c.error);
  pn.send({ type: 'set', id: 'a', prefs: { accounts: [] } });
});

test('이 PC 전용 세트 고치기: 지금 세트가 작업 중이면 거절한다', async () => {
  let at = pn.mark();
  pn.send({ type: 'set_create_local', def: { name: 'loc', profile: { target: { base_url: 'http://site-a.test' }, prompt: '옛' } } });
  const made = await pn.waitFor((m) => m.type === 'sets' && m.created, at, 'created');
  const id = made.created;
  at = pn.mark();
  pn.send({ type: 'set', id, prefs: { accounts: [] } });
  await pn.waitFor((m) => m.type === 'set_active' && m.id === id, at, '로컬 세트 고르기');
  const setFile = path.join(data, 'sets', id, 'set.json');
  // 고치기(작업 없음): 사이트 지식이 바뀌어 작업 폴더를 다시 만든다
  at = pn.mark();
  pn.send({ type: 'set_update_local', id, patch: { name: 'loc2', profile: { prompt: '새 지식' } } });
  await pn.waitFor((m) => m.type === 'sets' && m.sets.some((s) => s.id === id && s.name === 'loc2'), at, '고친 뒤 sets');
  assert.equal(readJson(setFile).def.profile.prompt, '새 지식');
  assert.equal(readJson(setFile).def.profile.target.base_url, 'http://site-a.test');
  // 작업 중 거절
  pn.url = 'http://site-a.test/';
  await holdJob('reinforce', { type: 'reinforce', summary: '요약' });
  at = pn.mark();
  pn.send({ type: 'set_update_local', id, patch: { name: 'loc3' } });
  await pn.waitFor((m) => m.type === 'log' && m.kind === 'err' && /지금 세트를 고칠 수 없습니다/.test(m.text), at, '작업 중 고치기 거절');
  await stopJob();
  assert.equal(readJson(setFile).name, 'loc2');
  at = pn.mark();
  pn.send({ type: 'set', id: 'a', prefs: { accounts: [] } });
  await pn.waitFor((m) => m.type === 'set_active' && m.id === 'a', at, 'a 로 돌아가기');
});

test('저장소의 세트 버전이 오르면 GET /sets 에 바뀐 것이 보인다', async () => {
  putYaml(data, 'store/sets/a.yaml', siteSet('a', 2));
  const res = await fetch(`http://127.0.0.1:${host.port}/sets`, { headers: { Origin: EXT, 'x-koala-token': host.token } });
  assert.equal(res.status, 200);
  const a = (await res.json()).find((s) => s.id === 'a');
  assert.ok(a.update?.changed?.length > 0);
});

test('옮기지 않은 예전 데이터가 있으면 migration_needed 를 보내고 세트 작업을 거절한다', async () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-host-legacy-'));
  try {
    fs.mkdirSync(path.join(old, 'domains', 'site-a.test'), { recursive: true });
    fs.writeFileSync(path.join(old, 'domains', 'site-a.test', 'state.json'), '{}');
    putYaml(old, 'store/sets/a.yaml', siteSet('a'));
    const h = await startHost(old);
    const p2 = await connectPanel(h);
    try {
      await p2.waitFor((m) => m.type === 'migration_needed', 0, 'migration_needed');
      const at = p2.mark();
      p2.send({ type: 'set_receive', id: 'a' });
      p2.send({ type: 'set', id: 'a', prefs: {} });
      p2.send({ type: 'set_update_local', id: 'a', patch: { name: 'x' } });
      await p2.waitFor((m) => m.type === 'log' && m.text.includes('기존 데이터를 세트로 옮긴 뒤'), at, '거절 안내');
      await sleep(200);
      assert.equal(p2.msgs.slice(at).filter((m) => m.type === 'log' && m.text.includes('기존 데이터를 세트로 옮긴 뒤')).length, 3);
      assert.ok(!fs.existsSync(path.join(old, 'sets', 'a', 'set.json')));
      assert.ok(!p2.msgs.slice(at).some((m) => m.type === 'tests' || m.type === 'set_active'));
    } finally { p2.ws.close(); await stopHost(h.p); }
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
  }
});

test('미리 연결 중에 세트를 바꾸면 끝낸 Claude 의 늦은 출력이 새 세트에 섞이지 않는다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-host-switch-'));
  try {
    putYaml(root, 'store/sets/a.yaml', siteSet('a'));
    putYaml(root, 'store/sets/b.yaml', siteSet('b'));
    // a 의 가짜 Claude 만 답을 1.5초 늦게 내고 그동안 SIGTERM 을 무시한다. b 는 바로 답한다(0.6초 뒤 미리 연결):
    // b 가 제 세션을 받은 뒤에 끝낸 a 의 init 이 도착한다
    const h = await startHost(root, { FAKE_CLAUDE_INIT_DELAY_MS: '1500', FAKE_CLAUDE_DELAY_SET: 'a' });
    const p3 = await connectPanel(h);
    try {
      let at = p3.mark();
      p3.send({ type: 'set_receive', id: 'a' });
      p3.send({ type: 'set_receive', id: 'b' });
      await p3.waitFor((m) => m.type === 'sets' && receivedIds(m).includes('b'), at, '받기');
      at = p3.mark();
      p3.send({ type: 'set', id: 'a', prefs: {} });
      await p3.waitFor((m) => m.type === 'claude_conn' && m.state === 'connecting', at, 'a 미리 연결 시작');
      await sleep(400); // a 의 가짜 Claude 가 떠서 SIGTERM 을 무시하기 시작할 때까지
      p3.send({ type: 'set', id: 'b', prefs: {} });
      await until(() => stateOf(root, 'b')?.sessionId, 'b 의 세션');
      await sleep(1500); // a 의 늦은 출력(1.5초)이 지나가게
      const b = stateOf(root, 'b');
      assert.ok(b.sessionId.startsWith('fake-b-'), `b 의 세션 id 가 a 의 것: ${b.sessionId}`);
      assert.ok(!logsOf(root, 'b').includes('fake-a-') && !logsOf(root, 'b').includes('준비됨(a)'));
      assert.ok(!stateOf(root, 'a')?.sessionId, 'a 는 연결 확인 전에 끝냈다');
    } finally { p3.ws.close(); await stopHost(h.p); }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migrate: 예전 데이터를 세트로 옮기고 세트 작업을 받는다 · 두 번째는 옮긴 것 없이 ok · 작업 중에는 거절', async () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-host-migrate-'));
  const profA = { id: 'pa', name: '프로필 A', version: 2, target: { base_url: 'http://site-a.test', start_url: 'http://site-a.test/' } };
  const profB = { id: 'pb', name: '프로필 B', version: 1, target: { base_url: 'http://site-a.test' } };
  try {
    const b = path.join(old, 'domains', 'site-a.test');
    fs.mkdirSync(path.join(b, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(b, 'state.json'), JSON.stringify({ domain: 'site-a.test', sessionId: 'sess-old', sessionAlias: 'kaa-1', steps: [{ action: 'goto' }] }));
    fs.writeFileSync(path.join(b, 'recording.json'), '[]');
    fs.writeFileSync(path.join(b, 'logs', '2026-10-28.jsonl'), '{"k":"sys"}\n');
    putYaml(old, 'store/profiles/pa.yaml', { ...profA, kind: 'profile' });
    putYaml(old, 'store/profiles/pb.yaml', { ...profB, kind: 'profile' });
    // 예전 테스트 코드는 KOALA_SPIKE_DIR 의 tests/suites 에서 찾는다(개발 폴더의 것은 건드리지 않는다)
    const spk = path.join(old, 'spike');
    fs.mkdirSync(path.join(spk, 'tests', 'suites', 'site-a.test'), { recursive: true });
    fs.writeFileSync(path.join(spk, 'tests', 'suites', 'site-a.test', 'pa--s1.spec.ts'), "import { cleanup } from '../../support/cleanup';\n");
    const h = await startHost(old, { FAKE_CLAUDE_HOLD: '\\[예외·오류 보강\\]', KOALA_SPIKE_DIR: spk });
    const p = await connectPanel(h);
    const suite = { id: 'pa--s1', name: '묶음', scenarios: [{ id: 'SC-1', title: '로그인', use: true }], cases: [], flow: [], coverage: [] };
    const req = { type: 'migrate', profiles: { pa: { data: profA }, pb: { data: profB } }, activeId: 'pb',
      extSuites: { 'site-a.test': { suite, suiteBase: 1, suiteApplied: true } }, extTimelines: ['site-a.test'] };
    try {
      await p.waitFor((m) => m.type === 'migration_needed', 0, 'migration_needed');
      await p.waitFor((m) => m.type === 'sets', 0, '연결 시 sets');
      let at = p.mark();
      p.send(req);
      const r = await p.waitFor((m) => m.type === 'migrated', at, 'migrated');
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.deepEqual(r.setByProfile, { pa: 'pa', pb: 'pb' });
      assert.deepEqual(r.timelineKeys, { 'site-a.test': 'pb' });
      assert.deepEqual(r.skipped, []);
      assert.ok(r.moved > 0);
      const s = p.msgs.slice(at).find((m) => m.type === 'sets');
      assert.ok(s, '옮긴 뒤 sets');
      assert.deepEqual(receivedIds(s), ['pa', 'pb']);
      assert.ok(!fs.existsSync(path.join(old, 'domains')));
      assert.equal(stateOf(old, 'pb').sessionAlias, 'kaa-1');
      assert.equal(readJson(path.join(old, 'sets', 'pa', 'tests', 'tests.json')).scenarios[0].title, '로그인');
      assert.equal(fs.readFileSync(path.join(old, 'sets', 'pa', 'tests', 'code', 'pa.spec.ts'), 'utf8'), "import { cleanup } from '@support/cleanup';\n");
      assert.ok(!fs.existsSync(path.join(spk, 'tests', 'suites')));
      assert.ok(r.archive && fs.existsSync(path.join(r.archive, 'tests', 'suites', 'site-a.test', 'pa--s1.spec.ts')));

      // 다시 켜지 않아도 세트 작업을 받는다
      at = p.mark();
      p.send({ type: 'set', id: 'pa', prefs: {} });
      const tl = await p.waitFor((m) => m.type === 'tests' && m.set === 'pa', at, 'pa 의 tests');
      assert.equal(tl.suite.scenarios.length, 1);
      assert.ok(!p.msgs.slice(at).some((m) => m.type === 'log' && m.text.includes('기존 데이터를 세트로 옮긴 뒤')));

      // 두 번째: 옮긴 것 없이 ok, 같은 대응
      at = p.mark();
      p.send(req);
      const r2 = await p.waitFor((m) => m.type === 'migrated', at, '두 번째 migrated');
      assert.equal(r2.ok, true, JSON.stringify(r2.errors));
      assert.equal(r2.moved, 0);
      assert.deepEqual(r2.setByProfile, { pa: 'pa', pb: 'pb' });
      assert.deepEqual(r2.timelineKeys, { 'site-a.test': 'pb' });

      // 작업 중에는 거절
      at = p.mark();
      p.send({ type: 'reinforce', summary: '요약' });
      await p.waitFor((m) => m.type === 'job' && m.kind === 'reinforce' && !m.done, at, '보강 작업 시작');
      at = p.mark();
      p.send(req);
      const r3 = await p.waitFor((m) => m.type === 'migrated', at, '작업 중 migrated');
      assert.equal(r3.ok, false);
      assert.match(r3.errors.join(), /작업/);
      p.send({ type: 'stop' });
    } finally { p.ws.close(); await stopHost(h.p); }
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
  }
});

test('migrate: 패널이 프로필 없이 보내면 이 PC 저장소의 서버 프로필로 옮기고 나머지는 skipped', async () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-host-migrate-'));
  try {
    for (const d of ['site-a.test', 'site-z.test']) {
      fs.mkdirSync(path.join(old, 'domains', d), { recursive: true });
      fs.writeFileSync(path.join(old, 'domains', d, 'recording.json'), '[]');
    }
    putYaml(old, 'store/profiles/pa.yaml', { id: 'pa', kind: 'profile', name: 'A', version: 1, target: { base_url: 'http://site-a.test' } });
    const h = await startHost(old);
    const p = await connectPanel(h);
    try {
      await p.waitFor((m) => m.type === 'migration_needed', 0, 'migration_needed');
      const at = p.mark();
      p.send({ type: 'migrate', profiles: {}, activeId: null, extSuites: {}, extTimelines: [] });
      const r = await p.waitFor((m) => m.type === 'migrated', at, 'migrated');
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.deepEqual(r.setByProfile, { pa: 'pa' });
      assert.deepEqual(r.skipped, ['domains/site-z.test']);
      assert.ok(fs.existsSync(path.join(old, 'sets', 'pa', 'work', 'recording.json')));
    } finally { p.ws.close(); await stopHost(h.p); }
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
  }
});

test('migrate: 옮긴 세트의 역할·기본 역할이 호스트 프로필과 세트 상세에 보인다(인라인 역할, 이 PC 전용 프로필의 역할 문서 id)', async () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-host-migrate-'));
  const profA = { id: 'pa', name: '프로필 A', version: 1, target: { base_url: 'http://site-a.test' }, default_role: 'MEMBER',
    roles: [{ key: 'ADMIN', label: '관리자', account: { user: 'u', pass: 'secret-h1' } }, { key: 'MEMBER', label: '회원' }] };
  const profL = { id: 'local-r', name: '로컬 R', target: { base_url: 'http://site-a.test' }, roles: 'doc-roles' };
  try {
    fs.mkdirSync(path.join(old, 'domains', 'site-a.test'), { recursive: true });
    fs.writeFileSync(path.join(old, 'domains', 'site-a.test', 'recording.json'), '[]');
    putYaml(old, 'store/profiles/pa.yaml', { ...profA, kind: 'profile' });
    putYaml(old, 'store/roles/doc-roles.yaml', { id: 'doc-roles', kind: 'role', version: 1, default_role: 'B',
      roles: [{ key: 'A', label: '가', account: { user: 'd', pass: 'secret-h2' } }, { key: 'B', label: '나' }] });
    const h = await startHost(old);
    const p = await connectPanel(h);
    const effective = () => fetch(`http://127.0.0.1:${h.port}/claude/effective`, { headers: { Origin: EXT, 'x-koala-token': h.token } }).then((r) => r.json());
    try {
      await p.waitFor((m) => m.type === 'migration_needed', 0, 'migration_needed');
      await p.waitFor((m) => m.type === 'sets', 0, '연결 시 sets');
      let at = p.mark();
      p.send({ type: 'migrate', profiles: { pa: { data: profA }, 'local-r': { local: true, data: profL } }, activeId: 'pa', extSuites: {}, extTimelines: [] });
      const r = await p.waitFor((m) => m.type === 'migrated', at, 'migrated');
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      const lid = r.setByProfile['local-r'];
      const s = await p.waitFor((m) => m.type === 'sets' && receivedIds(m).includes(lid), at, '옮긴 뒤 sets');
      const of = (id) => s.sets.find((x) => x.id === id);
      assert.deepEqual(of('pa').roles.map((x) => x.key), ['ADMIN', 'MEMBER']);
      assert.equal(of('pa').default_role, 'MEMBER');
      assert.deepEqual(of(lid).roles.map((x) => x.key), ['A', 'B']);
      assert.equal(of(lid).default_role, 'B');

      at = p.mark();
      p.send({ type: 'set', id: 'pa', prefs: {} });
      await p.waitFor((m) => m.type === 'tests' && m.set === 'pa', at, 'pa 의 tests');
      let ctx = (await effective()).profileContext;
      assert.match(ctx, /- ADMIN 관리자: /);
      assert.match(ctx, /- MEMBER 회원 \(기본\)/);
      at = p.mark();
      p.send({ type: 'set', id: lid, prefs: {} });
      await p.waitFor((m) => m.type === 'tests' && m.set === lid, at, '이 PC 전용 세트의 tests');
      ctx = (await effective()).profileContext;
      assert.match(ctx, /- A 가: /);
      assert.match(ctx, /- B 나 \(기본\)/);
      assert.ok(!JSON.stringify(s).includes('secret-h1') && !ctx.includes('secret-h2'));
    } finally { p.ws.close(); await stopHost(h.p); }
  } finally {
    fs.rmSync(old, { recursive: true, force: true });
  }
});

test('작업 탭 실행: 패널이 작업 탭을 준비하지 못하면 기다리다 오류로 끝낸다(새 브라우저로 몰래 바꾸지 않음)', async () => {
  pn.send({ type: 'run_where', where: 'tab' });
  const code = path.join(data, 'sets', 'a', 'tests', 'code', 'a.spec.ts');
  fs.mkdirSync(path.dirname(code), { recursive: true });
  fs.writeFileSync(code, "import { test } from '@playwright/test';\ntest('SC-1 x', async () => {});\n");
  pn.send({ type: 'set', id: 'a', prefs: { accounts: [] } });
  await sleep(300);
  const at = pn.mark();
  pn.send({ type: 'run_code', suite: { scenarios: [{ id: 'SC-1', title: 'x', given: [], when: [], then: [] }], cases: [] }, ids: [] });
  await pn.waitFor((m) => m.type === 'relay_open', at, 'relay_open 요청');
  // 답하지 않는다 → 5초 뒤 오류
  await until(() => pn.msgs.slice(at).some((m) => m.type === 'log' && /작업 탭에서 실행하지 못했습니다/.test(m.text)), '작업 탭 실행 실패 안내', 9000);
  assert.ok(!fs.readdirSync(path.dirname(code)).some((f) => f.includes('koala-tab')), '사본이 남지 않는다');
  pn.send({ type: 'run_where', where: 'browser' });
});
