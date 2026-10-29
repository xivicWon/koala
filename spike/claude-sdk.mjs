// API 요금제 실행: Claude Code CLI 대신 Agent SDK(@anthropic-ai/claude-agent-sdk)로 Claude 를 돌린다.
// Console API 키로 과금되고, 요청은 Agent SDK 사용으로 표시된다(프로모션 크레딧의 '적용 대상').
// 호스트가 CLI 프로세스를 다루던 그대로 쓰도록 프로세스 모양(stdin.write · kill · 'exit' 이벤트)으로 감싼다.
// SDK 가 내는 메시지는 CLI 의 stream-json 출력과 같은 모양이라 호스트의 handleEvent 가 그대로 읽는다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// 키는 이 PC 의 파일 하나에만 둔다(본인만 읽기 0600). 패널로는 '있음/없음'만 보낸다
export const keyFile = () => process.env.KOALA_API_KEY_FILE || path.join(os.homedir(), '.koala', 'anthropic-api-key');
const KEY_RE = /^sk-ant-[\w-]{20,}$/;

export function readKey() {
  try { const k = fs.readFileSync(keyFile(), 'utf8').trim(); return KEY_RE.test(k) ? k : null; } catch { return null; }
}
export function keyStatus() {
  const f = keyFile();
  if (!fs.existsSync(f)) return { saved: false, file: f };
  return readKey() ? { saved: true, file: f } : { saved: false, file: f, invalid: true };
}
export function saveKey(key) {
  const k = String(key || '').trim();
  if (!KEY_RE.test(k)) throw new Error('API 키 형식이 아닙니다(sk-ant- 로 시작하는 Console 키)');
  const f = keyFile();
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, `${k}\n`, { mode: 0o600 });
  fs.chmodSync(f, 0o600); // 이미 있던 파일이면 writeFileSync 의 mode 가 적용되지 않는다
}
export function deleteKey() { fs.rmSync(keyFile(), { force: true }); }

// CLI 인자(호스트가 만든 것)를 SDK 옵션으로 옮긴다. 같은 인자에서 출발해 두 방식이 어긋나지 않게 한다
export function optionsFromArgs(args) {
  const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const o = {
    includePartialMessages: args.includes('--include-partial-messages'),
    strictMcpConfig: args.includes('--strict-mcp-config'),
  };
  if (val('--setting-sources') !== undefined) o.settingSources = val('--setting-sources').split(',').filter(Boolean);
  if (val('--tools') !== undefined) o.tools = val('--tools').split(',').filter(Boolean);
  if (val('--allowedTools')) o.allowedTools = val('--allowedTools').split(',').filter(Boolean);
  // claude -p 의 --append-system-prompt 는 Claude Code 기본 시스템 프롬프트 뒤에 붙는다. SDK 기본값은 최소 프롬프트라 명시한다
  if (val('--append-system-prompt')) o.systemPrompt = { type: 'preset', preset: 'claude_code', append: val('--append-system-prompt') };
  if (val('--model')) o.model = val('--model');
  if (val('--effort')) o.effort = val('--effort');
  if (val('--resume')) o.resume = val('--resume');
  if (val('--mcp-config')) o.mcpServers = JSON.parse(fs.readFileSync(val('--mcp-config'), 'utf8')).mcpServers || {};
  const streaming = val('--input-format') === 'stream-json';
  return { options: o, prompt: streaming ? null : val('-p') };
}

// SDK 로 실행한다. 반환값은 CLI 프로세스처럼 쓴다: p.stdin.write(stream-json 한 줄) · p.kill() · p.on('event'|'stderr'|'exit')
// claudeBin: 이미 설치된 claude 실행 파일(SDK 의 플랫폼별 실행 파일은 설치하지 않는다)
export function runSdk(args, { cwd, env, claudeBin, key }) {
  const p = new EventEmitter();
  const { options, prompt } = optionsFromArgs(args);
  const abort = new AbortController();
  const queue = [];
  let wake = null;
  let closed = false;
  async function* input() {
    while (!closed) {
      if (queue.length) { yield queue.shift(); continue; }
      await new Promise((r) => { wake = r; });
      wake = null;
    }
  }
  p.stdin = {
    write(line) {
      const m = JSON.parse(line);
      queue.push({ type: 'user', message: m.message, parent_tool_use_id: null });
      wake?.();
      return true;
    },
  };
  p.kill = () => { closed = true; wake?.(); abort.abort(); };
  const runEnv = { ...env, ANTHROPIC_API_KEY: key };
  delete runEnv.CLAUDECODE;
  delete runEnv.CLAUDE_CODE_OAUTH_TOKEN; // 구독 로그인으로 새지 않게 한다
  (async () => {
    let code = 0;
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const q = query({
        prompt: prompt ?? input(),
        options: {
          ...options, cwd, env: runEnv, abortController: abort,
          ...(claudeBin && !/\.m?js$/.test(claudeBin) ? { pathToClaudeCodeExecutable: claudeBin } : {}),
          stderr: (d) => p.emit('stderr', String(d)),
        },
      });
      for await (const ev of q) p.emit('event', ev);
    } catch (e) {
      if (!abort.signal.aborted) { code = 1; p.emit('stderr', String(e?.message || e)); }
    }
    closed = true;
    p.emit('exit', abort.signal.aborted ? null : code);
  })();
  return p;
}
