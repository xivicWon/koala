// 프로필 = ~/koala-profiles/ 아래 폴더 하나. 따로 등록하는 목록이 없고, 하위 폴더가 곧 프로필이다(폴더 이름 = 프로필 id).
//   <프로필>/KOALA.md, *.md·*.txt   AI 에게 주는 글(하위 폴더까지 전부)
//   <프로필>/.koala/settings.json    koala 가 값으로 읽는 것(대상 주소·시작 경로·보내는 서버·역할·태그·정리 규칙)
//   <프로필>/.koala/rules/            테스트 규칙(AI 가 새 파일로 추가)
//   <프로필>/.koala-work/             작업 데이터(테스트·수행 기록·메뉴 지도·계정). AI 에게 주지 않고 git 에도 올리지 않는다
// 설계: docs/superpowers/specs/2026-11-02-profile-folder-design.md
import fs from 'node:fs';
import path from 'node:path';
import { DATA, PROFILES, USER_DIR, SPIKE } from './paths.mjs';

export const safeId = (id) => String(id ?? '').replace(/[^\w.-]/g, '_') || 'default';
const TEMPLATES = path.join(SPIKE, 'templates');

// 프로필 폴더들이 있는 곳. 기본 데이터 폴더면 ~/koala-profiles, 시험이 준 다른 root 면 그 안의 profiles/
export const profilesRoot = (root = DATA) => (root === DATA ? PROFILES : path.join(root, 'profiles'));
// 사용자 레벨(~/.koala). 시험이 준 다른 root 면 그 안의 user/
export const userDir = (root = DATA) => (root === DATA ? USER_DIR : path.join(root, 'user'));

export function setPaths(id, root = DATA) {
  const folder = path.join(profilesRoot(root), safeId(id));
  const dir = path.join(folder, '.koala-work');
  return {
    folder,
    settings: path.join(folder, '.koala', 'settings.json'),
    rules: path.join(folder, '.koala', 'rules'),
    dir,
    secrets: `${dir}/secrets`,
    tests: `${dir}/tests`,
    testsFile: `${dir}/tests/tests.json`,
    code: `${dir}/tests/code`,
    results: `${dir}/tests/results`,
    work: `${dir}/work`,
    claude: `${dir}/work/claude`,
    state: `${dir}/work/state.json`,
    recordings: `${dir}/work/recordings`,
    logs: `${dir}/work/logs`,
    outbox: `${dir}/outbox`,
  };
}

const readJsonOr = (f, v) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return v; } };
const writeIfMissing = (file, content) => {
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
};

// 기본 파일 틀: 없는 것만 만든다(있으면 사용자 파일이므로 건드리지 않는다)
export function ensureProfileFiles(id, root = DATA, init = {}) {
  const p = setPaths(id, root);
  const settings = { ...JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'profile', 'settings.json'), 'utf8')), ...init };
  writeIfMissing(path.join(p.folder, 'KOALA.md'), fs.readFileSync(path.join(TEMPLATES, 'profile', 'KOALA.md'), 'utf8'));
  writeIfMissing(p.settings, `${JSON.stringify(settings, null, 2)}\n`);
  writeIfMissing(path.join(p.folder, '.gitignore'), fs.readFileSync(path.join(TEMPLATES, 'profile', 'gitignore'), 'utf8'));
}
export function ensureUserFiles(root = DATA) {
  writeIfMissing(path.join(userDir(root), 'KOALA.md'), fs.readFileSync(path.join(TEMPLATES, 'user', 'KOALA.md'), 'utf8'));
}

// settings.json → 호스트가 쓰던 프로필 모양(def.profile·roles·tags). 시작 경로는 대상 주소에 붙여 시작 URL 로
export function readSet(id, root = DATA) {
  const p = setPaths(id, root);
  if (!fs.existsSync(p.folder)) return null;
  const s = readJsonOr(p.settings, {}) || {};
  const base = String(s.base_url || '').replace(/\/$/, '');
  const startPath = s.start_path || s.login_path || '';
  return {
    id: safeId(id), name: s.name || safeId(id), version: 1, source: s.receive_url ? 'server' : 'local', path: p.folder,
    def: {
      profile: {
        target: { base_url: base, login_path: startPath || undefined, start_url: s.start_url || (base && startPath ? `${base}${startPath.startsWith('/') ? '' : '/'}${startPath}` : undefined) },
        deploy: { url: s.deploy_url || '' }, cleanup: s.cleanup || [], claude: s.claude || {},
      },
      roles: Array.isArray(s.roles) ? s.roles : [], default_role: s.default_role ?? null, tags: s.tags || null,
      receive_url: s.receive_url || '',
    },
    refs: {},
  };
}

export function domainOfSet(record) {
  try { return new URL(record?.def?.profile?.target?.base_url).hostname || 'default'; } catch { return 'default'; }
}
export function roleDocOf(rec) {
  const def = rec?.def || {};
  const roles = Array.isArray(def.roles) ? def.roles : [];
  return { roles, default_role: def.default_role ?? roles[0]?.key ?? null };
}

