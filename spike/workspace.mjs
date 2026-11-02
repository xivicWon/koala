// 프로필의 Claude 작업 폴더: <프로필>/.koala-work/work/claude/ (세션은 이 경로에 묶인다)
//     CLAUDE.md              ← Claude 가 자동으로 읽음. koala 기본 → 사용자 레벨 → 프로필 폴더의 글을 절대 경로 @ 로 불러온다(사본 없음)
//     .claude/settings.json  ← 이 작업 폴더용 Claude 설정
//     .koa/version.json      ← 어떤 파일 목록으로 만들었는지(목록이 바뀌면 다시 만들고 새 대화로)
// 규칙(.koala/rules/, ~/.koala/rules/)은 대화가 끊기지 않게 호스트가 지시할 때마다 붙인다(rules.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, PORT, PROFILES, USER_DIR } from './paths.mjs';
import { setPaths, profileFiles } from './sets.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));

// profile.id 는 프로필 id 다(host.mjs profileOf)
export function prepare(profile) {
  const ws = setPaths(profile?.id || 'default').claude;
  const layers = profileFiles(profile?.id || 'default');
  const files = [...layers.koala, ...layers.user, ...layers.project];
  const versions = { profile: profile ? profile.id : null, files: files.length };
  // 포트·데이터 폴더·읽는 파일 목록이 바뀌면 다시 만든다(mcp.json 의 env, CLAUDE.md 의 @ 목록)
  const stamp = JSON.stringify({ profile: versions.profile, files, model: profile?.claude?.model || null, port: PORT, data: DATA });
  const versionFile = path.join(ws, '.koa', 'version.json');
  const fresh = fs.existsSync(versionFile) && fs.readFileSync(versionFile, 'utf8') === stamp;
  if (!fresh) {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.mkdirSync(ws, { recursive: true });
    const group = (title, list) => (list.length ? [`<!-- ${title} -->`, ...list.map((f) => `@${f}`), ''] : []);
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), [
      '<!-- koala 가 만든 파일입니다. 고치지 마세요. 아래 파일들을 고치거나, 사용자 레벨(~/.koala/)·프로필 폴더에 새 파일을 추가하세요. -->',
      '',
      ...group('koala 기본(업데이트로 바뀜)', layers.koala),
      ...group('사용자 레벨', layers.user),
      ...group('프로필', layers.project),
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
        env: { KOALA_PORT: String(PORT), KOALA_DATA_DIR: DATA, KOALA_PROFILES: PROFILES, KOALA_USER_DIR: USER_DIR } } },
    }, null, 2));
    fs.writeFileSync(versionFile, stamp);
  }
  return { dir: ws, mcpConfig: path.join(ws, '.koa', 'mcp.json'), versions, stamp, rebuilt: !fresh };
}

// "Claude 설정 보기"용: 작업 폴더와 층별로 읽는 파일
export function describe(profile) {
  const w = prepare(profile);
  return { ...w, layers: profileFiles(profile?.id || 'default') };
}
