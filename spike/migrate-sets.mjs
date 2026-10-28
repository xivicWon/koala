// 예전 데이터(도메인 버킷 .koa/domains/<호스트>/, 프로필, tests/suites/) → 세트 옮기기.
// 호스트는 도메인↔프로필 대응을 모르므로(이 PC 전용 프로필은 확장에만 있다) 패널이 프로필 목록·활성 프로필·
// 확장 저장소의 suite@<도메인>·timeline@<도메인> 목록을 보내고, planMigration 이 계획을(디스크는 그대로),
// applyMigration 이 적용한다.
// 적용 순서: 세트 자리에 복사 → 복사본 확인 → 원본을 migrated-<날짜>/ 에 복사·확인 → 원본 치우기 → sets/.migrated
// .migrated 를 쓰기 전에 실패하면 원본은 제자리에 남는다. 복사본은 남을 수 있고, 다시 돌리면 같은 결과가 된다.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { safeId, setPaths, readSet, receiveSet, createLocalSet } from './sets.mjs';
import { saveTests } from './testlist.mjs';

const META = ['id', 'kind', 'name', 'version', 'updated_at', 'hash'];
// host.mjs 의 도메인 폴더·코드 파일 이름 규칙과 같다
const safeDomain = (d) => String(d || 'default').toLowerCase().replace(/[^\w.-]/g, '_');
const safeName = (id) => String(id).replace(/[^\w.-]/g, '_');
const domainOf = (p) => { try { return new URL(p?.target?.base_url).hostname || 'default'; } catch { return 'default'; } };
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const readYaml = (f) => { try { return YAML.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const differs = (a, b) => fs.existsSync(a) && fs.existsSync(b) && !fs.readFileSync(a).equals(fs.readFileSync(b));
// 테스트 코드의 정리 도우미 경로: 세트 코드 폴더에서는 별칭으로 쓴다
const toSupport = (src) => String(src).replace(/(['"])(?:\.\.\/){1,2}support\//g, '$1@support/');

// 프로필 문서 → 세트 정의. 대상 사이트 내용은 profile: 아래, 역할 문서·지식·태그는 참조로 둔다.
// 계정(비밀번호)은 세트 정의에 넣지 않는다 — 내 계정은 패널이 내 설정으로 옮긴다
function setDoc(id, prof) {
  const doc = { id, name: prof.name || id, version: prof.version ?? 1 };
  const profile = {};
  const refs = {};
  for (const [k, v] of Object.entries(prof)) {
    if (META.includes(k) || k === 'accounts') continue;
    if (k === 'knowledge' || k === 'tags' || (k === 'roles' && typeof v === 'string')) refs[k] = v;
    else profile[k] = v;
  }
  return { ...doc, profile, ...refs };
}

// 패널은 suite@<도메인> 에 { suite, suiteBase, suiteApplied } 를 둔다. 묶음만 온 경우도 받는다
function unwrap(x) {
  if (x?.suite && typeof x.suite === 'object' && !Array.isArray(x.scenarios)) {
    return { suite: x.suite, base: x.suiteBase ?? x.suite.base_version ?? 0, applied: x.suiteApplied ?? x.suite.applied ?? false };
  }
  if (x && typeof x === 'object' && x.id) return { suite: x, base: x.base_version ?? 0, applied: x.applied ?? false };
  return {};
}

// 이 PC 전용 세트 id: createLocalSet 과 같은 규칙. 앞선(실패한) 실행이 이 프로필로 만든 세트가 있으면 그것을 다시 쓴다
function localSetId(name, pid, root, taken) {
  const base = `local-${safeId(name)}`;
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (taken.has(id)) continue;
    if (!fs.existsSync(setPaths(id, root).dir) || readSet(id, root)?.from_profile === pid) return id;
  }
}

export function planMigration({ root, spikeDir, profiles = {}, activeId = null, extSuites = {}, extTimelines = [] }) {
  const sharedStore = path.join(spikeDir, 'store');
  const localTags = path.join(root, 'store/tags/qa-tags.yaml');
  const tagsShadow = differs(localTags, path.join(sharedStore, 'tags/qa-tags.yaml'));
  const archive = path.join(root, `migrated-${today()}`);
  const sets = [];
  const setByProfile = {};
  const taken = new Set();
  const skipped = [];

  // 프로필 하나 → 세트 하나. 서버 프로필은 저장소 문서(.koa/store 먼저, 없으면 공용)로 서버 흉내 세트 정의를 만든다
  for (const pid of Object.keys(profiles).sort()) {
    const { local, data } = profiles[pid] || {};
    const own = path.join(root, 'store/profiles', `${safeId(pid)}.yaml`);
    const shared = path.join(sharedStore, 'profiles', `${safeId(pid)}.yaml`);
    // 공용 예시를 가리던 사본(예: example)은 서버가 준 것이 아니므로 이 PC 전용 세트로 남긴다
    const shadow = !local && differs(own, shared);
    const prof = (!local && (readYaml(own) || readYaml(shared))) || data || {};
    const source = local || shadow ? 'local' : 'server';
    const setId = source === 'server' ? pid : localSetId(prof.name || pid, pid, root, taken);
    taken.add(setId);
    const def = setDoc(setId, prof);
    let tagCopy = null;
    if (tagsShadow && arr(def.tags).includes('qa-tags')) {
      const tid = `${setId}-tags`;
      def.tags = Array.isArray(def.tags) ? def.tags.map((t) => (t === 'qa-tags' ? tid : t)) : tid;
      tagCopy = { from: localTags, to: path.join(root, 'store/tags', `${safeId(tid)}.yaml`), id: tid };
    }
    sets.push({ setId, fromProfile: pid, source, domain: domainOf(prof), def, tagCopy, moves: [] });
    setByProfile[pid] = setId;
  }

  const bySet = new Map(sets.map((s) => [s.setId, s]));
  const active = bySet.get(setByProfile[activeId]);
  // 나눌 수 없는 도메인 데이터(수행 기록·세션·로그·타임라인)를 받을 세트:
  // 그 도메인의 활성 프로필 → 그 도메인 프로필 중 id 순 첫 번째 → (default 버킷만) 활성 프로필
  const workSet = (d) => {
    const here = sets.filter((s) => safeDomain(s.domain) === safeDomain(d));
    if (active && here.includes(active)) return { set: active, fallback: false };
    if (here.length) return { set: here[0], fallback: false };
    if (safeDomain(d) === 'default' && active) return { set: active, fallback: true };
    return { set: null };
  };

  const domainsDir = path.join(root, 'domains');
  const folders = fs.existsSync(domainsDir)
    ? fs.readdirSync(domainsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  // 같은 자리를 다투면 먼저 정한 것이 이긴다. 제 도메인 프로필이 있는 버킷을 default 대신 쓰는 경우보다 먼저 둔다
  const order = folders.map((f) => ({ f, ...workSet(f) })).sort((a, b) => Number(a.fallback) - Number(b.fallback));
  const used = new Set();
  for (const { f, set } of order) {
    if (!set) { skipped.push(`domains/${f}`); continue; }
    const p = setPaths(set.setId, root);
    const items = [['state.json', p.state, 'state'], ['recording.json', `${p.work}/recording.json`], ['recordings', p.recordings], ['logs', p.logs]];
    for (const [name, to, edit] of items) {
      const from = path.join(domainsDir, f, name);
      if (!fs.existsSync(from)) continue;
      if (used.has(to)) { skipped.push(`domains/${f}/${name}`); continue; }
      used.add(to);
      set.moves.push({ from, to, ...(edit ? { edit } : {}) });
    }
  }

  // suite@<도메인> 하나만 세트의 tests.json 으로. 묶음 id 앞부분(<프로필>--)으로 가를 수 있으면 그 프로필의 세트
  for (const [d, raw] of Object.entries(extSuites || {})) {
    const { suite, base, applied } = unwrap(raw);
    if (!suite) continue;
    const id = String(suite.id ?? '');
    const cut = id.lastIndexOf('--');
    const owner = (cut > 0 && bySet.get(setByProfile[id.slice(0, cut)])) || workSet(d).set;
    if (!owner || owner.suite) { skipped.push(`suite@${d}`); continue; }
    const code = suite.code?.source ? { ...suite.code, source: toSupport(suite.code.source) } : suite.code;
    owner.suite = { ...suite, ...(code !== undefined ? { code } : {}), applied, base_version: base };
    const file = `${safeName(id)}.spec.ts`;
    const from = [path.join(spikeDir, 'tests/suites', safeDomain(d), file), path.join(spikeDir, 'tests/suites', file)].find((f) => fs.existsSync(f));
    if (from) owner.moves.push({ from, to: path.join(setPaths(owner.setId, root).code, `${safeId(owner.setId)}.spec.ts`), edit: 'support' });
  }

  const timelineKeys = {};
  for (const d of extTimelines || []) {
    const { set } = workSet(d);
    if (set) timelineKeys[d] = set.setId;
    else skipped.push(`timeline@${d}`);
  }

  // 원본은 모두 보관 폴더로(세트로 간 것도, 건너뛴 것도, 초안도)
  const archiveMoves = [];
  if (fs.existsSync(domainsDir)) archiveMoves.push({ from: domainsDir, to: path.join(archive, 'domains') });
  const suitesDir = path.join(spikeDir, 'tests/suites');
  if (fs.existsSync(suitesDir)) archiveMoves.push({ from: suitesDir, to: path.join(archive, 'tests/suites') });
  if (tagsShadow) archiveMoves.push({ from: localTags, to: path.join(archive, 'store/tags/qa-tags.yaml') });

  return { root, spikeDir, sets, setByProfile, timelineKeys, archive, archiveMoves, skipped };
}

// ── 적용 ──
const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
};
// 파일이면 [''], 폴더면 그 안 파일들의 상대 경로
const filesOf = (p) => {
  if (!fs.statSync(p).isDirectory()) return [''];
  return fs.readdirSync(p, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(p, path.join(e.parentPath ?? e.path, e.name)));
};
const edited = (m) => {
  const text = fs.readFileSync(m.from, 'utf8');
  if (m.edit === 'support') return toSupport(text);
  const { domain, ...rest } = JSON.parse(text); // 도메인은 세트 정의에서 계산한다
  return JSON.stringify(rest, null, 2);
};
function copy(m) {
  if (m.edit) { writeAtomic(m.to, edited(m)); return 1; }
  fs.mkdirSync(path.dirname(m.to), { recursive: true });
  // 시각을 지켜야 작업 로그 30일 정리가 그대로 맞는다
  fs.cpSync(m.from, m.to, { recursive: true, force: true, preserveTimestamps: true });
  return filesOf(m.from).length;
}
// 원본의 파일마다 사본이 있고 크기가 같은지(고쳐 쓴 파일은 내용이 같은지)
function verify(m) {
  if (m.edit) {
    if (!fs.existsSync(m.to) || fs.readFileSync(m.to, 'utf8') !== edited(m)) throw new Error(`복사본이 원본과 다릅니다: ${m.to}`);
    return;
  }
  for (const rel of filesOf(m.from)) {
    const a = path.join(m.from, rel);
    const b = path.join(m.to, rel);
    if (!fs.existsSync(b) || fs.statSync(a).size !== fs.statSync(b).size) throw new Error(`복사본이 원본과 다릅니다: ${b}`);
  }
}

function makeSet(s, root) {
  if (s.source === 'server') {
    // 서버 흉내 세트 정의. 이미 있으면(앞선 실행이 만들었거나 서버가 준 것) 그대로 받는다
    const f = path.join(root, 'store/sets', `${safeId(s.setId)}.yaml`);
    if (!fs.existsSync(f)) writeAtomic(f, YAML.stringify(s.def));
    const r = receiveSet(s.setId, root);
    if (!r.ok) throw new Error(`세트 ${s.setId}를 받지 못했습니다 · 저장소에 없는 문서: ${r.missing.join(', ')}`);
    return;
  }
  if (readSet(s.setId, root)?.from_profile === s.fromProfile) return;
  const { id, version, ...def } = s.def;
  const rec = createLocalSet(def, root);
  if (rec.id !== s.setId) {
    fs.rmSync(setPaths(rec.id, root).dir, { recursive: true, force: true });
    throw new Error(`이 PC 전용 세트 id가 계획과 다릅니다: ${rec.id} (계획 ${s.setId})`);
  }
  // 다시 돌릴 때 같은 세트를 알아보도록 어느 프로필에서 왔는지 남긴다
  writeAtomic(setPaths(s.setId, root).setFile, JSON.stringify({ ...rec, from_profile: s.fromProfile }, null, 2));
}

export function applyMigration(plan) {
  const { root } = plan;
  const done = path.join(root, 'sets', '.migrated');
  if (fs.existsSync(done)) return { ok: true, moved: 0, errors: [] };
  const errors = [];
  const staged = [];
  let moved = 0;
  try {
    // 1. 세트를 만들고 데이터를 제자리에 복사
    for (const s of plan.sets) {
      if (s.tagCopy) {
        const doc = YAML.parse(fs.readFileSync(s.tagCopy.from, 'utf8'));
        writeAtomic(s.tagCopy.to, YAML.stringify({ ...doc, id: s.tagCopy.id }));
      }
      makeSet(s, root);
      for (const m of s.moves) moved += copy(m);
      if (s.suite) saveTests(s.setId, s.suite, root);
    }
    // 2. 복사본 확인
    for (const s of plan.sets) {
      s.moves.forEach(verify);
      if (s.suite && fs.readFileSync(setPaths(s.setId, root).testsFile, 'utf8') !== JSON.stringify(s.suite, null, 2)) {
        throw new Error(`테스트 목록 복사본이 다릅니다: ${s.setId}`);
      }
    }
    // 3. 원본을 보관 폴더에 복사하고 확인
    for (const m of plan.archiveMoves) copy(m);
    plan.archiveMoves.forEach(verify);
    // 4. 원본 치우기: 같은 폴더 안 이름 바꾸기라 하나가 실패하면 앞의 것을 되돌린다
    for (const m of plan.archiveMoves) {
      const tmp = `${m.from}.migrating-${process.pid}`;
      fs.renameSync(m.from, tmp);
      staged.push({ from: m.from, tmp });
    }
    // 5. 마지막에 결과를 남긴다
    writeAtomic(done, JSON.stringify({
      at: new Date().toISOString(),
      archive: plan.archive,
      moved,
      sets: plan.sets.map(({ setId, fromProfile, source, domain }) => ({ setId, fromProfile, source, domain })),
      setByProfile: plan.setByProfile,
      timelineKeys: plan.timelineKeys,
      skipped: plan.skipped,
    }, null, 2));
  } catch (e) {
    for (const { from, tmp } of staged.reverse()) {
      try { fs.renameSync(tmp, from); } catch (e2) { errors.push(`원본을 되돌리지 못했습니다(${tmp}): ${e2.message}`); }
    }
    return { ok: false, moved: 0, errors: [e.message, ...errors] };
  }
  // 보관본은 이미 확인했다. 치운 원본을 지우다 실패해도 옮기기는 끝난 것이다
  for (const { tmp } of staged) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { errors.push(`치운 원본을 지우지 못했습니다(${tmp}): ${e.message}`); }
  }
  return { ok: true, moved, errors };
}
