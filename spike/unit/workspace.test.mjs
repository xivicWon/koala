import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const spike = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'unit-test-mcp-env';
const probe = `import('./workspace.mjs').then((w) => console.log(JSON.stringify(w.prepare({ id: '${ID}', version: 1 }))))`;
const prepare = (env) => {
  const clean = { ...process.env };
  delete clean.KOALA_DATA_DIR;
  delete clean.KOALA_PORT;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: spike, env: { ...clean, ...env }, encoding: 'utf8' }));
  return JSON.parse(fs.readFileSync(out.mcpConfig, 'utf8')).mcpServers.koala.env;
};

test('prepare()는 포트·데이터 폴더가 바뀌면 mcp.json 의 env 를 다시 쓴다', (t) => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-ws-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-ws-b-'));
  t.after(() => { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); });
  assert.deepEqual(prepare({ KOALA_PORT: '8799', KOALA_DATA_DIR: a }), { KOALA_PORT: '8799', KOALA_DATA_DIR: a });
  assert.deepEqual(prepare({ KOALA_PORT: '8798', KOALA_DATA_DIR: b }), { KOALA_PORT: '8798', KOALA_DATA_DIR: b });
});

test('작업 폴더는 세트 폴더의 work/claude, 지식은 받은 사본(received/knowledge)에서', (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-ws-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const k = path.join(data, 'sets', ID, 'received', 'knowledge', 'kn.json');
  fs.mkdirSync(path.dirname(k), { recursive: true });
  fs.writeFileSync(k, JSON.stringify({ id: 'kn', version: 4, files: { 'a.md': '받은 지식' } }));
  const probeKn = `import('./workspace.mjs').then((w) => console.log(JSON.stringify(w.prepare({ id: '${ID}', version: 1, knowledge: ['kn'] }))))`;
  const clean = { ...process.env, KOALA_DATA_DIR: data };
  delete clean.KOALA_PORT;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', probeKn], { cwd: spike, env: clean, encoding: 'utf8' }));
  assert.equal(out.dir, path.join(data, 'sets', ID, 'work', 'claude'));
  assert.deepEqual(out.versions.knowledge, ['kn@v4']);
  assert.equal(fs.readFileSync(path.join(out.dir, 'knowledge', 'kn', 'a.md'), 'utf8'), '받은 지식');
});
