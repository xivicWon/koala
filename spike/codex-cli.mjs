// Codex 실행: 이 PC 에 설치·로그인된 codex CLI(ChatGPT 로그인)로 돌린다. API 키는 쓰지 않는다.
// codex exec 는 지시 한 번에 프로세스 하나라, 지시마다 `codex exec resume <대화 id>` 로 같은 대화를 잇는다.
// 호스트가 Claude 프로세스를 다루던 그대로 쓰도록 프로세스 모양(stdin.write · kill · 'event'|'stderr'|'exit')으로 감싸고,
// Codex 의 JSON 이벤트를 Claude stream-json 모양으로 바꿔 호스트의 handleEvent 가 그대로 읽게 한다.
// 개인 Codex 설정(~/.codex 의 MCP 서버·AGENTS.md·플러그인·hooks)이 섞이지 않게 koala 전용 CODEX_HOME 을 쓰고, 로그인 파일만 링크한다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';

const WIN = process.platform === 'win32';
// 사용자의 Codex 폴더(로그인·모델 기본값을 읽는 곳)와 koala 가 Codex 를 돌리는 폴더
export const userHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const koalaHome = () => process.env.KOALA_CODEX_HOME || path.join(os.homedir(), '.koala', 'codex');

// 터미널 도구(cmux 등)가 PATH 앞에 끼운 대리 실행 파일은 건너뛴다(실행마다 경고·옵션을 덧붙인다)
export function findCodex() {
  const home = os.homedir();
  const fromPath = (() => {
    try { return execFileSync(WIN ? 'where' : 'which', WIN ? ['codex'] : ['-a', 'codex'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean).map((s) => s.trim()); } catch { return []; }
  })().filter((p) => !/cli-shims/.test(p));
  const candidates = [
    process.env.CODEX_BIN, ...fromPath,
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(home, '.local', 'bin', WIN ? 'codex.exe' : 'codex'),
    WIN && path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
  ].filter(Boolean);
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}
// CODEX_BIN 이 .mjs/.js 면(시험용 가짜 Codex) 이 node 로 돌린다
export const codexCmd = (bin, args) => (/\.m?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args]);

// 설치·로그인 확인. 계정 정보는 돌려주지 않는다
export function checkCodex(bin) {
  if (!bin) return { ok: false, reason: 'codex_not_installed' };
  const run = (args) => { const [c, a] = codexCmd(bin, args); return execFileSync(c, a, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], shell: WIN && bin.endsWith('.cmd') }); };
  try {
    const version = run(['--version']).trim();
    try { run(['login', 'status']); } catch { return { ok: false, reason: 'codex_not_logged_in', version }; }
    return { ok: true, version, method: 'codex' };
  } catch (e) {
    return { ok: false, reason: 'check_failed', detail: String(e.message).slice(0, 200) };
  }
}

// 사용자 Codex 설정의 모델·effort 기본값(~/.codex/config.toml 맨 위 값만). koala 전용 폴더에는 설정 파일을 두지 않으므로 여기서 읽어 넘긴다
export function userDefaults(home = userHome()) {
  let text = '';
  try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch {}
  const top = text.split(/^\s*\[/m)[0];
  const val = (k) => top.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] || '';
  return { model: val('model'), effort: val('model_reasoning_effort') };
}
// 고를 수 있는 모델: Codex 가 받아 둔 목록(models_cache.json)에서 보이는 것만
export function listModels(home = userHome()) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'));
    return (j.models || j || []).filter((m) => (m.visibility || 'list') === 'list').map((m) => ({
      id: m.slug || m.id, name: m.display_name || m.slug || m.id,
      efforts: (m.supported_reasoning_levels || []).map((l) => l.effort || l).filter((x) => typeof x === 'string'),
    })).filter((m) => m.id);
  } catch { return []; }
}

