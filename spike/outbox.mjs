// 임시 형태. 서버 데이터 형태가 정해지면 이 파일만 바꾼다.
// 보내기: 세트의 테스트 목록(tests.json)·코드·정리 도우미로 보낼 JSON 을 만들고(buildPayload), 배포 서버로 보낸다(send).
// 배포 서버는 임시 동기화 저장소와 같은 모양의 API를 쓴다: PUT <서버>/sync/suites/<세트 id> { base_version, data } → 문서 | 409 { current }
// 주소가 이 호스트(127.0.0.1:<포트>)면 이 PC의 임시 저장소(.koa/store)에 바로 쓴다.
// 비밀값(계정 비밀번호, secrets/)은 읽지 않는다. 코드의 환경변수는 이름만 실린다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sync from './sync.mjs';
import { DATA, PORT } from './paths.mjs';
import { setPaths, safeId } from './sets.mjs';
import { loadTests, saveTests } from './testlist.mjs';

export const FORMAT = 'koa-temp-json-1';
const SUPPORT = fileURLToPath(new URL('./tests/support/', import.meta.url));

export const isThisHost = (u) => { try { return [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(new URL(u).host); } catch { return false; } };

export async function putToServer(server, kind, id, baseVersion, data) {
  if (isThisHost(server)) return sync.put(kind, id, baseVersion, data);
  const res = await fetch(`${server.replace(/\/+$/, '')}/sync/${kind}s/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_version: baseVersion, data }), signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return { conflict: true, current: body.current || {} };
  if (!res.ok) throw new Error(`HTTP ${res.status}${body.error ? ` · ${body.error}` : ''}`);
  return { doc: body };
}

const adoptedCount = (s) => [...(s.scenarios || []), ...(s.cases || [])].filter((x) => x.use).length;

// 코드 원문: 목록에 든 것이 먼저, 없으면 세트의 코드 파일
function codeSource(setId, suite, root) {
  if (suite.code?.source) return suite.code.source;
  try { return fs.readFileSync(`${setPaths(setId, root).code}/${safeId(setId)}.spec.ts`, 'utf8'); } catch { return ''; }
}

// 코드가 불러오는 정리 도우미도 함께 보낸다(서버가 그대로 돌릴 수 있게)
function supportFiles(source) {
  const out = {};
  for (const [, f] of source.matchAll(/from '(?:(?:\.\.\/)+|@)support\/([\w-]+)'/g)) {
    const p = path.join(SUPPORT, `${f}.ts`);
    if (fs.existsSync(p)) out[`support/${f}.ts`] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

export function buildPayload(setId, root = DATA) {
  const suite = loadTests(setId, root);
  const source = codeSource(setId, suite, root);
  const { scenarios, cases, spec, code, tag_doc, applied, base_version, ...rest } = suite;
  // 미채택도 함께 보낸다(adopted=false). 서버는 code를 받아 env 값만 자기 환경에 맞게 넣고 돌린다
  const mark = (xs) => (xs || []).map(({ use, ...c }) => ({ ...c, adopted: !!use }));
  const c = code || {};
  return {
    format: FORMAT,
    ...rest,
    id: setId,
    scenarios: mark(scenarios),
    cases: mark(cases),
    code: {
      runner: 'playwright', file: c.file, source, env: c.env || [],
      local_run: { ...(c.summary || {}), ran_at: c.ran_at, results: (c.results || []).map(({ title, status }) => ({ title, status })) },
      support: supportFiles(source),
    },
  };
}

export async function send(setId, { server, baseVersion = 0 } = {}, root = DATA) {
  if (!server) return { ok: false, error: '프로필에 배포 서버가 없습니다. 프로필 → 배포 서버에 주소를 넣으세요' };
  const suite = loadTests(setId, root);
  if (!codeSource(setId, suite, root).trim()) return { ok: false, error: '테스트 코드가 없어 보낼 수 없습니다. 먼저 코드를 생성하세요' };
  if (!adoptedCount(suite)) return { ok: false, error: '채택한 테스트가 없어 보낼 수 없습니다. 먼저 테스트를 고르세요' };
  const payload = buildPayload(setId, root);
  const where = isThisHost(server) ? '이 PC의 임시 서버' : new URL(server).host;
  const info = { where, name: payload.name, bdd: payload.scenarios.length, tdd: payload.cases.length };
  let r;
  try { r = await putToServer(server, 'suite', setId, baseVersion, payload); } catch (e) {
    return { ok: false, error: `배포 서버(${where})에 보내지 못했습니다: ${e.message}`, ...info };
  }
  if (r.conflict) return { ok: false, conflict: true, current: r.current, error: `배포 서버(${where})에 더 새 버전(v${r.current.version ?? '?'})이 있습니다`, ...info };
  const version = r.doc.version;
  // 다음 보내기가 거짓 충돌이 되지 않게 기준 버전을 올린다. 방금 읽은 목록 그대로 다시 쓴다
  saveTests(setId, { ...loadTests(setId, root), base_version: version }, root);
  const out = setPaths(setId, root).outbox;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(`${out}/last.json`, JSON.stringify({ version, sent_at: new Date().toISOString(), format: FORMAT }, null, 2));
  return { ok: true, version, ...info };
}
