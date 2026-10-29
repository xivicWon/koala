#!/usr/bin/env node
import fs from 'node:fs';
// 시험용 가짜 Claude CLI: 실제 Claude를 부르지 않는다(CLAUDE_BIN 으로 지정).
//   --version, auth status → checkClaude() 가 사용 가능으로 보게 답한다
//   -p --input-format stream-json → 받은 줄마다 init(처음 한 번)·짧은 답·result 를 낸다
//   -p <글> → 한 번 답하고 끝난다
// 세션 id 는 fake-<세트 id>-… (작업 폴더 sets/<세트>/work/claude 에서 뽑는다)라 어느 세트의 대화인지 시험에서 알 수 있다.
// 시험용 환경변수:
//   FAKE_CLAUDE_INIT_DELAY_MS — 답을 이만큼 늦게 낸다. 그동안 SIGTERM 을 무시해, 끝낸 뒤에도 늦은 출력이 오는 경우를 만든다
//   FAKE_CLAUDE_DELAY_SET     — 주면 이 세트의 작업 폴더에서 돌 때만 늦춘다
//   FAKE_CLAUDE_HOLD          — 이 정규식에 맞는 지시에는 result 를 내지 않는다(작업이 진행 중인 채로 둔다)
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.0.0 (fake claude)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'fake' })); process.exit(0); }

const setId = path.basename(path.resolve(process.cwd(), '..', '..'));
const resume = args.indexOf('--resume');
const sessionId = resume >= 0 ? args[resume + 1] : `fake-${setId}-${randomUUID()}`;
const delay = !process.env.FAKE_CLAUDE_DELAY_SET || process.env.FAKE_CLAUDE_DELAY_SET === setId ? Number(process.env.FAKE_CLAUDE_INIT_DELAY_MS) || 0 : 0;
const hold = process.env.FAKE_CLAUDE_HOLD ? new RegExp(process.env.FAKE_CLAUDE_HOLD) : null;
const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
let started = false;
let waiting = 0;
let ended = false;
if (delay) process.on('SIGTERM', () => { ended = true; });
function answer(text = '') {
  if (!started) { started = true; out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model' }); }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `준비됨(${setId})` }] }, session_id: sessionId });
  if (hold?.test(text)) return;
  out({ type: 'result', is_error: false, num_turns: 1, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 } });
}
const later = (text) => {
  if (!delay) return answer(text);
  waiting++;
  setTimeout(() => { answer(text); waiting--; if (ended && !waiting) process.exit(0); }, delay);
};

if (args.includes('stream-json') && args[args.indexOf('--input-format') + 1] === 'stream-json') {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let text = '';
      try { text = JSON.stringify(JSON.parse(line).message?.content ?? ''); } catch {}
      if (process.env.FAKE_CLAUDE_DUMP) fs.appendFileSync(process.env.FAKE_CLAUDE_DUMP, `${text}\n`); // 시험: Claude 가 받은 지시를 남긴다
      later(text);
    }
  });
  process.stdin.on('end', () => { ended = true; if (!waiting) process.exit(0); });
} else {
  later(args[args.indexOf('-p') + 1] || '');
}
