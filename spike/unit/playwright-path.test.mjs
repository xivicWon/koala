import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { playwrightArgs } from '../pw-args.mjs';

const spike = fileURLToPath(new URL('..', import.meta.url));

// 호스트가 쓰는 인자 조립(playwrightArgs)으로 목록을 뽑아 시험 1개가 나오는지 본다
function listCount(root, file) {
  const args = playwrightArgs(file, { cwd: spike, list: true });
  const out = execFileSync('npx', args, {
    cwd: spike, env: { ...process.env, KOALA_DATA_DIR: root }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const n = (s) => (s.specs?.length || 0) + (s.suites || []).reduce((a, x) => a + n(x), 0);
  const r = JSON.parse(out);
  assert.equal((r.errors || []).length, 0);
  return r.suites.reduce((a, s) => a + n(s), 0);
}

function withSet(parent, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-pw-'));
  try {
    const data = parent ? path.join(root, parent) : root;
    const code = path.join(data, 'sets', 's', 'tests', 'code');
    fs.mkdirSync(code, { recursive: true });
    const file = path.join(code, 's.spec.ts');
    fs.writeFileSync(file, [
      "import { test, expect } from '@playwright/test';",
      "import { cleanupKoaData } from '@support/cleanup';",
      "test('통과', async () => { expect(typeof cleanupKoaData).toBe('function'); });",
    ].join('\n'));
    fn(data, file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 데이터 폴더가 spike 밖(임시 폴더)이어도 세트 폴더의 테스트 코드를 찾고 '@support/…' 가 풀린다
test('세트 폴더의 테스트 코드를 suites 프로젝트가 찾고 @support 별칭이 풀린다', () => {
  withSet(null, (root, file) => assert.equal(listCount(root, file), 1));
});

test('데이터 폴더 경로에 공백·괄호가 있어도 찾는다', () => {
  withSet('with space (1)', (root, file) => assert.equal(listCount(root, file), 1));
});

test('Windows 에서는 공백·특수문자 인자를 따옴표로 감싼다', () => {
  const args = playwrightArgs('C:\\Users\\Jane Doe\\koala\\s.spec.ts', { cwd: 'C:\\other', win: true });
  assert.ok(args.some((a) => a.startsWith('"') && a.endsWith('"') && a.includes('Jane Doe')));
  assert.equal(args[0], 'playwright');
});
