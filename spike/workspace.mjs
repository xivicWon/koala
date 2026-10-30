// 스파이크(버림용): 프로필이 쓰는 지식 문서로 Claude 작업 폴더(사본)를 만든다.
//   .koa/sets/<프로필 id>/work/claude/   (세션은 이 경로에 묶인다)
//     CLAUDE.md              ← Claude가 자동으로 읽음. 지식 파일을 @로 불러온다
//     knowledge/<지식 id>/…  ← 지식 문서의 파일들
//     .claude/settings.json  ← 이 작업 폴더용 Claude 설정
//     .koa/version.json      ← 어떤 지식 버전으로 만들었는지
// 이 폴더는 받은 내용으로 매번 다시 만드는 사본이다. 직접 고치지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import * as sync from './sync.mjs';
import { fileURLToPath } from 'node:url';
import { DATA, PORT } from './paths.mjs';
import { setPaths } from './sets.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const safe = (s) => String(s).replace(/[^\w.-]/g, '_');

// 프로필이 받은 지식 사본(received/knowledge/)을 쓴다. 이 PC 전용 프로필처럼 받은 사본이 없으면 임시 저장소에서 읽는다
function fetchKnowledge(setId, id) {
  try { return JSON.parse(fs.readFileSync(path.join(setPaths(setId).received, 'knowledge', `${safe(id)}.json`), 'utf8')); } catch {
    return sync.get('knowledge', id);
  }
}

// profile.id 는 프로필 id 다(host.mjs profileOf)
export function prepare(profile) {
  const ws = setPaths(profile?.id || 'default').claude;
  const docs = (profile?.knowledge || []).map((id) => fetchKnowledge(profile?.id, id)).filter(Boolean);
  const versions = { profile: profile ? `${profile.id}@v${profile.version}` : null, knowledge: docs.map((d) => `${d.id}@v${d.version}`) };
  // 포트·데이터 폴더가 바뀌면 mcp.json 의 env 도 다시 써야 하므로 stamp 에 넣는다
  const stamp = JSON.stringify({ ...versions, port: PORT, data: DATA });
  const versionFile = path.join(ws, '.koa', 'version.json');
  const fresh = fs.existsSync(versionFile) && fs.readFileSync(versionFile, 'utf8') === stamp;
  if (!fresh) {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.mkdirSync(ws, { recursive: true }); // 지식 문서가 없어도 작업 폴더는 있어야 한다
    const imports = [];
    for (const d of docs) {
      for (const [name, content] of Object.entries(d.files || {})) {
        const rel = path.posix.join('knowledge', safe(d.id), name);
        fs.mkdirSync(path.join(ws, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(ws, rel), content);
        if (name.endsWith('.md')) imports.push(`@${rel}`);
      }
    }
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), [
      '<!-- koala가 지식 문서로 만든 사본입니다. 직접 고치지 말고 지식 문서를 고쳐 새 버전으로 게시하세요. -->',
      `<!-- ${versions.knowledge.join(', ') || '연결된 지식 없음'} -->`,
      '',
      ...imports,
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    const settings = {};
    if (profile?.claude?.model) settings.model = profile.claude.model;
    fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
    // koa 도구(MCP) 설정은 작업 폴더가 바뀌어도 찾을 수 있게 절대 경로로 둔다
    fs.mkdirSync(path.dirname(versionFile), { recursive: true });
    fs.writeFileSync(path.join(ws, '.koa', 'mcp.json'), JSON.stringify({
      mcpServers: { koala: { command: process.execPath, args: [path.join(dir, 'mcp-server.mjs')],
        // Claude CLI가 띄우는 프로세스라 호스트 환경을 믿지 않고 명시한다
        env: { KOALA_PORT: String(PORT), KOALA_DATA_DIR: DATA } } },
    }, null, 2));
    fs.writeFileSync(versionFile, stamp);
  }
  return { dir: ws, mcpConfig: path.join(ws, '.koa', 'mcp.json'), versions, stamp, rebuilt: !fresh };
}

// "Claude 설정 보기"용: 작업 폴더 파일과 @ 불러오기를 펼친 CLAUDE.md
export function describe(profile) {
  const w = prepare(profile);
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push({ name: path.relative(w.dir, p).split(path.sep).join('/'), content: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(w.dir);
  const claudeMd = fs.readFileSync(path.join(w.dir, 'CLAUDE.md'), 'utf8');
  const expanded = claudeMd.replace(/^@(.+)$/gm, (m, rel) => {
    const p = path.join(w.dir, rel.trim());
    return fs.existsSync(p) ? `<!-- ${rel} -->\n${fs.readFileSync(p, 'utf8')}` : m;
  });
  return { ...w, files: files.filter((f) => !f.name.startsWith('.koa/')), claudeMdExpanded: expanded };
}
