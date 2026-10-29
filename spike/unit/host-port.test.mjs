import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const spike = fileURLToPath(new URL('..', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

// 브라우저 두 개가 함께 호스트를 켜려 할 때: 둘째는 긴 오류 대신 한 줄 남기고 조용히 끝난다
test('포트를 이미 쓰고 있으면 한 줄 안내 후 종료 코드 0', async () => {
  const busy = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => busy.once('listening', r));
  const port = busy.address().port;
  assert.notEqual(port, 8765);
  const data = fs.mkdtempSync(`${os.tmpdir()}/koa-port-`);
  const legacy = fs.mkdtempSync(`${os.tmpdir()}/koa-port-spk-`);
  try {
    const p = spawn(process.execPath, ['host.mjs'], { cwd: spike, env: { ...process.env, KOALA_PORT: String(port), KOALA_DATA_DIR: data, KOALA_SPIKE_DIR: legacy, CLAUDE_BIN: FAKE_CLAUDE, KOALA_WAIT_PORT: '', KOALA_PG: 'postgres://koala:koala@127.0.0.1:9/koala' } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((r) => { const t = setTimeout(() => { p.kill('SIGKILL'); r('timeout'); }, 15000); p.on('exit', (c) => { clearTimeout(t); r(c); }); });
    assert.equal(code, 0, out);
    assert.match(out, /이미 켜진 호스트가 \d+ 포트를 쓰고 있어/);
    assert.doesNotMatch(out, /EADDRINUSE|Unhandled 'error' event/);
  } finally {
    busy.close();
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(legacy, { recursive: true, force: true });
  }
});
