import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ruleFile, listRules, saveRule, rulesText, rulesIndex } from '../rules.mjs';

let dir;
beforeEach(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'koala-rules-')), 'rules'); });
afterEach(() => { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); });

test('파일 이름: 영문 소문자·숫자·하이픈만, .md 는 붙여 주고 폴더 밖·숨김은 막는다', () => {
  assert.equal(path.basename(ruleFile(dir, 'Auto-Complete.md')), 'auto-complete.md');
  for (const bad of ['../x', 'a/b', '.hidden', '셀렉트', '', 'a_b']) assert.throws(() => ruleFile(dir, bad), /영문 소문자/);
});

test('저장·목록·덮어쓰기: 폴더가 없으면 만들고, 제목은 첫 줄(# 뗌), 이름순', () => {
  assert.deepEqual(listRules(dir), []);
  assert.deepEqual(saveRule(dir, 'select', '# 셀렉트\n클릭으로 열고 option 이 보인 뒤 고른다'), { file: 'select.md', existed: false, size: 31 });
  saveRule(dir, 'auto-complete', '자동완성은 pressSequentially 뒤 응답을 기다린다');
  assert.equal(saveRule(dir, 'select', '# 셀렉트\n바뀐 내용').existed, true);
  fs.writeFileSync(path.join(dir, 'note.txt'), '무시');
  assert.deepEqual(listRules(dir).map((r) => [r.name, r.title]), [['auto-complete.md', '자동완성은 pressSequentially 뒤 응답을 기다린다'], ['select.md', '셀렉트']]);
  assert.equal(rulesIndex(dir), '- auto-complete.md: 자동완성은 pressSequentially 뒤 응답을 기다린다\n- select.md: 셀렉트');
  assert.throws(() => saveRule(dir, 'x', '  '), /비었습니다/);
});

test('지시문 전문: 파일마다 머리를 붙이고, 상한을 넘으면 뒤쪽을 자르고 표시한다', () => {
  assert.deepEqual(rulesText(dir), { text: '', files: 0, cut: false });
  saveRule(dir, 'a', 'A'.repeat(50));
  saveRule(dir, 'b', 'B'.repeat(50));
  saveRule(dir, 'c', 'C'.repeat(50));
  const full = rulesText(dir);
  assert.match(full.text, /^--- a\.md ---\nA{50}\n--- b\.md ---/);
  assert.equal(full.cut, false);
  const cut = rulesText(dir, 80);
  assert.equal(cut.cut, true);
  assert.match(cut.text, /--- b\.md 외 1개: 너무 길어 생략/);
});
