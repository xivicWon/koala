// Codex(로컬 CLI) 실행: 인자 만들기, 이벤트 → Claude 모양 변환, 지시마다 같은 대화 잇기, 전용 CODEX_HOME 의 로그인 링크
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as codex from '../codex-cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-codex.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-codex-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('codexArgs: 셸·플러그인을 끄고 koala MCP 만 켠다. 이어받기는 resume <id> -', () => {
  const mcpServers = { koala: { command: '/bin/node', args: ['/x/mcp-server.mjs'], env: { KOALA_PORT: '8765' } } };
  const a = codex.codexArgs({ mcpServers, tools: ['click', 'snapshot'], instructions: '규칙 "하나"\n둘', model: 'gpt-x', effort: 'high' });
  assert.deepEqual(a.slice(0, 4), ['exec', '--json', '--skip-git-repo-check', '--disable']);
  for (const f of ['shell_tool', 'apps', 'plugins', 'hooks', 'memories']) assert.ok(a.join(' ').includes(`--disable ${f}`));
  const c = (k) => a[a.indexOf(a.find((x) => x.startsWith(`${k}=`)))];
  assert.equal(c('approval_policy'), 'approval_policy="never"');
  assert.equal(c('mcp_servers.koala.command'), 'mcp_servers.koala.command="/bin/node"');
  assert.equal(c('mcp_servers.koala.env'), 'mcp_servers.koala.env={KOALA_PORT="8765"}');
  assert.equal(c('mcp_servers.koala.enabled_tools'), 'mcp_servers.koala.enabled_tools=["click","snapshot"]');
  assert.equal(c('developer_instructions'), 'developer_instructions="규칙 \\"하나\\"\\n둘"'); // TOML 기본 문자열
  assert.ok(a.includes('-s'));
  assert.deepEqual(a.slice(-1), ['-']);
  const r = codex.codexArgs({ resume: 'thread-9' });
  assert.deepEqual(r.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(r.slice(-2), ['thread-9', '-']);
  assert.ok(!r.includes('-s')); // resume 은 샌드박스 옵션을 받지 않는다
});

test('translate: 대화 id·도구 호출·글·사용량을 Claude stream-json 모양으로', () => {
  const st = { model: 'gpt-x', turns: 0 };
  assert.deepEqual(codex.translate({ type: 'thread.started', thread_id: 't1' }, st), [{ type: 'system', subtype: 'init', session_id: 't1', model: 'gpt-x' }]);
  codex.translate({ type: 'turn.started' }, st);
  const call = codex.translate({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'koala', tool: 'click', arguments: { ref: 'e3' } } }, st);
  assert.equal(call[0].event.content_block.name, 'mcp__koala__click');
  assert.deepEqual(call[1].message.content[0], { type: 'tool_use', id: 'i1', name: 'mcp__koala__click', input: { ref: 'e3' } });
  const done = codex.translate({ type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'koala', tool: 'click', status: 'failed', error: { message: '못 찾음' } } }, st);
  assert.equal(done[1].message.content[0].is_error, true);
  const text = codex.translate({ type: 'item.completed', item: { type: 'agent_message', text: '끝' } }, st);
  assert.equal(text[1].message.content[0].text, '끝');
  const [res] = codex.translate({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7, reasoning_output_tokens: 3 } }, st);
  assert.deepEqual(res, { type: 'result', subtype: 'success', is_error: false, result: '끝', num_turns: 2, usage: { input_tokens: 40, cache_read_input_tokens: 60, output_tokens: 10 } });
  const [fail] = codex.translate({ type: 'turn.failed', error: { message: 'usage limit' } }, st);
  assert.equal(fail.is_error, true);
  assert.equal(fail.result, 'usage limit');
});

// 가짜 codex 를 돌려 이벤트를 모은다. 결과(result) n개를 받으면 끝
function collect(p, n) {
  const evs = [];
  return new Promise((ok) => p.on('event', (e) => { evs.push(e); if (evs.filter((x) => x.type === 'result').length === n) ok(evs); }));
}

test('runCodex: 지시마다 codex 를 띄우고, 두 번째부터는 받은 대화 id 로 resume 한다', async () => {
  const log = path.join(tmp, 'args.jsonl');
  const home = path.join(tmp, 'home-run');
  const p = codex.runCodex({ bin: FAKE, cwd: tmp, home, env: { ...process.env, FAKE_CODEX_LOG: log }, mcpServers: {}, tools: ['snapshot'] });
  const got = collect(p, 2);
  p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '도구 써' } }));
  p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '다음' } }));
  const evs = await got;
  const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].home, home); // 전용 CODEX_HOME
  assert.ok(!runs[0].args.includes('resume'));
  assert.deepEqual(runs[1].args.slice(0, 2), ['exec', 'resume']);
  assert.equal(runs[1].args[runs[1].args.length - 2], 'thread-1');
  assert.ok(evs.some((e) => e.type === 'assistant' && e.message.content[0].name === 'mcp__koala__snapshot'));
  assert.deepEqual(evs.filter((e) => e.type === 'assistant' && e.message.content[0].type === 'text').map((e) => e.message.content[0].text), ['받음: 도구 써', '받음: 다음']);
  let exited = false;
  p.on('exit', () => { exited = true; });
  p.kill();
  assert.equal(exited, true);
});

test('runCodex: 결과 없이 끝나면(로그인 풀림 등) 마지막 오류로 실패 결과를 낸다', async () => {
  const p = codex.runCodex({ bin: FAKE, cwd: tmp, home: path.join(tmp, 'home-fail'), mcpServers: {} });
  const got = collect(p, 1);
  p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: '죽어' } }));
  const [res] = (await got).filter((e) => e.type === 'result');
  assert.equal(res.is_error, true);
  assert.match(res.result, /not logged in/);
  p.kill();
});

test('prepareHome: 로그인 파일만 링크하고, 갱신돼 파일로 바뀌었으면 사용자 쪽으로 돌려놓고 다시 링크한다', () => {
  const src = path.join(tmp, 'user-codex');
  const home = path.join(tmp, 'koala-codex');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'auth.json'), '{"v":1}');
  fs.writeFileSync(path.join(src, 'config.toml'), 'model = "gpt-mine"\nmodel_reasoning_effort = "high"\n[mcp_servers.mysql]\ncommand = "x"\n');
  codex.prepareHome(home, src);
  assert.ok(fs.lstatSync(path.join(home, 'auth.json')).isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(home, 'config.toml'))); // 개인 설정(MCP 서버 등)은 가져오지 않는다
  // Codex 가 토큰을 갱신하며 링크를 파일로 바꿔 쓴 경우
  fs.rmSync(path.join(home, 'auth.json'));
  fs.writeFileSync(path.join(home, 'auth.json'), '{"v":2}');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(home, 'auth.json'), later, later);
  codex.prepareHome(home, src);
  assert.equal(fs.readFileSync(path.join(src, 'auth.json'), 'utf8'), '{"v":2}');
  assert.ok(fs.lstatSync(path.join(home, 'auth.json')).isSymbolicLink());
  assert.deepEqual(codex.userDefaults(src), { model: 'gpt-mine', effort: 'high' });
});