// 폴더 안 텍스트 파일(AI 에게 주는 글). 숨김 폴더는 .koala 만 들어가고(.koala-work·.git 등은 안 읽음), node_modules 와 200KB 넘는 파일은 뺀다.
// skip: 빼는 상대 경로 앞부분(예: '.koala/rules' 는 규칙이라 따로 붙인다)
const TEXT = /\.(md|txt)$/i;
export function textFiles(dir, { skip = [], max = 200 * 1024, limit = 300 } = {}) {
  const out = [];
  const walk = (d, rel) => {
    let ents = [];
    // 폴더마다 KOALA.md → 파일 → 하위 폴더 순(기본 명세가 먼저 읽히게)
    const rank = (e) => (e.isFile() && e.name === 'KOALA.md' ? 0 : e.isFile() ? 1 : 2);
    try { ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip.some((s) => r === s || r.startsWith(`${s}/`))) continue;
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || (e.name.startsWith('.') && e.name !== '.koala')) continue;
        walk(path.join(d, e.name), r);
      } else if (e.isFile() && TEXT.test(e.name)) {
        const f = path.join(d, e.name);
        try { if (fs.statSync(f).size <= max) out.push(f); } catch { /* 지워짐 */ }
      }
      if (out.length >= limit) return;
    }
  };
  walk(dir, '');
  return out;
}
// 프로필이 AI 에게 넘기는 글: koala 기본 → 사용자 레벨 → 프로젝트 레벨(규칙은 호스트가 따로 붙이므로 뺀다)
export function profileFiles(id, root = DATA) {
  return {
    koala: [path.join(SPIKE, 'prompts', 'qa-common.md')],
    user: textFiles(userDir(root), { skip: ['rules'] }),
    project: textFiles(setPaths(id, root).folder, { skip: ['.koala/rules'] }),
  };
}

const testCount = (p) => { const t = readJsonOr(p.testsFile, null); return { scenarios: t?.scenarios?.length || 0, cases: t?.cases?.length || 0 }; };
function summary(id, root) {
  const rec = readSet(id, root);
  const p = setPaths(id, root);
  const secrets = readJsonOr(`${p.secrets}/accounts.json`, {}) || {};
  const doc = roleDocOf(rec);
  const t = rec.def.profile.target;
  return {
    id: rec.id, name: rec.name, version: 1, source: rec.source, path: p.folder, received: true, update: null,
    base_url: t.base_url, domain: domainOfSet(rec), start_url: t.start_url || '', login_path: t.login_path || '',
    deploy_url: rec.def.profile.deploy.url, receive_url: rec.def.receive_url,
    roles: doc.roles.map((r) => ({ key: r.key, label: r.label || r.key, desc: r.desc || '', has_default: !!secrets[r.key]?.user })),
    default_role: doc.default_role, tests: testCount(p),
  };
}

// 목록: ~/koala-profiles/ 의 하위 폴더(숨김 제외). 기본 파일이 없는 폴더(사용자가 직접 만든 것)는 틀을 넣는다
export function listSets(root = DATA, warn = (m) => console.warn(`[profiles] ${m}`)) {
  const dir = profilesRoot(root);
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (safeId(n) !== n) { warn(`폴더 이름 ${n}은 프로필 이름으로 쓸 수 없어 건너뜁니다(영문·숫자·.-_ 만)`); continue; }
    try { ensureProfileFiles(n, root); out.push(summary(n, root)); } catch (e) { warn(`프로필 ${n}을 읽지 못해 목록에서 뺐습니다: ${e.message}`); }
  }
  return out;
}

// 새 프로필: 이름에서 폴더 이름(영문·숫자·.-_)을 만들고(겹치면 -2), 기본 파일 틀을 넣는다. 한글 이름은 settings 의 name 으로 남는다
export function profileSlug(name) {
  const s = String(name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/^[-._]+|[-._]+$/g, '');
  return s || 'profile';
}
export function createLocalSet(def, root = DATA) {
  const name = String(def?.name || '').trim();
  const base = profileSlug(name);
  let id = base;
  for (let n = 2; fs.existsSync(setPaths(id, root).folder); n++) id = `${base}-${n}`;
  const init = {};
  if (name && name !== id) init.name = name;
  const baseUrl = def?.profile?.target?.base_url || def?.base_url;
  if (baseUrl) init.base_url = baseUrl;
  ensureProfileFiles(id, root, init);
  return readSet(id, root);
}

// 지우기: 폴더째(정의·규칙·작업 데이터) <프로필들>/.deleted/<이름>-<시각>/ 으로 옮긴다. 목록에 안 나오고, 되살리려면 다시 꺼낸다
export function deleteSet(id, root = DATA) {
  const p = setPaths(id, root);
  if (!fs.existsSync(p.folder)) throw new Error('지울 프로필이 없습니다');
  const trash = path.join(profilesRoot(root), '.deleted', `${safeId(id)}-${new Date().toISOString().replace(/[^0-9A-Za-z]/g, '-')}`);
  fs.mkdirSync(path.dirname(trash), { recursive: true });
  fs.renameSync(p.folder, trash);
  return { source: 'local', trash };
}

// 받는 서버는 아직 없다(공사 중). 정의는 폴더의 파일을 직접 고친다
export function receiveSet() { throw new Error('받는 서버에서 프로필 받기는 아직 없습니다(공사 중)'); }
export function updateLocalSet() { throw new Error('프로필 정의는 프로필 폴더의 파일(KOALA.md·.koala/settings.json)을 직접 고칩니다'); }
export const checkUpdate = () => null;
