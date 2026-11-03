// 시험용 가짜 codex: exec(--json) 이벤트를 흉내 낸다. 받은 인자는 FAKE_CODEX_LOG 파일에 한 줄씩 남긴다
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ args, home: process.env.CODEX_HOME })}\n`);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (input.includes('죽어')) { process.stderr.write('Error: not logged in\n'); process.exit(1); }
  const i = args.indexOf('resume');
  const thread = i >= 0 ? args[args.length - 2] : 'thread-1';
  out({ type: 'thread.started', thread_id: thread });
  out({ type: 'turn.started' });
  if (input.includes('도구')) {
    out({ type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'koala', tool: 'snapshot', arguments: {}, status: 'in_progress' } });
    out({ type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'koala', tool: 'snapshot', arguments: {}, result: { content: [{ type: 'text', text: 'ok' }] }, error: null, status: 'completed' } });
  }
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: `받음: ${input.trim()}` } });
  out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7, reasoning_output_tokens: 3 } });
});
