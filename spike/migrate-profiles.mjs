// 옛 프로필(<데이터>/sets/<id>/set.json + received/)을 프로필 폴더(~/koala-profiles/<id>/)로 옮긴다. 호스트가 켜질 때 한 번.
// 원본은 지우지 않는다(작업 데이터는 복사). 이미 같은 이름의 프로필 폴더가 있으면 건너뛴다
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { DATA, SPIKE } from './paths.mjs';
import { readSet as legacyRead, setPaths as legacyPaths, roleDocOf as legacyRoleDoc } from './legacy-sets.mjs';
import { setPaths, ensureProfileFiles, ensureUserFiles } from './sets.mjs';

const readJsonOr = (f, v) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return v; } };
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const COMMON = 'qa-common'; // koala 기본 파일(spike/prompts/qa-common.md)이 된 공통 QA 원칙
// 받은 사본이 없으면(받는 서버가 없던 프로필) 서버 흉내 저장소에서 읽는다
const storeDoc = (root, kind, id) => {
  for (const r of [path.join(root, 'store'), path.join(SPIKE, 'store')]) {
    const f = path.join(r, `${kind}s`, `${String(id).replace(/[^\w.-]/g, '_')}.yaml`);
    if (fs.existsSync(f)) try { return YAML.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  }
  return null;
};
const docOf = (root, lp, kind, dirName, id) => readJsonOr(path.join(lp.received, dirName, `${String(id).replace(/[^\w.-]/g, '_')}.json`), null) || storeDoc(root, kind, id);

const KOALA_HEAD = (name, knowledge) => `<!--
koala 프로필 폴더입니다(옛 프로필 "${name}"에서 옮김). 이 폴더의 텍스트 파일(.md, .txt)은 하위 폴더까지 모두 AI 에게 전달됩니다.
- 대상 주소·시작 경로·역할·태그처럼 koala 가 값으로 읽는 것은 .koala/settings.json 에 있습니다.
${knowledge ? '- knowledge/ 는 옛 프로필이 받은 지식 문서입니다. 고치거나 파일을 추가해도 됩니다.\n' : ''}-->
`;

export function migrateToFolders(root = DATA) {
  const dir = path.join(root, 'sets');
  const done = [];
  let ids = [];
  try { ids = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'set.json'))); } catch { return done; }
  for (const id of ids) {
    const np = setPaths(id, root);
    if (fs.existsSync(np.folder)) continue;
    const rec = legacyRead(id, root);
    if (!rec) continue;
    const lp = legacyPaths(id, root);
    const prof = rec.def?.profile || {};
    const t = prof.target || {};

    // 글: 사이트 운영 팁은 KOALA.md, 받은 지식(공통 QA 원칙 제외)은 knowledge/<문서>/ 에 원래 파일대로
    fs.mkdirSync(np.folder, { recursive: true });
    let knowledge = 0;
    for (const kid of arr(rec.def?.knowledge).filter((k) => k !== COMMON)) {
      const doc = docOf(root, lp, 'knowledge', 'knowledge', kid);
      for (const [name, content] of Object.entries(doc?.files || {})) {
        const f = path.join(np.folder, 'knowledge', kid.replace(/[^\w.-]/g, '_'), name);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, content);
        knowledge += 1;
      }
    }
    fs.writeFileSync(path.join(np.folder, 'KOALA.md'), `${KOALA_HEAD(rec.name, knowledge)}# ${rec.name}\n${prof.prompt ? `\n## 사이트 운영 팁\n\n${prof.prompt.trim()}\n` : ''}`);

    // 값: 역할·태그·정리 규칙·대상 주소
    const roleDoc = legacyRoleDoc(rec, root) || {};
    const tagDocs = arr(rec.def?.tags).map((tid) => docOf(root, lp, 'tag', 'tags', tid)).filter(Boolean);
    const tags = !tagDocs.length ? null : tagDocs.length === 1 ? tagDocs[0]
      : { ...tagDocs[0], id: tagDocs.map((d) => d.id).join('+'), groups: tagDocs.flatMap((d) => d.groups || []) };
    const settings = {
      name: rec.name,
      base_url: t.base_url || '',
      start_path: t.login_path || '/',
      ...(t.start_url ? { start_url: t.start_url } : {}),
      deploy_url: prof.deploy?.url || '',
      roles: (roleDoc.roles || []).map(({ account, accounts, ...r }) => r),
      default_role: roleDoc.default_role ?? null,
      tags,
      cleanup: prof.cleanup || [],
      ...(prof.claude && Object.values(prof.claude).some((v) => v != null) ? { claude: prof.claude } : {}),
    };
    fs.mkdirSync(path.dirname(np.settings), { recursive: true });
    fs.writeFileSync(np.settings, `${JSON.stringify(settings, null, 2)}\n`);
    ensureProfileFiles(id, root); // .gitignore

    // 작업 데이터(복사): 테스트·수행 기록·메뉴 지도·보낸 기록·계정, 규칙은 .koala/rules/. Claude 작업 폴더는 새로 만든다
    for (const name of ['tests', 'work', 'map', 'outbox', 'secrets']) {
      const from = path.join(lp.dir, name);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(np.dir, name), { recursive: true, filter: (src) => !src.startsWith(path.join(lp.dir, 'work', 'claude')) });
    }
    if (fs.existsSync(path.join(lp.dir, 'rules'))) fs.cpSync(path.join(lp.dir, 'rules'), np.rules, { recursive: true });
    if (fs.existsSync(np.secrets)) {
      fs.chmodSync(np.secrets, 0o700);
      for (const f of fs.readdirSync(np.secrets)) fs.chmodSync(path.join(np.secrets, f), 0o600);
    }
    done.push(id);
  }
  ensureUserFiles(root);
  return done;
}
