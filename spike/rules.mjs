// 프로필 규칙: 세트(프로필)마다 그 사이트에서 테스트를 쓸 때 지킬 것(셀렉트 고르는 법, 자동완성 기다리는 법 등).
// 세트 폴더의 rules/ 아래 *.md 를 모두 읽는다. 파일 하나여도, 주제별로 여러 개여도 된다. 사람이 직접 넣거나 고쳐도 된다.
// AI 는 save_rule 로 쓰고 read_rules 로 읽는다. 호스트가 지시할 때마다 새로 읽어 붙이므로 저장하면 다음 지시부터 바로 쓰인다
import fs from 'node:fs';
import path from 'node:path';

export const MAX_TOTAL = 20000; // 지시문에 붙이는 전문 상한(글자)
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

// 파일 이름: 영문 소문자·숫자·하이픈(.md 는 붙여 준다). 폴더 밖·숨김·다른 확장자는 받지 않는다
export function ruleFile(dir, name) {
  const base = String(name || '').trim().toLowerCase().replace(/\.md$/, '');
  if (!NAME.test(base)) throw new Error(`규칙 파일 이름은 영문 소문자·숫자·하이픈만 씁니다(예: select, auto-complete): ${name}`);
  return path.join(dir, `${base}.md`);
}

// 목록: 이름순. 제목은 첫 줄(앞의 # 는 뗀다)
export function listRules(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort(); } catch { return []; }
  return names.map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    return { name: f, title: (text.split('\n').find((l) => l.trim()) || '').replace(/^#+\s*/, '').slice(0, 80), size: text.length, text };
  });
}

export function saveRule(dir, name, content) {
  const file = ruleFile(dir, name);
  const text = String(content ?? '').trim();
  if (!text) throw new Error('규칙 내용이 비었습니다');
  fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, `${text}\n`);
  return { file: path.basename(file), existed, size: text.length };
}

// 지시문에 붙일 전문. 상한을 넘으면 뒤쪽 파일부터 자르고 잘렸다고 적는다
export function rulesText(dir, max = MAX_TOTAL) {
  const all = listRules(dir);
  if (!all.length) return { text: '', files: 0, cut: false };
  let out = '';
  let cut = false;
  for (const r of all) {
    const block = `--- ${r.name} ---\n${r.text.trim()}\n`;
    if (out.length + block.length > max) { cut = true; out += `--- ${r.name} 외 ${all.length - all.indexOf(r) - 1}개: 너무 길어 생략 (read_rules 로 읽는다) ---\n`; break; }
    out += block;
  }
  return { text: out.trim(), files: all.length, cut };
}

// 수행 지시에 붙일 목록(이름과 첫 줄만)
export const rulesIndex = (dir) => listRules(dir).map((r) => `- ${r.name}: ${r.title}`).join('\n');
