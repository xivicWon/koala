import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const spike = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'unit-test-mcp-env';
const wsDir = path.join(spike, 'workspaces', ID);
const probe = `import('./workspace.mjs').then((w) => console.log(JSON.stringify(w.prepare({ id: '${ID}', version: 1 }))))`;
const prepare = (env) => {
  const clean = { ...process.env };
  delete clean.KOALA_DATA_DIR;
  delete clean.KOALA_PORT;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: spike, env: { ...clean, ...env }, encoding: 'utf8' }));
  return JSON.parse(fs.readFileSync(out.mcpConfig, 'utf8')).mcpServers.koala.env;
};

test('prepare()는 포트·데이터 폴더가 바뀌면 mcp.json 의 env 를 다시 쓴다', (t) => {
  t.after(() => fs.rmSync(wsDir, { recursive: true, force: true }));
  fs.rmSync(wsDir, { recursive: true, force: true });
  assert.deepEqual(prepare({ KOALA_PORT: '8799', KOALA_DATA_DIR: '/tmp/koala-a' }), { KOALA_PORT: '8799', KOALA_DATA_DIR: '/tmp/koala-a' });
  assert.deepEqual(prepare({ KOALA_PORT: '8798', KOALA_DATA_DIR: '/tmp/koala-b' }), { KOALA_PORT: '8798', KOALA_DATA_DIR: '/tmp/koala-b' });
});