// koala 전용 CODEX_HOME: 로그인 파일(auth.json)만 사용자 것을 링크한다.
// Codex 가 토큰을 갱신하며 링크 대신 파일을 새로 썼으면, 새 토큰을 사용자 쪽으로 돌려놓고 다시 링크한다(두 곳이 어긋나 로그아웃되지 않게)
export function prepareHome(home = koalaHome(), src = userHome()) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const link = path.join(home, 'auth.json');
  const real = path.join(src, 'auth.json');
  let st = null;
  try { st = fs.lstatSync(link); } catch {}
  if (st && !st.isSymbolicLink()) {
    let srcTime = 0;
    try { srcTime = fs.statSync(real).mtimeMs; } catch {}
    if (st.mtimeMs > srcTime) { fs.copyFileSync(link, real); fs.chmodSync(real, 0o600); }
    fs.rmSync(link, { force: true });
    st = null;
  }
  if (!st && fs.existsSync(real)) {
    try { fs.symlinkSync(real, link); } catch { fs.copyFileSync(real, link); } // 링크를 못 만드는 환경(Windows 권한)은 복사
  }
  return home;
}

// -c 값은 TOML 로 읽힌다. JSON 문자열·배열 표기는 TOML 의 기본 문자열·배열과 같다
const toml = (v) => {
  if (Array.isArray(v)) return `[${v.map(toml).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${/^[\w-]+$/.test(k) ? k : JSON.stringify(k)}=${toml(x)}`).join(',')}}`;
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
};

// codex exec 인자. 셸·파일 수정·웹 검색·플러그인은 끄고 koala 도구(MCP)만 쓴다. 도구는 묻지 않고 바로 실행한다(승인 대화를 띄울 곳이 없다)
export function codexArgs({ resume, mcpServers = {}, tools = [], instructions = '', model = '', effort = '' }) {
  const a = ['exec'];
  if (resume) a.push('resume');
  a.push('--json', '--skip-git-repo-check');
  for (const f of ['shell_tool', 'apps', 'plugins', 'hooks', 'memories']) a.push('--disable', f);
  if (!resume) a.push('-s', 'read-only'); // resume 은 처음 대화의 샌드박스를 잇는다(옵션을 받지 않는다)
  const c = (k, v) => a.push('-c', `${k}=${toml(v)}`);
  c('approval_policy', 'never');
  c('web_search', 'disabled');
  c('project_doc_max_bytes', 262144); // 합친 AGENTS.md 가 기본 한도(32KiB)에 잘리지 않게
  for (const [name, s] of Object.entries(mcpServers)) {
    c(`mcp_servers.${name}.command`, s.command);
    c(`mcp_servers.${name}.args`, s.args || []);
    if (s.env) c(`mcp_servers.${name}.env`, s.env);
    if (tools.length) c(`mcp_servers.${name}.enabled_tools`, tools);
    c(`mcp_servers.${name}.default_tools_approval_mode`, 'approve');
    c(`mcp_servers.${name}.startup_timeout_sec`, 30);
    c(`mcp_servers.${name}.tool_timeout_sec`, 1800); // 테스트 실행처럼 오래 걸리는 도구(기본 60초)
  }
  if (instructions) c('developer_instructions', instructions);
  if (model) a.push('-m', model);
  if (effort) c('model_reasoning_effort', effort);
  if (resume) a.push(resume);
  a.push('-'); // 지시는 stdin 으로(인자 길이·따옴표 문제 없이)
  return a;
}

// Codex 이벤트 하나 → Claude stream-json 이벤트 목록. st 는 실행 하나의 상태({ model, threadId, turns, lastText, error })
export function translate(ev, st) {
  const tool = (it) => `mcp__${it.server}__${it.tool}`;
  const it = ev.item || {};
  switch (ev.type) {
    case 'thread.started':
      st.threadId = ev.thread_id;
      return [{ type: 'system', subtype: 'init', session_id: ev.thread_id, model: st.model || 'codex' }];
    case 'turn.started':
      st.turns = 0; st.lastText = ''; st.error = '';
      return [];
    case 'item.started':
      if (it.type !== 'mcp_tool_call') return [];
      st.turns += 1;
      return [
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: tool(it) } } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: it.id, name: tool(it), input: it.arguments || {} }] } },
      ];
    case 'item.completed':
      if (it.type === 'agent_message') {
        st.lastText = it.text || '';
        return [
          { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: it.text || '' }] } },
        ];
      }
      if (it.type === 'reasoning') {
        return [{ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } },
          { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: it.text || '' }] } }];
      }
      if (it.type === 'mcp_tool_call') {
        const failed = it.status !== 'completed' || !!it.error || !!it.result?.is_error;
        return [
          { type: 'stream_event', event: { type: 'content_block_stop' } },
          { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: it.id, is_error: failed, content: it.error?.message || it.result?.content || [] }] } },
        ];
      }
      if (it.type === 'error') st.warn = it.message;
      return [];
    case 'error':
      st.error = ev.message || '';
      return [];
    case 'turn.completed': {
      const u = ev.usage || {};
      const cached = u.cached_input_tokens || 0;
      return [{ type: 'result', subtype: 'success', is_error: false, result: st.lastText, num_turns: st.turns + 1,
        usage: { input_tokens: Math.max(0, (u.input_tokens || 0) - cached), cache_read_input_tokens: cached, output_tokens: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0) } }];
    }
    case 'turn.failed':
      return [{ type: 'result', subtype: 'error', is_error: true, result: ev.error?.message || st.error || 'Codex 작업이 실패했습니다', num_turns: st.turns + 1 }];
    default:
      return [];
  }
}

// 실행한다. 반환값은 CLI 프로세스처럼 쓴다: p.stdin.write(stream-json 한 줄) · p.kill() · p.on('event'|'stderr'|'exit')
// prompt 가 있으면 한 번만 돌고 끝낸다(매번 기동 모드). 없으면 stdin 으로 지시를 받을 때마다 같은 대화로 이어 돌린다
export function runCodex({ bin, cwd, env = process.env, home = koalaHome(), resume = null, prompt = null, ...opts }) {
  const p = new EventEmitter();
  const st = { model: opts.model || '', threadId: resume, turns: 0, lastText: '', error: '' };
  const queue = [];
  let child = null;
  let closed = false;
  const runEnv = { ...env, CODEX_HOME: home };
  function next() {
    if (child || closed) return;
    if (!queue.length) { if (prompt != null) { closed = true; p.emit('exit', 0); } return; }
    const text = queue.shift();
    try { prepareHome(home); } catch (e) { p.emit('stderr', `Codex 폴더를 준비하지 못했습니다: ${e.message}`); }
    const [cmd, argv] = codexCmd(bin, codexArgs({ ...opts, resume: st.threadId }));
    let ended = false;
    let buf = '';
    let errTail = '';
    child = spawn(cmd, argv, { cwd, env: runEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: WIN && bin.endsWith('.cmd') });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        for (const out of translate(ev, st)) {
          if (out.type === 'result') ended = true;
          if (!closed) p.emit('event', out);
        }
      }
    });
    // 'Reading additional input from stdin...' 같은 안내는 오류가 아니다
    child.stderr.on('data', (d) => { const s = String(d); if (/^Reading (additional )?(input|prompt) from stdin/m.test(s.trim()) && s.trim().split('\n').length === 1) return; errTail = (errTail + s).slice(-2000); p.emit('stderr', s); });
    child.on('error', (e) => { errTail = e.message; });
    child.on('close', (code) => {
      child = null;
      if (closed) return;
      // 결과 이벤트 없이 끝났으면(로그인 풀림·잘못된 옵션 등) 마지막 오류를 담아 실패로 알린다
      if (!ended) p.emit('event', { type: 'result', subtype: 'error', is_error: true, num_turns: 0, result: st.error || errTail.trim().split('\n').slice(-1)[0] || `codex 종료 코드 ${code}` });
      next();
    });
    child.stdin.end(text);
  }
  p.stdin = {
    write(line) {
      const m = JSON.parse(line);
      const c = m.message?.content;
      queue.push(typeof c === 'string' ? c : (c || []).map((x) => x.text || '').join('\n'));
      next();
      return true;
    },
  };
  p.kill = () => {
    if (closed) return;
    closed = true;
    try { child?.kill(); } catch {}
    p.emit('exit', null);
  };
  if (prompt != null) { queue.push(prompt); setImmediate(next); }
  return p;
}
