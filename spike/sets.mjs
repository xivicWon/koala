// 세트: 서비스+버전+목적 하나(대상 사이트 하나). 서버(지금은 로컬 저장소)에서 읽기 전용으로 받아 세트 폴더에 스냅숏으로 둔다.
//   <root>/sets/<id>/set.json · received/ · secrets/ · tests/ · work/ · outbox/
// 저장소는 sync.mjs 와 같은 우선순위로 직접 읽는다: <root>/store 가 먼저, 없으면 공용 <spike>/store
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { fileURLToPath } from 'node:url';
import { DATA } from './paths.mjs';

const shared = fileURLToPath(new URL('./store/', import.meta.url));
const STORE_META = ['id', 'kind', 'name', 'version', 'updated_at', 'hash'];
const LABEL = { roles: '역할', knowledge: '지식', tags: '태그' };

export const safeId = (id) => String(id ?? '').replace(/[^\w.-]/g, '_') || 'default';

export function setPaths(id, root = DATA) {
  const dir = path.join(root, 'sets', safeId(id));
  return {
    dir,
    setFile: `${dir}/set.json`,
    received: `${dir}/received`,
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

const storeDoc = (kind, id, root) => {
  const file = [path.join(root, 'store'), shared].map((r) => `${r}/${kind}s/${safeId(id)}.yaml`.replace('//', '/')).find((f) => fs.existsSync(f));
  return file ? YAML.parse(fs.readFileSync(file, 'utf8')) : null;
};
const serverAccounts = (roleId, root) => {
  const f = path.join(root, 'server-accounts', `${safeId(roleId)}.yaml`);
  return fs.existsSync(f) ? YAML.parse(fs.readFileSync(f, 'utf8'))?.accounts || {} : {};
};
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const refOf = (doc) => `${doc.id}@v${doc.version}`;
const writeJson = (file, data, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
};

export function readSet(id, root = DATA) {
  try { return JSON.parse(fs.readFileSync(setPaths(id, root).setFile, 'utf8')); } catch { return null; }
}

export function domainOfSet(record) {
  try { return new URL(record?.def?.profile?.target?.base_url).hostname || 'default'; } catch { return 'default'; }
}

const defOf = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !STORE_META.includes(k)));

// 정의가 가리키는 문서를 저장소에서 찾는다. 하나라도 없으면 missing 에 모은다
function resolveRefs(def, root) {
  const missing = [];
  const find = (kind, id) => {
    const doc = storeDoc(kind, id, root);
    if (!doc) missing.push(`${kind}/${id}`);
    return doc;
  };
  const role = typeof def.roles === 'string' ? find('role', def.roles) : null; // 목록이면 정의에 든 인라인 역할
  const knowledge = arr(def.knowledge).map((id) => find('knowledge', id));
  const tags = arr(def.tags).map((id) => find('tag', id));
  return { missing, role, knowledge, tags };
}

