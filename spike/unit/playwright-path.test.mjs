import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const spike = fileURLToPath(new URL('..', import.meta.url));

// 데이터 폴더가 spike 밖(임시 폴더)이어도 세트 폴더의 테스트 코드를 찾고 '@support/…' 가 풀린다
test('세트 폴더의 테스트 코드를 suites 프로젝트가 찾고 @support 별칭이 풀린다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-pw-'));
  try {
    const code = path.join(root, 'sets', 's', 'tests', 'code');
    fs.mkdirSync(code, { recursive: true });
    const file = path.join(code, 's.spec.ts');
    fs.writeFileSync(file, [
      "import { test, expect } from '@playwright/test';",
      "import { cleanupKoaData } from '@support/cleanup';",
      "test('통과', async () => { expect(typeof cleanupKoaData).toBe('function'); });",
    ].join('\n'));
    const out = execFileSync('npx', ['playwright', 'test', file, '--project=suites', '--list', '--reporter=json'], {
      cwd: spike, env: { ...process.env, KOALA_DATA_DIR: root }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const n = (s) => (s.specs?.length || 0) + (s.suites || []).reduce((a, x) => a + n(x), 0);
    const r = JSON.parse(out);
    assert.equal(r.suites.reduce((a, s) => a + n(s), 0), 1);
    assert.equal((r.errors || []).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
