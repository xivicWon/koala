// 스파이크(버림용): 백엔드가 생기기 전까지 쓰는 임시 동기화 저장소.
// 백엔드와 같은 모양의 API로 제공한다. 문서는 두 곳에서 읽는다:
//   .koa/store/<종류>s/<id>.yaml  — 이 PC의 문서(대상 사이트 프로필·지식, 보낸 테스트 묶음). git 밖. 같은 id면 이쪽이 먼저
//   store/<종류>s/<id>.yaml       — 저장소에 든 공용 예시(공통 지식, 태그, 예시 프로필)
// 쓰기(PUT)는 언제나 .koa/store 로 간다. 대상 사이트 정보가 공개 저장소에 들어가지 않게 한다
//   GET  /sync/catalog            → [{ id, kind, version, hash, name, updated_at }]
//   GET  /sync/<kind>s/<id>       → 문서
//   PUT  /sync/<kind>s/<id>       { base_version, data } → 새 버전 문서 | 409 충돌
import fs from 'node:fs';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { fileURLToPath } from 'node:url';

const shared = fileURLToPath(new URL('./store/', import.meta.url));
const local = fileURLToPath(new URL('./.koa/store/', import.meta.url));
const ROOTS = [local, shared];
const KINDS = ['profile', 'knowledge', 'plan', 'suite', 'test', 'tag', 'role'];

const hashOf = (doc) => {
  const { version, updated_at, hash, ...content } = doc;
  return crypto.createHash('sha1').update(JSON.stringify(content)).digest('hex').slice(0, 12);
};
const nameOf = (id) => `${id.replace(/[^\w.-]/g, '_')}.yaml`;
const fileOf = (kind, id) => ROOTS.map((r) => `${r}${kind}s/${nameOf(id)}`).find((f) => fs.existsSync(f)) || null;
const read = (file) => YAML.parse(fs.readFileSync(file, 'utf8'));

export function catalog() {
  const out = [];
  const seen = new Set();
  for (const kind of KINDS) {
    for (const root of ROOTS) {
      const dir = `${root}${kind}s`;
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
        if (seen.has(`${kind}/${f}`)) continue;
        seen.add(`${kind}/${f}`);
        const doc = read(`${dir}/${f}`);
        out.push({ id: doc.id, kind, version: doc.version, hash: hashOf(doc), name: doc.name, updated_at: doc.updated_at });
      }
    }
  }
  return out;
}

export function get(kind, id) {
  const file = fileOf(kind, id);
  if (!file) return null;
  const doc = kind === 'role' ? withAccounts(read(file)) : read(file);
  return { ...doc, hash: hashOf(doc) };
}

// 역할 문서의 기본 계정: 서버가 내려줄 값을 대신 채운다. 비밀값이라 git 밖(.koa/server-accounts/<id>.yaml)에 둔다
function withAccounts(doc) {
  const f = fileURLToPath(new URL(`./.koa/server-accounts/${doc.id}.yaml`, import.meta.url));
  const acc = fs.existsSync(f) ? read(f)?.accounts || {} : {};
  return { ...doc, roles: (doc.roles || []).map((r) => ({ ...r, account: acc[r.key]?.user ? { user: acc[r.key].user, pass: acc[r.key].pass || '' } : null })) };
}

// 기준 버전이 저장소 버전과 다르면 그사이 누가 갱신한 것이다 → 충돌
export function put(kind, id, baseVersion, data) {
  const current = get(kind, id);
  if (current && current.version !== baseVersion) return { conflict: true, current };
  const { hash, ...clean } = data;
  const doc = { ...clean, id, kind, version: (current?.version ?? 0) + 1, updated_at: new Date().toISOString() };
  fs.mkdirSync(`${local}${kind}s`, { recursive: true });
  fs.writeFileSync(`${local}${kind}s/${nameOf(id)}`, YAML.stringify(doc, { lineWidth: 0 }));
  return { doc: { ...doc, hash: hashOf(doc) } };
}

// host.mjs 의 HTTP 서버에서 부른다. 처리했으면 true
export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/sync/')) return false;
  const json = (code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && url.pathname === '/sync/catalog') return json(200, catalog()), true;
  const m = url.pathname.match(/^\/sync\/(\w+)s\/([\w.-]+)$/);
  if (!m || !KINDS.includes(m[1])) return json(404, { error: 'not found' }), true;
  const [, kind, id] = m;
  if (req.method === 'GET') {
    const doc = get(kind, id);
    return json(doc ? 200 : 404, doc ?? { error: 'not found' }), true;
  }
  if (req.method === 'PUT') {
    let body = '';
    for await (const c of req) body += c;
    const { base_version, data } = JSON.parse(body);
    const r = put(kind, id, base_version, data);
    return r.conflict ? json(409, { error: 'conflict', current: r.current }) : json(200, r.doc), true;
  }
  return json(405, { error: 'method not allowed' }), true;
}
