// Chrome Native Messaging 실행기: 사이드패널이 호스트에 연결하지 못하면 이것을 부른다.
// 호스트가 꺼져 있으면 백그라운드로 켜고, 켜질 때까지 기다렸다가 결과 하나를 돌려주고 끝난다.
//   메시지 형식: 4바이트(리틀엔디언) 길이 + JSON (Chrome Native Messaging 규약)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(os.homedir(), '.koala');
const HEALTH = 'http://127.0.0.1:8765/health';

const reply = (obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([len, body]), () => process.exit(0));
};
const health = async () => {
  try { const r = await fetch(HEALTH, { signal: AbortSignal.timeout(800) }); return r.ok ? await r.json() : null; } catch { return null; }
};

// 들어온 메시지는 내용과 관계없이 "켜 달라"로 본다(지금은 명령이 하나뿐)
process.stdin.once('readable', async () => {
  process.stdin.read();
  const up = await health();
  if (up) return reply({ ok: true, started: false, version: up.version });
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'host.log'), 'a');
  spawn(process.execPath, [path.join(dir, 'host.mjs')], { cwd: dir, detached: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const h = await health();
    if (h) return reply({ ok: true, started: true, version: h.version });
  }
  reply({ ok: false, error: `호스트를 켜지 못했습니다. 기록: ${path.join(logDir, 'host.log')}` });
});
