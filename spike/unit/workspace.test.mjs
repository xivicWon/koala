import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const spike = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'unit-test-mcp-env';
const run = (env) => {
  const clean = { ...process.env };
  for (const k of ['KOALA_DATA_DIR', 'KOALA_PORT', 'KOALA_PROFILES', 'KOALA_USER_DIR']) delete clean[k];
  const probe = `import('./workspace.mjs').then((w) => console.log(JSON.stringify(w.prepare({ id: '${ID}', version: 1 }))))`;
  return JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: spike, env: { ...clean, ...env }, encoding: 'utf8' }));
};
const mcpEnv = (out) => JSON.parse(fs.readFileSync(out.mcpConfig, 'utf8')).mcpServers.koala.env;

test('prepare()는 포트·데이터 폴더가 바뀌면 mcp.json 의 env 를 다시 쓴다(프로필·사용자 레벨 위치도 넘긴다)', (t) => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-ws-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-ws-b-'));
  t.after(() => { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); });
  assert.deepEqual(mcpEnv(run({ KOALA_PORT: '8799', KOALA_DATA_DIR: a })),
    { KOALA_PORT: '8799', KOALA_DATA_DIR: a, KOALA_PROFILES: path.join(a, 'profiles'), KOALA_USER_DIR: path.join(a, 'user') });
  assert.equal(mcpEnv(run({ KOALA_PORT: '8798', KOALA_DATA_DIR: b })).KOALA_PORT, '8798');
});

test('작업 폴더는 프로필 폴더의 .koala-work/work/claude, CLAUDE.md 는 koala 기본 → 사용자 레벨 → 프로필 글을 절대 경로로 불러온다', (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-ws-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const folder = path.join(data, 'profiles', ID);
  const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  put(path.join(folder, 'KOALA.md'), '# 사이트');
  put(path.join(folder, 'docs', 'flow.md'), '# 흐름');
  put(path.join(folder, '.koala', 'rules', 'select.md'), '# 규칙'); // 규칙은 호스트가 따로 붙인다
  put(path.join(data, 'user', 'KOALA.md'), '# 나');
  const out = run({ KOALA_DATA_DIR: data });
  assert.equal(out.dir, path.join(folder, '.koala-work', 'work', 'claude'));
  const imports = fs.readFileSync(path.join(out.dir, 'CLAUDE.md'), 'utf8').split('\n').filter((l) => l.startsWith('@')).map((l) => l.slice(1));
  assert.deepEqual(imports, [
    path.join(spike, 'prompts', 'qa-common.md'),
    path.join(data, 'user', 'KOALA.md'),
    path.join(folder, 'KOALA.md'),
    path.join(folder, 'docs', 'flow.md'),
  ]);
  assert.equal(out.versions.files, 4);
  // 파일을 더하면 다시 만든다(새 대화로 읽게)
  put(path.join(folder, 'more.md'), '# 더');
  const again = run({ KOALA_DATA_DIR: data });
  assert.equal(again.rebuilt, true);
  assert.equal(again.versions.files, 5);
});
