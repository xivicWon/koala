#!/usr/bin/env node
// 시험용 가짜 Claude CLI: 실제 Claude를 부르지 않는다(CLAUDE_BIN 으로 지정).
//   --version, auth status → checkClaude() 가 사용 가능으로 보게 답한다
//   -p --input-format stream-json → 받은 줄마다 init(처음 한 번)·짧은 답·result 를 낸다
//   -p <글> → 한 번 답하고 끝난다
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.0.0 (fake claude)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'fake' })); process.exit(0); }

const resume = args.indexOf('--resume');
const sessionId = resume >= 0 ? args[resume + 1] : randomUUID();
const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
let started = false;
function answer() {
  if (!started) { started = true; out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model' }); }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: '준비됨' }] }, session_id: sessionId });
  out({ type: 'result', is_error: false, num_turns: 1, session_id: sessionId, usage: { input_tokens: 1, output_tokens: 1 } });
}

if (args.includes('stream-json') && args[args.indexOf('--input-format') + 1] === 'stream-json') {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) answer();
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  answer();
}
