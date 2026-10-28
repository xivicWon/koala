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

const hosts = [];
async function startHost(data, extraEnv = {}) {
  const port = await freePort();
  assert.notEqual(port, 8765);
  const env = { ...process.env, KOALA_PORT: String(port), KOALA_DATA_DIR: data, KOALA_HEADED: '0', CLAUDE_BIN: FAKE_CLAUDE,
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
  return pn;
}

let data, host, pn;
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

  pn.send({ type: 'tests_save', set: 'a', suite: { ...first.suite, scenarios: [{ id: 'SC-1', title: '로그인', use: true }] } });
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
  pn.send({ type: 'tests_save', set: 'a', suite: { id: 'a', name: 'a',
    scenarios: [sc('SC-1', '옛 제목', { use: false, tags: ['@mine'], issue: 'ISSUE-1' })],
    cases: [{ id: 'TC-1', scenario: 'SC-1', title: '옛 케이스', use: false, tags: ['@mine'] }] } });

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
      await p2.waitFor((m) => m.type === 'log' && m.text.includes('기존 데이터를 세트로 옮긴 뒤'), at, '거절 안내');
      await sleep(200);
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
