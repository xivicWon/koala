// API 요금제(Agent SDK) 실행: CLI 인자 → SDK 옵션 변환과 API 키 파일 다루기
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-sdk-'));
process.env.KOALA_API_KEY_FILE = path.join(tmp, 'sub', 'anthropic-api-key'); // 사용자의 실제 키 파일은 건드리지 않는다
const sdk = await import('../claude-sdk.mjs');
const KEY = `sk-ant-api03-${'x'.repeat(40)}`;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('optionsFromArgs: 상주 실행 인자를 SDK 옵션으로 옮긴다', () => {
  const mcp = path.join(tmp, 'mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { koala: { command: 'node', args: ['m.mjs'] } } }));
  const { options, prompt } = sdk.optionsFromArgs(['-p', '--input-format', 'stream-json', '--resume', 'sid-1',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', mcp, '--strict-mcp-config', '--setting-sources', 'project',
    '--tools', '', '--allowedTools', 'mcp__koala__click,mcp__koala__tabs',
    '--append-system-prompt', 'koa 규칙', '--model', 'haiku', '--effort', 'low']);
  assert.equal(prompt, null); // 지시는 stdin(스트림)으로 받는다
  assert.deepEqual(options, {
    includePartialMessages: true, strictMcpConfig: true, settingSources: ['project'], tools: [],
    allowedTools: ['mcp__koala__click', 'mcp__koala__tabs'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'koa 규칙' },
    model: 'haiku', effort: 'low', resume: 'sid-1',
    mcpServers: { koala: { command: 'node', args: ['m.mjs'] } },
  });
});

test('optionsFromArgs: 한 번 실행(-p <지시>)은 지시를 prompt 로', () => {
  const { prompt, options } = sdk.optionsFromArgs(['-p', '안녕', '--effort', 'high']);
  assert.equal(prompt, '안녕');
  assert.equal(options.effort, 'high');
  assert.equal(options.model, undefined);
});

test('API 키: 형식을 검사하고 본인만 읽기(0600)로 저장, 지우면 없음', () => {
  assert.deepEqual(sdk.keyStatus(), { saved: false, file: sdk.keyFile() });
  assert.throws(() => sdk.saveKey('not-a-key'), /API 키 형식/);
  sdk.saveKey(`  ${KEY}\n`);
  assert.equal(sdk.readKey(), KEY);
  assert.equal(sdk.keyStatus().saved, true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(sdk.keyFile()).mode & 0o777, 0o600);
  // 이미 있던 파일의 권한이 넓어도 저장하면 0600 으로 좁힌다
  if (process.platform !== 'win32') { fs.chmodSync(sdk.keyFile(), 0o644); sdk.saveKey(KEY); assert.equal(fs.statSync(sdk.keyFile()).mode & 0o777, 0o600); }
  fs.writeFileSync(sdk.keyFile(), 'garbage');
  assert.deepEqual(sdk.keyStatus(), { saved: false, file: sdk.keyFile(), invalid: true });
  sdk.deleteKey();
  assert.equal(sdk.keyStatus().saved, false);
});
