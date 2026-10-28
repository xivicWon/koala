// 업데이트: GitHub 릴리즈(태그) 기준. 설치본은 릴리즈 태그를 체크아웃한 상태로 둔다.
//   확인: 최신 릴리즈 태그와 지금 버전을 비교
//   적용: git fetch → 태그 체크아웃 → (package-lock이 바뀌었으면) npm ci → 호스트 재시작
// 개발 체크아웃(태그가 아닌 브랜치)은 업데이트하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const dir = path.dirname(fileURLToPath(import.meta.url));
const pkg = () => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const git = async (...args) => (await run('git', args, { cwd: dir })).stdout.trim();

export const version = () => pkg().version;

// 지금 체크아웃이 릴리즈 태그인가(아니면 개발 체크아웃)
export async function installed() {
  const v = version();
  const tag = await git('describe', '--tags', '--exact-match', 'HEAD').catch(() => null);
  return { version: v, tag, dev: !tag };
}

const newer = (a, b) => {
  const p = (s) => String(s).replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

// GitHub 최신 릴리즈. 1분마다 보므로 API 한도(토큰 없이 IP당 시간당 60회, 304 응답도 센다)를 쓰지 않는다:
//   1) 웹 주소 /releases/latest 가 돌려보내는 주소(…/releases/tag/<태그>)로 최신 태그를 안다. API 한도에 세지 않는다
//   2) 태그가 바뀌었을 때만 API로 릴리즈 노트를 한 번 받는다
let cached = null; // 마지막으로 받은 릴리즈 { tag, name, notes, released_at, url }
export async function latest() {
  const repo = process.env.KOALA_GITHUB_REPO || pkg().koala?.github; // owner/name. 시험용으로 바꿔 끼울 수 있다
  const web = process.env.KOALA_GITHUB_WEB || 'https://github.com';
  const api = process.env.KOALA_GITHUB_API || 'https://api.github.com';
  if (!repo) throw new Error('package.json 에 koala.github(owner/name)가 없습니다');
  const r = await fetch(`${web}/${repo}/releases/latest`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
  const loc = r.headers.get('location') || '';
  if (r.status === 404 || (r.status >= 300 && r.status < 400 && !/\/releases\/tag\//.test(loc))) return null; // 아직 릴리즈가 없다
  if (r.status < 300 || r.status >= 400) throw new Error(`릴리즈 정보를 받지 못했습니다(HTTP ${r.status})`);
  const tag = decodeURIComponent(loc.split('/releases/tag/')[1]);
  if (cached?.tag === tag) return cached;
  const rel = { tag, name: tag, notes: '', released_at: null, url: loc };
  try {
    const d = await fetch(`${api}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'koala-updater' },
      signal: AbortSignal.timeout(8000),
    });
    if (d.ok) {
      const j = await d.json();
      Object.assign(rel, { name: j.name || tag, notes: j.body || '', released_at: j.published_at, url: j.html_url || loc });
    }
  } catch { /* 노트는 없어도 업데이트는 알린다 */ }
  // 노트를 못 받았으면(한도 초과 등) 다음 확인 때 다시 받는다
  if (rel.released_at) cached = rel;
  return rel;
}

export async function check() {
  const cur = await installed();
  try {
    const rel = await latest();
    return { ...cur, latest: rel, available: !!rel && !cur.dev && newer(rel.tag, cur.version) };
  } catch (e) {
    return { ...cur, error: e.message, available: false };
  }
}

// 태그로 바꾼다. 고친 파일이 있으면 멈춘다(사용자 설정은 .env와 확장 저장소에만 있다)
export async function apply(tag, log = () => {}) {
  const cur = await installed();
  if (cur.dev) throw new Error('개발 체크아웃(태그가 아닌 브랜치)은 업데이트하지 않습니다');
  const dirty = await git('status', '--porcelain', '--untracked-files=no');
  if (dirty) throw new Error(`고친 파일이 있어 업데이트를 멈췄습니다:\n${dirty}`);
  log(`릴리즈 ${tag} 를 받는 중`);
  await git('fetch', '--quiet', '--tags', 'origin');
  const lockChanged = await git('diff', '--name-only', 'HEAD', tag, '--', 'package-lock.json').then(Boolean);
  await git('-c', 'advice.detachedHead=false', 'checkout', '--quiet', tag);
  if (lockChanged) {
    log('의존성을 다시 설치하는 중(npm ci)');
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, shell: process.platform === 'win32' });
  }
  return { from: cur.version, to: version() };
}