export function receiveSet(id, root = DATA) {
  const doc = storeDoc('set', id, root);
  if (!doc) return { ok: false, missing: [`set/${id}`] };
  const def = defOf(doc);
  const { missing, role, knowledge, tags } = resolveRefs(def, root);
  if (missing.length) return { ok: false, missing };

  const record = {
    id: doc.id ?? id,
    name: doc.name ?? String(id),
    version: doc.version ?? 1,
    source: 'server',
    def,
    refs: {
      ...(role ? { roles: refOf(role) } : {}),
      ...(knowledge.length ? { knowledge: knowledge.map(refOf) } : {}),
      ...(tags.length ? { tags: tags.map(refOf) } : {}),
    },
    received_at: new Date().toISOString(),
  };

  const p = setPaths(id, root);
  const tmp = `${p.dir}.receiving-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    writeJson(`${tmp}/set.json`, record);
    if (role) writeJson(`${tmp}/received/roles.json`, role);
    knowledge.forEach((d) => writeJson(`${tmp}/received/knowledge/${safeId(d.id)}.json`, d));
    tags.forEach((d) => writeJson(`${tmp}/received/tags/${safeId(d.id)}.json`, d));
    fs.mkdirSync(`${tmp}/received`, { recursive: true });
    fs.mkdirSync(`${tmp}/secrets`, { recursive: true, mode: 0o700 });
    fs.chmodSync(`${tmp}/secrets`, 0o700);
    writeJson(`${tmp}/secrets/accounts.json`, role ? serverAccounts(role.id, root) : {}, 0o600);
    fs.chmodSync(`${tmp}/secrets/accounts.json`, 0o600);

    if (!fs.existsSync(p.dir)) {
      fs.mkdirSync(path.dirname(p.dir), { recursive: true });
      fs.renameSync(tmp, p.dir);
    } else {
      // 이미 있는 세트: 테스트·작업 데이터는 그대로 두고 받은 것만 바꿔치기한다
      const old = `${p.dir}.old-${process.pid}`;
      fs.rmSync(old, { recursive: true, force: true });
      fs.mkdirSync(old);
      for (const name of ['received', 'secrets']) {
        if (fs.existsSync(`${p.dir}/${name}`)) fs.renameSync(`${p.dir}/${name}`, `${old}/${name}`);
        fs.renameSync(`${tmp}/${name}`, `${p.dir}/${name}`);
      }
      fs.renameSync(`${tmp}/set.json`, p.setFile);
      fs.rmSync(old, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { ok: true, record };
}

// 받은 것과 저장소의 현재 판을 비교해 바뀐 것을 낸다. 받기 전에는 스냅숏을 건드리지 않는다
// 저장소 문서를 읽지 못하면(YAML 이 깨짐) 던지지 않고 바뀐 것으로 알린다(목록 전체가 막히지 않게)
const UNREADABLE = Symbol('unreadable');
const tryDoc = (kind, id, root) => { try { return storeDoc(kind, id, root); } catch { return UNREADABLE; } };
const unreadable = (kind, id) => `참조 문서를 읽지 못함 ${kind}/${id}`;
// '<id>@v<판>' → [id, 판]. id 안에 '@v' 가 있어도 마지막 것으로 가른다
const splitRef = (r) => { const s = String(r); const i = s.lastIndexOf('@v'); return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 2)]; };

export function checkUpdate(id, root = DATA) {
  const rec = readSet(id, root);
  if (!rec || rec.source !== 'server') return null;
  const doc = tryDoc('set', rec.id, root);
  if (doc === UNREADABLE) return { from: rec.version, to: rec.version, changed: [unreadable('set', rec.id)] };
  if (!doc) return null;
  const changed = [];
  if ((doc.version ?? 1) !== rec.version) changed.push(`세트 v${rec.version} → v${doc.version ?? 1}`);
  const have = (list) => new Map(arr(list).map(splitRef));
  const kinds = { roles: 'role', knowledge: 'knowledge', tags: 'tag' };
  for (const [key, kind] of Object.entries(kinds)) {
    const before = have(rec.refs?.[key]);
    const wanted = key === 'roles' && typeof doc.roles !== 'string' ? [] : arr(doc[key]); // 인라인 역할은 세트 판으로 본다
    for (const rid of wanted) {
      const cur = tryDoc(kind, rid, root);
      if (cur === UNREADABLE) { changed.push(unreadable(kind, rid)); continue; }
      if (!cur) continue;
      if (!before.has(rid)) changed.push(`${LABEL[key]} ${rid} 추가`);
      else if (String(cur.version) !== before.get(rid)) changed.push(`${LABEL[key]} ${rid} v${before.get(rid)} → v${cur.version}`);
    }
    for (const rid of before.keys()) if (!wanted.includes(rid)) changed.push(`${LABEL[key]} ${rid} 제거`);
  }
  return changed.length ? { from: rec.version, to: doc.version ?? 1, changed } : null;
}

// 이 PC 전용 세트 id 의 이름 부분: 이름에서 영문·숫자만 살린다. 한글 이름처럼 남는 게 없으면 fallback(예: 옛 프로필 id), 그것도 없으면 'set'
export function localSlug(name, fallback = '') {
  const s = safeId(name).replace(/_+/g, '_').replace(/^[_.-]+|[_.-]+$/g, '');
  if (/[A-Za-z0-9]/.test(s)) return s;
  const f = safeId(fallback).replace(/^local-/, '');
  return fallback && /[A-Za-z0-9]/.test(f) ? f : 'set';
}
export function createLocalSet(def, root = DATA, fallback = '') {
  const base = `local-${localSlug(def?.name, fallback)}`;
  let id = base;
  for (let n = 2; fs.existsSync(setPaths(id, root).dir); n++) id = `${base}-${n}`;
  const { name, ...rest } = def || {};
  const record = { id, name: name || id, version: 1, source: 'local', def: rest, refs: {}, received_at: new Date().toISOString() };
  writeJson(setPaths(id, root).setFile, record);
  return record;
}

// 이 PC 전용 세트만 고친다. 고치기 화면이 다루는 것(이름, 대상 주소·시작 URL, 배포 서버, 사이트 지식)만 바꾸고
// 나머지(역할 참조, 지식·태그, claude·cleanup, 모르는 키)는 그대로 둔다. 빈 문자열의 시작 URL 은 지운다. id·출처·만든 시각도 그대로
export function updateLocalSet(id, patch, root = DATA) {
  const rec = readSet(id, root);
  if (!rec || rec.source !== 'local') throw new Error('이 PC 전용 세트만 고칠 수 있습니다');
  const def = structuredClone(rec.def || {});
  const pp = patch?.profile || {};
  const prof = (def.profile ??= {});
  if (pp.target) {
    prof.target = { ...prof.target };
    for (const k of ['base_url', 'start_url']) {
      if (pp.target[k] === undefined) continue;
      if (pp.target[k] === '' && k === 'start_url') delete prof.target[k]; else prof.target[k] = pp.target[k];
    }
  }
  if (pp.deploy?.url !== undefined) prof.deploy = { ...prof.deploy, url: pp.deploy.url };
  if (pp.prompt !== undefined) prof.prompt = pp.prompt;
  const next = { ...rec, name: patch?.name || rec.name, def, updated_at: new Date().toISOString() };
  writeJson(setPaths(id, root).setFile, next);
  return next;
}

export function deleteSet(id, root = DATA) {
  const rec = readSet(id, root);
  if (!rec || rec.source !== 'local') throw new Error('이 PC 전용 세트만 지울 수 있습니다');
  fs.rmSync(setPaths(id, root).dir, { recursive: true, force: true });
}

const readJsonOr = (f, v) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return v; } };
// 세트의 역할 문서 { roles, default_role }. 정의에 든 인라인 역할이 먼저(앞선 옮기기가 profile 아래에 둔 것도 읽는다),
// 역할 문서 id(문자열)면 받은 received/roles.json. 이 PC 전용 세트는 받기가 없으므로 저장소의 역할 문서(계정은 뺀다)
export function roleDocOf(rec, root = DATA) {
  const def = rec?.def || {};
  if (typeof def.roles !== 'string') {
    const roles = Array.isArray(def.roles) ? def.roles : Array.isArray(def.profile?.roles) ? def.profile.roles : [];
    return { roles, default_role: def.default_role ?? def.profile?.default_role };
  }
  const got = readJsonOr(`${setPaths(rec.id, root).received}/roles.json`, null);
  if (got || rec.source !== 'local') return got;
  let doc = null;
  try { doc = storeDoc('role', def.roles, root); } catch { /* 읽지 못하면 역할 없이 */ }
  return doc ? { roles: (doc.roles || []).map(({ account, accounts, ...r }) => r), default_role: def.default_role ?? doc.default_role } : null;
}
// 패널이 세트 상세를 그리는 데 쓰는 것. 기본 계정은 있는지만 싣고 아이디·비밀번호 값은 싣지 않는다
function details(rec, root) {
  const p = setPaths(rec.id, root);
  const def = rec.def || {};
  const roleDoc = roleDocOf(rec, root);
  const secrets = readJsonOr(`${p.secrets}/accounts.json`, {}) || {};
  const roles = (roleDoc?.roles || []).map((r) => ({ key: r.key, label: r.label || r.key, desc: r.desc || '', has_default: !!secrets[r.key]?.user }));
  const t = readJsonOr(p.testsFile, null);
  return {
    start_url: def.profile?.target?.start_url || '', login_path: def.profile?.target?.login_path || '',
    deploy_url: def.profile?.deploy?.url || '', prompt: def.profile?.prompt || '',
    refs: rec.refs || {}, knowledge: arr(def.knowledge), tags: arr(def.tags),
    roles, default_role: roleDoc?.default_role || roles[0]?.key || null,
    tests: { scenarios: t?.scenarios?.length || 0, cases: t?.cases?.length || 0 },
    received_at: rec.received_at,
  };
}
const summary = (rec, received, update, root) => ({
  id: rec.id, name: rec.name, version: rec.version, source: rec.source,
  base_url: rec.def?.profile?.target?.base_url || '', domain: domainOfSet(rec), received, update,
  ...(received ? details(rec, root) : {}),
});

// 읽지 못한 파일·받을 수 없는 문서는 건너뛰고 warn 으로 알린다(파일 하나 때문에 목록 전체가 막히지 않게)
export function listSets(root = DATA, warn = (m) => console.warn(`[sets] ${m}`)) {
  const out = [];
  const seen = new Set();
  const dir = path.join(root, 'sets');
  if (fs.existsSync(dir)) {
    for (const d of fs.readdirSync(dir)) {
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(`${dir}/${d}/set.json`, 'utf8')); } catch { /* 받다 만 폴더 */ }
      if (!rec) continue;
      seen.add(safeId(rec.id));
      try { out.push(summary(rec, true, checkUpdate(rec.id, root), root)); } catch (e) { warn(`세트 ${rec.id}를 읽지 못해 목록에서 뺐습니다: ${e.message}`); }
    }
  }
  for (const r of [path.join(root, 'store'), shared]) {
    const sdir = `${r}/sets`;
    if (!fs.existsSync(sdir)) continue;
    for (const f of fs.readdirSync(sdir).filter((x) => x.endsWith('.yaml'))) {
      let doc;
      try { doc = YAML.parse(fs.readFileSync(`${sdir}/${f}`, 'utf8')); } catch (e) {
        warn(`세트 문서 ${sdir}/${f}를 읽지 못해 건너뜁니다: ${e.message.split('\n')[0]}`);
        continue;
      }
      if (!doc?.id) continue;
      // 받기는 <id>.yaml 로 찾으므로 이름이 다른 문서는 받을 수 없다
      if (`${safeId(doc.id)}.yaml` !== f) { warn(`세트 문서 ${sdir}/${f}의 id(${doc.id})가 파일 이름과 달라 건너뜁니다`); continue; }
      if (seen.has(safeId(doc.id))) continue;
      seen.add(safeId(doc.id));
      out.push(summary({ id: doc.id, name: doc.name ?? doc.id, version: doc.version ?? 1, source: 'server', def: defOf(doc) }, false, null));
    }
  }
  return out;
}
