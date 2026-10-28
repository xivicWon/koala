import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const spike = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = `import('./paths.mjs').then((p) => console.log(JSON.stringify({ DATA: p.DATA, PORT: p.PORT, HOST_URL: p.HOST_URL })))`;
const load = (env) => {
  const clean = { ...process.env };
  delete clean.KOALA_DATA_DIR;
  delete clean.KOALA_PORT;
  return JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: spike, env: { ...clean, ...env }, encoding: 'utf8' }));
};

test('환경변수 없이는 기본값(<spike>/.koa, 8765)', () => {
  const p = load({});
  assert.equal(p.DATA, path.join(spike, '.koa'));
  assert.equal(p.PORT, 8765);
  assert.equal(p.HOST_URL, 'http://127.0.0.1:8765');
});

test('KOALA_DATA_DIR·KOALA_PORT로 덮어쓴다', () => {
  const p = load({ KOALA_DATA_DIR: '/tmp/x', KOALA_PORT: '8799' });
  assert.equal(p.DATA, '/tmp/x');
  assert.equal(p.PORT, 8799);
  assert.equal(p.HOST_URL, 'http://127.0.0.1:8799');
});

test('DATA 끝의 / 는 떼어낸다', () => {
  assert.equal(load({ KOALA_DATA_DIR: '/tmp/x/' }).DATA, '/tmp/x');
});
