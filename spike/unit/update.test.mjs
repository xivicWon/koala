import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sameDeps, nodeTool } from '../update.mjs';

const lock = (v, deps) => JSON.stringify({ name: 'koala', version: v, lockfileVersion: 3, packages: { '': { name: 'koala', version: v, dependencies: deps } } });

test('package-lock: 버전 번호만 바뀌면 의존성은 같다', () => {
  assert.equal(sameDeps(lock('0.2.14', { ws: '^8' }), lock('0.3.0', { ws: '^8' })), true);
  assert.equal(sameDeps(lock('0.2.14', { ws: '^8' }), lock('0.3.0', { ws: '^9' })), false);
  assert.equal(sameDeps('', lock('0.3.0', {})), false); // 읽지 못하면 다시 설치한다
});

test('npm·npx 는 지금 도는 node 옆의 것을 쓴다(브라우저가 켠 호스트의 짧은 PATH에서도)', () => {
  const npx = nodeTool('npx');
  assert.equal(path.dirname(npx), path.dirname(process.execPath));
  // 브라우저가 준 것 같은 짧은 PATH + 호스트가 앞에 붙이는 node 폴더
  const env = { ...process.env, PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter) };
  assert.match(execFileSync(npx, ['--version'], { env, encoding: 'utf8', shell: process.platform === 'win32' }).trim(), /^\d+\./);
});
