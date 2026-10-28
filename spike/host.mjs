// 스파이크(버림용): 사이드패널 ↔ claude -p ↔ koala MCP 도구를 잇는 로컬 호스트
//   node host.mjs
import http from 'node:http';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import 'dotenv/config';
import * as graph from './graph.mjs';
import * as sync from './sync.mjs';
import * as workspace from './workspace.mjs';
import * as tags from './tags.mjs';
import * as update from './update.mjs';
import { hostToken, HEADER as TOKEN_HEADER } from './host-token.mjs';
import { fileURLToPath } from 'node:url';
import { DATA, PORT } from './paths.mjs';
import { safeId, setPaths } from './sets.mjs';

// ---------- 이 PC의 Claude Code 찾기 (각자 PC에 설치·로그인돼 있다는 전제, 없으면 사이드패널에 경고) ----------
const WIN = process.platform === 'win32';
function findClaude() {
  const home = os.homedir();
  const fromPath = (() => {
    try { return execFileSync(WIN ? 'where' : 'which', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean)?.trim(); } catch { return null; }
  })();
  const candidates = [
    process.env.CLAUDE_BIN, fromPath,
    path.join(home, '.local', 'bin', WIN ? 'claude.exe' : 'claude'),
    path.join(home, '.claude', 'local', WIN ? 'claude.exe' : 'claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
    WIN && path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
  ].filter(Boolean);
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}
let CLAUDE = null;
let claudeEnv = { ok: false, reason: 'unchecked' };
function claudeExec(args) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return execFileSync(CLAUDE, args, { encoding: 'utf8', env, timeout: 20000, shell: WIN && CLAUDE.endsWith('.cmd') });
}
function checkClaude() {
  CLAUDE = findClaude();
  if (!CLAUDE) {
    claudeEnv = { ok: false, reason: 'not_installed' };
    console.log('[claude] 문제: not_installed · 이 PC에서 claude 실행 파일을 찾지 못함');
    return claudeEnv;
  }
  try {
    const version = claudeExec(['--version']).trim();
    const st = JSON.parse(claudeExec(['auth', 'status']));
    // 이메일 같은 계정 정보는 패널로 보내지 않는다
    claudeEnv = st.loggedIn
      ? { ok: true, version, method: st.authMethod }
      : { ok: false, reason: 'not_logged_in', version };
  } catch (e) {
    claudeEnv = { ok: false, reason: 'check_failed', detail: String(e.message).slice(0, 200) };
  }
  console.log(`[claude] ${claudeEnv.ok ? `사용 가능 · ${claudeEnv.version}` : `문제: ${claudeEnv.reason}`} · ${CLAUDE ?? '경로 없음'}`);
  return claudeEnv;
}
checkClaude();
const dir = fileURLToPath(new URL('.', import.meta.url)); // 끝에 경로 구분자가 붙는다
const READ_ONLY = new Set(['snapshot', 'screenshot', 'tab_order']);
const TOOLS = ['run', 'snapshot', 'screenshot', 'goto', 'back', 'click', 'type', 'select', 'hover', 'press', 'tab_order', 'fault', 'fault_clear',
  'expect_visible', 'expect_text', 'expect_value', 'expect_count', 'expect_url', 'expect_focused', 'save_tests', 'save_code', 'save_tags', 'add_tests', 'append_code', 'make_tests'];
// 계획 모드: 로그인·검색 입력과 확인은 할 수 있지만, 데이터를 바꾸는 버튼 클릭과 Enter 제출은 확장이 차단한다.
// 테스트 기록에는 남기지 않는다. 결과는 save_plan
const PLAN_TOOLS = TOOLS;

const PLAN_SYSTEM = `
[계획 모드] 지금은 테스트를 만드는 단계가 아니라 테스트 계획을 만드는 단계다. 두 단계로 진행한다.
1) 업무 흐름 파악(한 바퀴): 요청을 글로만 파악하지 않는다. 실제 화면으로 이동해 흐름을 처음부터 마지막 저장 직전까지 한 번 따라간다.
   - 메뉴·탭·목록·대화상자·드롭다운을 열어 입력 항목, 필수 여부, 선택지, 안내·검증 메시지를 확인한다.
   - 입력 폼과 대화상자마다 tab_order로 키보드 탭 순서를 확인한다. 화면 순서와 다르거나, 빠지는 입력란, 갇히는 포커스가 있으면 기록한다.
   - 로그인·검색 입력은 해도 된다. 데이터 변경 요청(POST·PUT·PATCH·DELETE, 로그인 제외)은 브라우저에서 차단되므로 끝까지 진행해도 저장되지 않는다.
     도구 결과의 blockedRequests는 막힌 요청이다. 그 경로와 내용은 흐름 지도의 근거로 남긴다.
   - 삭제·승인·반려·철회처럼 되돌리기 어려운 버튼은 누르지 않는다. 열린 대화상자는 Escape나 닫기로 닫는다.
2) 케이스 설계: 흐름 지도를 바탕으로
   - BDD 시나리오: 사용자 행동 기준 Given/When/Then. 정상 흐름, 필수값·예외, 선택지별 차이, 권한, 목록·상태 반영을 고르게.
   - TDD 케이스: 시나리오마다 입력값·기대 결과·검증 방법을 먼저 정한 세부 케이스. 동등분할·경계값·예외·권한·접근성(탭 순서) 기법을 표시한다.
   - 화면에서 확인한 것만 근거로 쓴다. 확인 못 한 것은 만들지 않거나 '미확인'으로 적는다. 서비스 지식의 중점 방향으로 우선순위를 정한다.
마지막에 save_plan으로 저장하고, 시나리오·케이스 수, 우선순위 분포, 확인하지 못한 부분을 한국어로 짧게 요약한다.`;

const SYSTEM = `너는 웹 QA 담당자다. koala 도구로만 브라우저를 조작한다.
- 사용자가 지금까지 수행한 것으로 테스트(TDD·BDD·시나리오·케이스·테스트 초안)를 만들어 달라고 하면 make_tests 를 부르고 한 줄로 알린 뒤 응답을 끝낸다.
  "○○ 테스트해줘"처럼 수행을 요청하면 그것은 브라우저로 수행하라는 뜻이다. 만들어 달라는 뜻이 분명하지 않으면 먼저 묻는다.
- 먼저 snapshot으로 화면을 읽고, locator는 testid > text > css 순으로 고른다.
- 단계마다 도구를 따로 부르지 말고, 화면을 읽은 뒤 할 일을 **run으로 묶어 한 번에** 보낸다.
  (조작과 검증을 섞어 화면 전환 단위로 5~15단계씩. 다음 화면 구성을 모르면 거기까지만 묶는다)
  run이 중간에 실패하면 실패 지점의 오류·요청·현재 화면(snapshot)이 돌아온다. 그걸 보고 원인을 판단해 남은 계획을 다시 run으로 보낸다.
- 숫자가 섞인 자동 생성 testid(예: datatable-v-0-93-…, …-294821354305466377-…)는 피한다.
- 계정 입력은 아래 [대상 서비스]의 계정 이름($KOALA_ADMIN_USER, $KOALA_ADMIN_PASS 처럼)을 값으로 넘긴다. 실제 값을 추측하지 않는다.
- 역할(관리자·일반 사용자 등)마다 보이는 메뉴와 권한이 다르다. 사용자가 역할을 말하면 그 역할의 계정으로, 말하지 않으면 기본 역할로 로그인한다.
  로그인하기 전에 어느 역할로 하는지 한 줄로 말한다. 다른 역할로 바꿀 때는 로그아웃하고 그 역할 계정으로 다시 로그인한다.
- 데이터를 바꾸는 등록·저장·삭제 버튼은 사용자가 명시하지 않으면 누르지 않는다.
- 데이터를 새로 만들 때(제목·이름 입력) 값 앞에 반드시 '[koa] '를 붙인다. 테스트 데이터를 구분하고 나중에 정리하기 위해서다.
- 확인한 사실은 expect_* 도구로 남긴다. 이것이 테스트 코드의 검증문이 된다.
- 입력 폼은 탭 순서도 체크 포인트다. tab_order로 순서를 보고, 테스트로 남길 때는 press Tab 뒤에 expect_focused로 검증한다.
  보이는지(expect_visible)만이 아니라 글자·값·개수(expect_text / expect_value / expect_count)도 확인한다.
  단, 목업 데이터가 바뀌면 깨질 값(날짜, 건수 등)은 꼭 필요할 때만 쓴다.
- 조작 결과에는 그 단계의 API 요청(requests)과 콘솔 오류(consoleErrors)가 온다.
  4xx/5xx 응답, 실패한 요청, 콘솔 오류, 화면과 데이터의 불일치가 보이면 바로 한 줄로 알린다.
- 사람이 사이드패널로 지켜보고 있다. run을 보내기 전에 이번 묶음에서 무엇을 확인하는지 한 문장으로 말한다.
- 끝나면 무엇을 확인했고 이상한 점이 무엇이었는지 한국어로 짧게 요약한다.`;

// 사이드패널이 지시와 함께 보내는 활성 프로필(대상 서버·사이트 지식·계정). 계정 값은 개인 확장에만 저장된다
let profile = null;
// 역할: 프로필이 정한 권한 종류(관리자·일반 사용자 등). 계정은 역할에 붙는다
const roleOf = (key) => profile?.roles?.find((r) => r.key === key) || null;
const defaultRole = () => profile?.default_role || profile?.roles?.[0]?.key || null;
const accountFor = (role) => profile?.accounts?.find((a) => a.role === role) || null;
const roleName = (key) => (key ? `${roleOf(key)?.label || key}` : '');

// $KOALA_ADMIN_USER 같은 이름 → 프로필 계정 값, 없으면 환경변수.
// 역할이 생기기 전 코드의 $KOALA_USER·$KOALA_PASS 는 기본 역할 계정으로 본다
function secretValue(name) {
  const m = name.match(/^(.+)_(USER|PASS)$/);
  let acc = m && profile?.accounts?.find((a) => a.key === m[1]);
  if (!acc && m?.[1] === 'KOALA') acc = accountFor(defaultRole());
  const v = acc && (m[2] === 'USER' ? acc.user : acc.pass);
  // 기본 역할 계정은 값이 없으면 예전 .env 의 KOALA_USER·KOALA_PASS 를 쓴다
  const legacy = acc && acc.role === defaultRole() ? process.env[`KOALA_${m[2]}`] : '';
  return v || process.env[name] || legacy || '';
}
function profileContext() {
  if (!profile) return '';
  const def = defaultRole();
  const roles = (profile.roles || []).map((r) => {
    const a = accountFor(r.key);
    return `- ${r.key} ${r.label}${r.key === def ? ' (기본)' : ''}: ${r.desc || ''}${a ? ` · 계정 $${a.key}_USER / $${a.key}_PASS${secretValue(`${a.key}_USER`) ? '' : ' (값 미입력: 이 역할로는 로그인할 수 없다)'}` : ' · 계정 없음'}`;
  }).join('\n');
  const accs = (profile.accounts || []).filter((a) => !a.role).map((a) => `- ${a.label || a.key}: $${a.key}_USER / $${a.key}_PASS${a.user ? '' : ' (값 미입력)'}`).join('\n');
  return `\n\n[대상 서비스: ${profile.name} · 프로필 v${profile.version}]\n주소: ${profile.target?.base_url ?? '-'}${profile.target?.start_url ? ` · 테스트 시작 URL: ${profile.target.start_url}` : ''}\n`
    + `${roles ? `역할과 계정(값은 이름으로만 넘긴다):\n${roles}\n` : ''}${accs ? `계정(값은 이름으로만 넘긴다):\n${accs}\n` : ''}`
    + `${profile.prompt ? `사이트 지식:\n${profile.prompt}` : ''}`;
}

// koa가 마지막으로 로그인한 계정(아이디 입력란에 $<계정>_USER 를 넣은 것으로 안다)
let actor = null; // { key, role, at }
function sendActor() {
  send({ type: 'actor', actor: actor && { ...actor, label: roleName(actor.role), account: profile?.accounts?.find((a) => a.key === actor.key)?.label } });
}
function noteLogin(name) {
  const m = name.match(/^(.+)_USER$/);
  if (!m) return;
  let acc = profile?.accounts?.find((a) => a.key === m[1]);
  if (!acc && m[1] === 'KOALA') acc = accountFor(defaultRole());
  actor = { key: acc?.key || m[1], role: acc?.role || null, at: new Date().toISOString() };
  sendActor();
}

let mode = 'write'; // 'plan' | 'write'
let stopRequested = false;

// 사용자가 중지: Claude 프로세스를 끝내고, 진행 중인 큐와 대기 중인 도구 호출을 정리한다
function stopRun() {
  stopRequested = true;
  pendingDerive = null;
  stopClaude();
  endJob(false, '사용자가 중지했습니다');
  // 로컬 테스트 실행도 함께 끝낸다
  for (const c of children) if (c.isTestRun) try { c.kill(); } catch {}
  // 세션은 유지한다(재시작해도 이어지는 것과 같게). 새 대화는 '세션 비우기'나 지식·프로필 변경 때만
  for (const [id, resolve] of pending) { resolve({ ok: false, error: '사용자가 중지했습니다' }); pending.delete(id); }
  timing = null;
  send({ type: 'busy', busy: false });
  log('sys', `사용자가 중지했습니다. 다음 지시는 같은 세션${sessionAlias ? `(${sessionAlias})` : ''}으로 이어집니다`);
  scheduleWarm(1500); // 다음 지시가 바로 시작되도록 같은 대화로 다시 띄워 둔다
}
const toolsFor = () => (mode === 'plan' ? PLAN_TOOLS : TOOLS);

let panel = null;
let sessionId = null;
// 사용자에게 보이는 세션 이름(kaa-N). 실제 Claude 대화 id와 짝지어 저장해, 다시 연결해도 같은 이름 = 같은 대화
let sessionAlias = null;
let aliasSeq = 0;
// 사용량(아래 noteLimits·noteTurn이 채운다)
let usage = { limits: null, session: { input: 0, output: 0, turns: 0 } };
function sendSession() {
  if (!sessionAlias) { usage.session = { input: 0, output: 0, turns: 0 }; sendUsage(); } // 새 대화면 세션 토큰을 0부터 센다
  send({ type: 'session', alias: sessionAlias });
}
let steps = [];
const pending = new Map();

const send = (m) => panel?.readyState === 1 && panel.send(JSON.stringify(m));
const log = (kind, text) => { send({ type: 'log', kind, text }); console.log(`[${kind}] ${text}`); audit('log', { kind, text }); };
// 작업 기록: 도메인마다 .koa/domains/<호스트>/logs/<날짜>.jsonl 에 한 줄씩 남긴다(사용자 지시·도구 호출·테스트 실행·안내 문구).
// 비밀값은 남기지 않는다($KOALA_* 이름만). 30일이 지난 파일은 호스트가 켜질 때 지운다
const LOG_DAYS = 30;
const logsDir = (d) => path.join(bucket(d), 'logs');
function audit(ev, data = {}) {
  try {
    const now = new Date();
    const day = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.appendFileSync(path.join(logsDir(), `${day}.jsonl`), `${JSON.stringify({ t: now.toISOString(), ev, domain, session: sessionAlias || undefined, ...data })}\n`);
  } catch {}
}
function pruneLogs() {
  const root = path.join(DATA, 'domains');
  const cut = Date.now() - LOG_DAYS * 86400000;
  try {
    for (const d of fs.readdirSync(root)) {
      const ld = path.join(root, d, 'logs');
      if (!fs.existsSync(ld)) continue;
      for (const f of fs.readdirSync(ld)) if (f.endsWith('.jsonl') && fs.statSync(path.join(ld, f)).mtimeMs < cut) fs.rmSync(path.join(ld, f), { force: true });
    }
  } catch {}
}
// 도구 인자를 기록용으로 줄인다: 비밀은 이름만, 긴 값은 자른다, 스크린샷 같은 큰 값은 뺀다
const briefArgs = (a = {}) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'guard').map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : Array.isArray(v) ? `[${v.length}]` : v]));
// ── 도메인별 작업 데이터 ──
// 수행 기록·Claude 세션·현재 화면·보관본·테스트 초안을 대상 도메인(프로필 대상 주소의 호스트 이름)마다 따로 둔다.
//   .koa/state.json                 — 전체: 지금 도메인, 세션 이름 번호(kaa-N)
//   .koa/domains/<호스트>/state.json — 그 도메인의 대화 id·세션 이름·수행 기록·현재 화면·로그인 역할
//   .koa/domains/<호스트>/recording.json, recordings/, drafts/
// 어느 도메인인지는 사이드패널이 정해 보낸다(프로필 대상 주소를 고치는 도중에는 바뀌지 않게)
const STATE = path.join(DATA, 'state.json');
let domain = 'default';
const safeDomain = (d) => String(d || 'default').toLowerCase().replace(/[^\w.-]/g, '_');
const bucket = (d = domain) => path.join(DATA, 'domains', safeDomain(d));
const recFile = () => path.join(bucket(), 'recording.json');
const draftsDir = () => path.join(bucket(), 'drafts');
// 프로필의 도메인: 대상 주소의 호스트 이름. 없으면 default
function domainOf(p) {
  try { return new URL(p?.target?.base_url).hostname || 'default'; } catch { return 'default'; }
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
// 테스트 코드는 세트 폴더에 둔다: <데이터>/sets/<세트>/tests/code/<세트>.spec.ts (절대 경로; 세트당 한 파일)
// 지금은 호출하는 쪽이 현재 묶음 id를 넘긴다(묶음 id = 세트 id 가 되는 건 다음 작업)
function codeFile(setId) {
  return `${setPaths(setId).code}/${safeId(setId)}.spec.ts`;
}

// 호스트를 다시 띄워도 이어서 진행하도록 대화 id·수행 기록·현재 화면을 저장한다
function saveState() {
  try {
    fs.mkdirSync(bucket(), { recursive: true });
    fs.writeFileSync(path.join(bucket(), 'state.json'), JSON.stringify({ domain, sessionId, sessionAlias, steps, curScreen, lastStamp, actor, savedAt: new Date().toISOString() }, null, 2));
    fs.writeFileSync(STATE, JSON.stringify({ domain, aliasSeq, savedAt: new Date().toISOString() }, null, 2));
  } catch {}
}
const saveRec = () => { fs.mkdirSync(bucket(), { recursive: true }); fs.writeFileSync(recFile(), JSON.stringify(steps, null, 2)); saveState(); };
// 새 시나리오로 지우기 전에 직전 기록을 recordings/<시각>.json 으로 보관한다
function archiveRec() {
  if (!steps.length) return;
  const d = path.join(bucket(), 'recordings');
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(steps, null, 2));
  log('sys', `직전 기록 ${steps.length}단계를 보관했습니다: recordings/${path.basename(file)} (${domain})`);
}
// 도메인의 작업 데이터를 불러온다(없으면 빈 상태)
function loadDomain(d) {
  domain = d;
  let st = {};
  try { st = JSON.parse(fs.readFileSync(path.join(bucket(), 'state.json'), 'utf8')); } catch { /* 처음 */ }
  sessionId = st.sessionId || null;
  sessionAlias = st.sessionAlias || null;
  steps = Array.isArray(st.steps) ? st.steps : [];
  curScreen = st.curScreen || null;
  lastStamp = st.lastStamp || null;
  actor = st.actor || null;
  return st;
}
// 다른 도메인의 프로필로 바뀌면 지금 데이터를 저장하고 그 도메인의 데이터로 바꾼다. 작업 중에는 바꾸지 않는다
function switchDomain(d) {
  if (!d || d === domain) return true;
  if (job || codeRunning) { log('err', `AI 작업이나 테스트 실행 중에는 다른 도메인(${d})으로 바꿀 수 없습니다. 끝난 뒤 프로필을 다시 고르세요`); return false; }
  saveState();
  stopClaude();
  const from = domain;
  loadDomain(d);
  saveState();
  sendSession(); sendActor();
  send({ type: 'domain', domain, steps: steps.length });
  console.log(`[domain] ${from} → ${domain} · 대화 ${sessionId ? sessionId.slice(0, 8) : '없음'} · 기록 ${steps.length}단계`);
  log('sys', `대상 도메인 ${domain}의 작업 데이터로 바꿨습니다 · 세션 ${sessionAlias || '없음'} · 수행 기록 ${steps.length}단계`);
  return true;
}

// MCP 서버가 부르는 도구 호출 → 사이드패널로 넘기고 결과를 기다린다
async function relay(name, args) {
  if (!panel) return { ok: false, error: '사이드패널이 연결되지 않음' };
  if (stopRequested) return { ok: false, error: '사용자가 중지했습니다' };
  const id = randomUUID();
  const real = { ...args };
  if (mode === 'plan') real.guard = true; // 확장이 데이터를 바꾸는 버튼 클릭을 막는다
  if (typeof real.value === 'string' && real.value.startsWith('$')) {
    real.value = secretValue(real.value.slice(1));
    real.secret = true; // 사이드패널·화면 표시에서 값을 가린다
    if (name === 'type') noteLogin(args.value.slice(1));
  }
  if (name === 'clear_login') { actor = null; sendActor(); }
  const t0 = Date.now();
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: '사이드패널 응답 시간 초과' }); }, 90000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    send({ type: 'tool', id, name, args: real });
  });
  console.log(`[time] ${name} ${Date.now() - t0}ms`);
  audit('tool', { name, args: briefArgs(args), ok: !!result.ok, ms: Date.now() - t0, url: result.result?.url, error: result.ok ? undefined : String(result.error || '').slice(0, 300) });
  if (result.ok && !READ_ONLY.has(name) && mode === 'plan') {
    await trackPath(name, args, result.result); // 이동 경로는 그래프에 남기고, 테스트 기록에는 넣지 않는다
  } else if (result.ok && !READ_ONLY.has(name)) {
    // 기록은 generate.mjs 형식에 맞춘다. 비밀값은 $이름 그대로 남긴다.
    const action = name.replace(/_(\w)/g, (_, c) => c.toUpperCase());
    const { url, locator, value, option, key, text, count, pattern, method, path: fpath, kind, status, body, delay_ms, times } = args;
    steps.push({ action, url, locator, value, option, key, text, count, pattern, method, path: fpath, kind, status, body, delay_ms, times, matched: result.result?.matched, role: actor?.role || undefined });
    saveRec();
    await trackPath(name, args, result.result);
  }
  return result;
}

// 계획(큐)을 받아 쉬지 않고 차례로 실행한다. 실패하면 예외처럼 멈추고 실패 지점 정보를 돌려준다.
const brief = (r) => {
  if (!r) return r;
  const { image, forAi, elements, ...rest } = r;
  return rest;
};
async function runPlan(steps) {
  // 단계는 {tool, ...인자} 한 겹 객체로 온다
  const plan = steps.map(({ tool, args, ...rest }) => ({ tool, args: args || rest }));
  const shown = plan.map(({ tool, args = {} }) => ({
    tool, args: { ...args, secret: typeof args.value === 'string' && args.value.startsWith('$') },
  }));
  send({ type: 'plan', steps: shown });
  const results = [];
  let lastImage = null; // 묶음 안에서 찍은 스크린샷도 AI가 볼 수 있게 마지막 한 장을 결과에 붙인다
  for (let i = 0; i < plan.length; i++) {
    if (stopRequested) {
      send({ type: 'plan_end', skipped: plan.length - i });
      return { ok: false, error: '사용자가 중지했습니다' };
    }
    const { tool, args = {} } = plan[i];
    const r = toolsFor().includes(tool) && !['run', 'save_tests', 'save_code', 'save_tags', 'add_tests', 'append_code', 'make_tests'].includes(tool) ? await relay(tool, args)
      : { ok: false, error: mode === 'plan' && TOOLS.includes(tool) ? `계획 모드에서는 ${tool}을 쓸 수 없습니다(둘러보기만 가능)` : `알 수 없는 도구: ${tool}` };
    if (!r.ok) {
      send({ type: 'plan_end', skipped: plan.length - i - 1 });
      const snap = await relay('snapshot', {});
      return { ok: true, result: {
        status: 'failed', completed: i, failedAt: i, failedStep: plan[i], error: r.error, context: r.context,
        remaining: plan.slice(i + 1),
        screen: snap.ok ? { url: snap.result.url, elements: snap.result.elements, tables: snap.result.tables } : null,
      } };
    }
    if (tool === 'screenshot' && r.result?.image) lastImage = r.result.image;
    results.push({ i, tool, ...(tool === 'snapshot' ? r.result : brief(r.result)) });
  }
  send({ type: 'plan_end', skipped: 0 });
  return { ok: true, result: { status: 'done', completed: plan.length, results, ...(lastImage ? { image: lastImage } : {}) } };
}

// claude 프로세스를 하나 띄워 두고 지시를 stdin으로 이어 보낸다(상주 세션). KOALA_PERSIST=0 이면 지시마다 새로 띄운다
const PERSIST = process.env.KOALA_PERSIST !== '0';
let proc = null;
let timing = null; // 지시 1건의 시간 분해: 기동 / 모델 / 브라우저

// effort: 프로필 → 사용자 Claude Code 설정(~/.claude/settings.json 의 effortLevel) → medium
function effortFor() {
  if (profile?.claude?.effort) return profile.claude.effort;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).effortLevel;
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(v)) return v;
  } catch {}
  return 'medium';
}

// 호스트가 끝나면(오류로 죽어도) Claude와 테스트 실행을 함께 끝낸다. 남으면 새 호스트에 엉뚱한 요청을 보낸다
const children = new Set();
process.on('exit', () => { for (const c of children) try { c.kill(); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

function spawnClaude(extra, ws) {
  // 작업 폴더(지식 문서 사본)에서 실행하고, 사용자 개인 설정은 읽지 않는다(--setting-sources project)
  // --include-partial-messages: AI가 쓰는 도중의 글자를 받아 진행 단계(예: 코드 18KB 작성)를 보여 준다
  const args = [...extra, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', ws.mcpConfig, '--strict-mcp-config', '--setting-sources', 'project',
    '--tools', '', '--allowedTools', toolsFor().map((t) => `mcp__koala__${t}`).join(','),
    '--append-system-prompt', mode === 'plan' ? SYSTEM + PLAN_SYSTEM : SYSTEM];
  // 모델은 프로필 설정을 따르고(없으면 Claude Code 기본값), effort는 항상 명시해 실제 값을 알 수 있게 한다
  const model = profile?.claude?.model || process.env.KOALA_MODEL;
  if (model) args.push('--model', model);
  args.push('--effort', effortFor());
  const env = { ...process.env };
  delete env.CLAUDECODE; // 바깥 Claude Code 세션 안에서 띄울 때 중첩 방지 검사를 피한다
  const p = spawn(CLAUDE, args, { cwd: ws.dir, env, stdio: [PERSIST ? 'pipe' : 'ignore', 'pipe', 'pipe'], shell: WIN && CLAUDE.endsWith('.cmd') });
  children.add(p);
  p.on('close', () => children.delete(p));
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      handleEvent(ev);
    }
  });
  p.stderr.on('data', (d) => { p.lastErr = String(d); log('err', String(d).trim()); });
  p.on('exit', (code) => {
    if (proc === p) proc = null;
    if (!PERSIST) send({ type: 'busy', busy: false });
    // 새 시나리오로 일부러 끝낸 경우(p.stopped)는 오류가 아니다
    if (code && !p.stopped) log('err', `claude 종료 코드 ${code}`);
    if (!p.stopped) {
      endJob(false, 'AI 프로세스가 끝났습니다');
      if (PERSIST) {
        if (warming?.proc === p) warmFailed(`claude 종료 코드 ${code}`);
        else { send({ type: 'busy', busy: false }); retryWarm(`Claude가 끝났습니다(종료 코드 ${code})`); }
      }
    }
  });
  p.stamp = ws.stamp;
  return p;
}

// ── 진행 단계: 작업마다 단계를 정해 두고, AI 출력·도구 호출을 보고 지금 단계를 사이드패널에 알린다 ──
const JOBS = {
  run: { label: '테스트 수행', steps: [['ask', '지시 전달'], ['act', '브라우저 조작'], ['report', '결과 정리']] },
  derive: { label: 'TDD·BDD 생성', steps: [['read', '수행 이력 검토'], ['write', '초안 작성'], ['save', '초안 저장']] },
  reinforce: { label: '예외·오류 보강', steps: [['act', '예외·오류 수행'], ['write', '초안 다시 작성'], ['save', '초안 저장']] },
  tags: { label: '태그 붙이기', steps: [['read', '항목 검토'], ['write', '태그 고르기'], ['save', '저장']] },
  add: { label: '테스트 추가', steps: [['act', '브라우저에서 확인'], ['write', '새 항목 작성'], ['save', '저장']] },
  code: { label: '테스트 코드 생성', steps: [['write', '코드 작성'], ['check', '실행 전 검사'], ['run', '로컬 실행'], ['review', '결과 확인']] },
  append: { label: '새 테스트 코드 추가', steps: [['write', '코드 작성'], ['check', '실행 전 검사'], ['run', '새 테스트 실행'], ['review', '결과 확인']] },
  localrun: { label: '테스트 실행', steps: [['run', '로컬 실행']] },
};
const SAVE_TOOLS = new Set(['save_tests', 'add_tests', 'save_tags', 'save_code', 'append_code']);
let job = null; // { kind, key, detail, started, round, bytes }
let jobSentAt = 0;
function sendJob(extra = {}) {
  if (!job) return;
  jobSentAt = Date.now();
  const { kind, key, detail, started, round } = job;
  send({ type: 'job', kind, label: JOBS[kind].label, steps: JOBS[kind].steps, key, detail, started, round, ...extra });
}
function startJob(kind) {
  job = { kind, key: JOBS[kind].steps[0][0], detail: '', started: Date.now(), round: 1, bytes: 0 };
  sendJob();
}
// 단계를 바꾼다. 결과를 보고 다시 쓰기 시작하면(코드 수정) 몇 번째 시도인지 센다
function stepJob(key, detail = '') {
  if (!job || !JOBS[job.kind].steps.some(([k]) => k === key)) { if (job) { job.detail = detail; sendJob(); } return; }
  if (key === 'write' && job.key === 'review') job.round += 1;
  job.key = key; job.detail = detail; job.bytes = 0;
  sendJob();
}
// 세부 내용만 바뀔 때는 너무 자주 보내지 않는다
function detailJob(detail) {
  if (!job || job.detail === detail) return;
  job.detail = detail;
  if (Date.now() - jobSentAt > 400) sendJob();
}
function endJob(ok = true, detail = '') {
  if (!job) return;
  sendJob({ done: true, ok, detail, elapsed: Date.now() - job.started });
  job = null;
}
const toolLabel = (n) => ({ run: '조작 묶음 실행', snapshot: '화면 읽기', screenshot: '화면 보기', goto: '페이지 이동', click: '클릭', type: '입력', select: '선택', press: '키 입력', tab_order: '탭 순서 측정', fault: '오류 주입' })[n] || (n.startsWith('expect_') ? '검증' : n);

// AI의 실시간 출력(--include-partial-messages)으로 지금 하는 일을 알린다
let streamTool = null;
function onStream(e) {
  if (!job || warming) return;
  if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
    const name = e.content_block.name.replace('mcp__koala__', '');
    streamTool = name;
    if (SAVE_TOOLS.has(name)) stepJob('write', name === 'save_code' || name === 'append_code' ? '코드를 쓰는 중' : '내용을 쓰는 중');
    else if (['run', 'reinforce', 'add'].includes(job.kind)) stepJob('act', `${toolLabel(name)} 준비 중`);
    else detailJob(`${toolLabel(name)} 준비 중`);
  } else if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') {
    detailJob('AI가 생각하는 중');
  } else if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
    // 테스트 수행에서 조작 뒤에 글을 쓰기 시작하면 결과를 정리하는 중이다(조작이 이어지면 다시 '브라우저 조작')
    if (job.kind === 'run' && job.key === 'act') stepJob('report', 'AI가 확인한 내용을 정리하는 중');
    else detailJob('AI가 내용을 정리하는 중');
  } else if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && SAVE_TOOLS.has(streamTool)) {
    job.bytes += Buffer.byteLength(e.delta.partial_json || '');
    detailJob(`${streamTool === 'save_code' || streamTool === 'append_code' ? '코드' : '내용'} ${(job.bytes / 1024).toFixed(1)}KB 작성`);
  } else if (e.type === 'content_block_stop') {
    streamTool = null;
  }
}

// 사용량: Claude Code가 요청마다 알려 주는 구독 한도(5시간·7일 창의 사용률·초기화 시각)와, 이 세션에서 쓴 토큰
function sendUsage(to) { const m = JSON.stringify({ type: 'claude_usage', ...usage }); (to || panel)?.readyState === 1 && (to || panel).send(m); }
function noteLimits(info) {
  const w = info?.unifiedWindows || {};
  const win = (x) => x && { used: x.utilization, resets_at: x.resetsAt ? x.resetsAt * 1000 : null, status: x.status };
  usage.limits = { status: info.status, five_hour: win(w.five_hour), seven_day: win(w.seven_day), at: Date.now() };
  sendUsage();
}
function noteTurn(u) {
  if (!u) return;
  usage.session.input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  usage.session.output += u.output_tokens || 0;
  usage.session.turns += 1;
  sendUsage();
}

function handleEvent(ev) {
  if (ev.type === 'stream_event') return onStream(ev.event);
  if (ev.type === 'rate_limit_event') return noteLimits(ev.rate_limit_info);
  if (ev.type === 'result') noteTurn(ev.usage);
  // 미리 연결의 확인 응답은 대화창에 보이지 않는다. 그 사이 들어온 지시는 그다음 차례로 처리된다
  if (warming && ev.type === 'assistant') return;
  if (warming && ev.type === 'result') return ev.is_error ? warmFailed('확인 응답이 오류로 끝났습니다') : warmDone();
  if (ev.type === 'result' && !ev.is_error && claudeConn !== 'ready') sendConn('ready');
  const now = Date.now();
  if (ev.type === 'system' && ev.subtype === 'init' && ev.model) {
    // 실제로 쓰는 모델과 effort를 사이드패널 Claude 버튼에 보여 준다
    send({ type: 'claude_run', model: ev.model, effort: effortFor() });
  }
  if (ev.type === 'system' && ev.session_id) {
    if (sessionId !== ev.session_id) {
      // 이어받기(resume)면 Claude가 새 id를 줄 수 있다. 같은 대화를 잇는 것이므로 이름(kaa-N)은 유지한다
      if (!sessionAlias) sessionAlias = `kaa-${++aliasSeq}`;
      sessionId = ev.session_id;
      saveState();
      sendSession();
    }
    if (timing && !timing.init) timing.init = now;
  }
  if (ev.type === 'assistant') {
    if (timing && !timing.firstReply) timing.firstReply = now;
    for (const c of ev.message.content) {
      if (timing && c.type === 'thinking') timing.thinking = (timing.thinking || 0) + (c.thinking?.length || 0);
      if (c.type === 'text' && c.text.trim()) log('ai', c.text.trim());
      if (c.type === 'tool_use') {
        const name = c.name.replace('mcp__koala__', '');
        console.log(`[tool] → ${name} ${JSON.stringify(c.input)}`);
        if (!SAVE_TOOLS.has(name)) detailJob(name === 'run' ? `조작 ${c.input?.steps?.length || 0}단계 실행 중` : `${toolLabel(name)} 중`);
      }
    }
  }
  if (ev.type === 'user') {
    for (const c of ev.message.content || []) {
      if (c.type === 'tool_result' && c.is_error) console.log(`[err] ✗ ${JSON.stringify(c.content).slice(0, 300)}`);
    }
  }
  if (ev.type === 'result') {
    flushSegment(null);
    if (pendingDerive) setTimeout(runPendingDerive); // 이 응답에서 make_tests 를 불렀으면 이어서 테스트 초안을 만든다
    endJob(!ev.is_error, ev.is_error ? 'AI 작업이 오류로 끝났습니다' : '');
    if (timing) {
      const total = now - timing.t0;
      // 기동: 지시 → 모델 호출 시작 직전. 상주 세션은 init 이벤트가 없으면 0으로 본다
      const boot = timing.init ? timing.init - timing.t0 : 0;
      const model = total - boot - timing.tool;
      const sec = (ms) => (ms / 1000).toFixed(1);
      log('sys', `완료 · 전체 ${sec(total)}초 = 기동 ${sec(boot)} + 모델 ${sec(model)} + 브라우저 ${sec(timing.tool)} · `
        + `출력 ${ev.usage?.output_tokens ?? '?'}토큰 · 입력 ${(ev.usage?.input_tokens ?? 0) + (ev.usage?.cache_read_input_tokens ?? 0) + (ev.usage?.cache_creation_input_tokens ?? 0)}토큰 · 생각 ${timing.thinking || 0}자 · `
        + `AI 응답 ${ev.num_turns}회 · ${PERSIST ? (timing.warm ? '상주(재사용)' : '상주(첫 기동)') : '매번 기동'} · 기록 ${steps.length}단계`);
      timing = null;
    }
    if (PERSIST) send({ type: 'busy', busy: false });
  }
}

// ---------------- 경로 그래프 ----------------
// 실행 중 화면이 바뀔 때마다 그 사이의 조작 묶음을 (화면)-[PATH]->(화면) 으로 저장한다
let curScreen = null;
let segment = [];
let intent = '';

// 그래프 DB(Docker)가 없으면 경로 저장·재생만 끄고 나머지는 그대로 동작한다. 안내는 한 번만
let graphWarned = false;
function graphError(e) {
  if (/ECONNREFUSED|ENOTFOUND|connect/i.test(e.message)) {
    if (!graphWarned) log('sys', '그래프 DB에 연결할 수 없어 경로 저장·재생 없이 진행합니다 (docker compose up -d 로 켤 수 있습니다)');
    graphWarned = true;
  } else console.log('[graph]', e.message);
}

async function enterScreen(url) {
  const key = graph.screenKey(url);
  await graph.upsertScreen(key, url).catch((e) => graphError(e));
  return key;
}

async function trackPath(name, args, res) {
  const { secret, ...clean } = args;
  // 일치 개수도 남겨야 생성 코드가 Playwright strict 모드에 걸리지 않게 .first()를 붙일 수 있다
  segment.push({ tool: name, ...clean, ...(res?.matched > 1 ? { matched: res.matched } : {}) });
  const url = res?.url;
  if (!url || !curScreen) return;
  const key = graph.screenKey(url);
  if (key === curScreen) return;
  await enterScreen(url);
  await flushSegment(key);
}

async function flushSegment(to) {
  if (!segment.length || !curScreen) { curScreen = to ?? curScreen; return; }
  try {
    const r = await graph.recordPath(curScreen, to ?? curScreen, segment, intent);
    console.log(`[graph] ${curScreen} → ${to ?? curScreen} (${segment.length}단계, ${r.runs}회째)`);
  } catch (e) { graphError(e); }
  segment = [];
  curScreen = to ?? curScreen;
}

// AI에게 줄 알려진 경로 요약: 같은 엣지는 한 번만
function describeKnown(paths) {
  const seen = new Map();
  for (const path of paths) for (const e of path) seen.set(`${e.from}|${e.sig}|${e.to}`, e);
  return [...seen.values()].map((e) =>
    `- ${e.from} → ${e.to} (성공 ${e.runs}회${e.fails ? `, 실패 ${e.fails}회` : ''}) 목적: ${e.intent}\n  steps: ${JSON.stringify(e.steps)}`).join('\n');
}

function stopClaude() {
  if (warming) { clearTimeout(warming.timer); warming = null; }
  if (!proc) return;
  proc.stopped = true;
  proc.kill();
  proc = null;
}

let lastStamp = null;

// 수행 이력으로 만든 테스트 초안: 저장하지 않고 사이드패널로 보내 사용자가 고르게 한다.
// 이번 수행 기록으로 만든 Playwright 코드도 함께 담는다
// 시나리오의 역할(as): AI가 적은 것 → 이번에 로그인한 역할 → 기본 역할
const withRole = (c) => {
  const roles = c.roles && Object.fromEntries(Object.entries(c.roles).filter(([k]) => roleOf(k)));
  const multi = roles && Object.keys(roles).length ? roles : undefined;
  const first = multi && (Object.keys(multi).find((k) => /^허용/.test(multi[k])) || Object.keys(multi)[0]);
  return { ...c, roles: multi, as: (roleOf(c.as) && c.as) || first || actor?.role || defaultRole() || undefined };
};

function saveTests(args) {
  stepJob('save', `BDD ${args.scenarios.length} · TDD ${args.cases.length}`);
  let spec = '';
  try {
    execFileSync(process.execPath, ['generate.mjs', 'koa-suite-draft', recFile()], { cwd: dir });
    spec = fs.readFileSync(`${dir}tests/koa-suite-draft.spec.ts`, 'utf8');
    fs.rmSync(`${dir}tests/koa-suite-draft.spec.ts`, { force: true });
  } catch (e) { spec = `// 코드 생성 실패: ${e.message}`; }
  const id = `${profile?.id || 'default'}--${crypto.createHash('sha1').update(String(args.title).trim()).digest('hex').slice(0, 8)}`;
  const doc = tagDoc();
  const tagged = (c) => { const { tags: suggested = [], ...rest } = c; return { ...rest, tags: tags.assign(doc, rest, suggested) }; };
  const draft = {
    id, name: args.title, profile: profile?.id, scope: args.scope, flow: args.flow,
    coverage: args.coverage || [],
    scenarios: args.scenarios.map((c) => ({ ...tagged(withRole(c)), use: true })),
    cases: args.cases.map((c) => ({ ...tagged(c), use: true })),
    tag_source: doc ? `${doc.id}@v${doc.version}` : undefined,
    spec, source: { steps: steps.length, created_at: new Date().toISOString() },
  };
  // 다시 만들지 않아도 되도록 초안 사본을 파일로 남긴다
  fs.mkdirSync(draftsDir(), { recursive: true });
  const base = sync.get('suite', id)?.version ?? 0;
  // 기준 버전도 함께 남겨야 복원한 초안을 서버로 보낼 때 충돌로 오인하지 않는다
  fs.writeFileSync(path.join(draftsDir(), `${id}.json`), JSON.stringify({ ...draft, base_version: base }, null, 2));
  send({ type: 'suite_draft', suite: draft, base_version: base, tag_doc: doc });
  log('sys', `테스트 초안 "${args.title}" · BDD ${args.scenarios.length}개 · TDD ${args.cases.length}개 — 사용할 것을 골라 반영하세요`);
  return { ok: true, result: { id, scenarios: args.scenarios.length, cases: args.cases.length } };
}

// 방금 수행한 이력을 바탕으로 TDD/BDD 초안을 만들게 한다(같은 대화에서 이어서)
const DERIVE_PROMPT = `[테스트 생성] 방금 이 대화에서 실제로 수행한 이력(조작, 확인한 화면·값, 네트워크 요청, 탭 순서, 이상 징후)을 바탕으로 테스트 초안을 만든다.
- 브라우저는 더 조작하지 않는다. 수행 중 확인한 사실만 근거로 쓴다. 확인하지 않은 것은 만들지 않거나 '미확인'으로 적는다.
- flow: 수행한 업무 흐름을 단계별로(화면, 입력 항목·필수 여부·선택지, 메시지, 탭 순서, 주요 요청)
- scenarios: BDD(Given/When/Then). 수행한 정상 흐름을 기본으로, 수행 중 드러난 예외·경계·탭 순서·목록 반영 시나리오를 더한다
- cases: 시나리오별 TDD 케이스(입력값·기대 결과·검증 방법 먼저). 정상/동등분할/경계값/예외/권한/접근성
- 실제로 수행해 검증한 시나리오와 아직 수행하지 않은 시나리오를 evidence에 구분해 적는다
- coverage: 예외·오류 점검표의 모든 항목(필수값 누락, 형식·길이, 취소·닫기, 중복 제출, 세션 만료, 권한 없음, 서버 오류, 응답 지연, 네트워크 끊김, 탭 순서)을 수행/미수행/해당 없음으로 채운다
- 미수행 예외도 시나리오로 만들되 제목 앞에 '[미수행]'을 붙이고, evidence에 수행 방법(어떤 조작, 필요하면 fault 주입)을 적는다
- 역할: 시나리오마다 수행한 역할을 as에 적는다(수행 기록의 [역할]). 여러 역할로 확인한 화면·기능은 시나리오를 역할마다 복사하지 말고
  roles에 역할별 기대 결과를 적는다(예: {"ADMIN":"허용","MEMBER":"거부: 메뉴 없음"}). 직접 확인한 역할만 적고, 거부·일부는 어떻게 막히는지까지 적는다.
  역할 사이 권한 차이 자체를 검증하는 TDD 케이스(기법: 권한)를 더한다.
마지막에 save_tests로 저장하고 한국어로 짧게 요약한다.`;

// 대화에서 "테스트 만들어줘"라고 하면 AI가 make_tests 를 부른다. 그 응답이 끝난 뒤 테스트 초안 만들기를 시작한다
let pendingDerive = null; // { note }
function queueDerive(args) {
  if (!steps.length) return { ok: false, error: '아직 수행 기록이 없다. 먼저 테스트를 수행해야 한다고 사용자에게 알린다' };
  pendingDerive = { note: String(args?.note || '').trim() };
  return { ok: true, result: { queued: true, steps: steps.length, message: '이 응답이 끝나면 테스트 초안 만들기를 시작한다. 한 줄로 알리고 응답을 끝낸다' } };
}
function runPendingDerive() {
  if (!pendingDerive) return;
  const { note } = pendingDerive;
  pendingDerive = null;
  if (stopRequested) return;
  log('sys', `수행 기록 ${steps.length}단계로 테스트 초안을 만듭니다${note ? ` · 요청: ${note}` : ''}`);
  setTimeout(() => deriveTests(note), 300);
}

function deriveTests(note = '') {
  if (!steps.length) { log('err', '테스트를 만들 수행 이력이 없습니다. 먼저 테스트를 수행하세요'); return; }
  const t = tags.prompt(tagDoc());
  let lastRole = null;
  const recap = steps.slice(0, 120).map((s, i) => `${s.role && s.role !== lastRole ? `[역할 ${(lastRole = s.role)} ${roleName(s.role)}]\n` : ''}${i + 1}. ${s.action} ${s.locator ? JSON.stringify(s.locator) : s.url || s.pattern || s.key || ''}${s.value ? ` = ${s.value}` : ''}${s.text ? ` "${s.text}"` : ''}`).join('\n');
  instruct(`${DERIVE_PROMPT}${note ? `\n\n[사용자 요청] ${note} — 이 범위·요청에 맞춰 만든다` : ''}${t ? `\n\n[태그] 서버가 내려준 목록이다. 시나리오·케이스마다 tags에 '붙이는 경우'에 맞는 것만 고른다(자동 태그는 호스트가 붙이니 적지 않아도 된다).\n${t}` : ''}\n\n[이번 수행 기록 ${steps.length}단계]\n${recap}`, { derive: true, job: 'derive' });
}

// 예외·오류 보강: 초안의 미수행 항목을 실제로 수행하고(필요하면 오류 주입) 초안을 다시 만든다
const REINFORCE_PROMPT = `[예외·오류 보강] 아래 테스트 초안에서 '미수행' 예외·오류 항목을 실제로 수행해 확인한다.
- 필수값 누락·형식·길이: 값을 비우거나 잘못 넣고 등록을 눌러 안내 메시지와 미반영을 확인한다(데이터가 만들어지면 [koa] 이름 규칙을 지킨다).
- 취소·닫기: 대화상자·작성 중 취소 시 값 유지/초기화를 확인한다.
- 중복 제출: 등록 버튼을 빠르게 두 번 눌러 요청이 한 번만 가는지 확인한다.
- 서버 오류·응답 지연·네트워크 끊김: fault로 해당 요청에 오류를 주입하고 조작한다. 화면의 오류 안내, 버튼 재활성화, 목록 미반영을 검증한다. 끝나면 fault_clear.
- 세션 만료·권한 없음: 실제로 만들 수 있으면 수행하고(예: fault로 401/403 주입), 불가능하면 이유를 적는다.
- 각 결과는 expect_* 검증으로 남긴다.
수행이 끝나면 save_tests로 초안 전체를 다시 저장한다. 기존 시나리오 id는 유지하고, 수행한 예외는 '[미수행]'을 떼고 근거를 채우며, coverage를 갱신한다.`;

function reinforceTests(summary) {
  instruct(`${REINFORCE_PROMPT}\n\n[현재 초안]\n${summary || '(요약 없음)'}`, { job: 'reinforce' });
}

// 서버가 내려준 태그 문서(지금은 임시 저장소). 프로필이 어느 문서를 쓰는지 정한다
const tagDoc = () => tags.withRoles(tags.load(profile?.tags || 'qa-tags'), profile?.roles);

// 이미 만든 초안에 태그를 붙인다: 자동 규칙 + AI 판단(save_tags). 사람 몫 태그는 그대로 둔다
const TAG_PROMPT = `[태그 붙이기] 아래 테스트 초안의 시나리오·케이스마다 태그를 골라 save_tags로 저장한다. 브라우저는 조작하지 않는다.
- 서버가 내려준 목록 안에서만 고른다. '붙이는 경우'에 맞는 것만 붙이고, 애매하면 붙이지 않는다.
- 자동 태그(우선순위 등)는 호스트가 붙이니 적지 않아도 된다.
- 시나리오에 붙인 기능 영역 태그는 딸린 케이스가 물려받는다. 케이스에 같은 것을 또 붙이지 않는다.
- 끝나면 어떤 기준으로 붙였는지 한국어로 짧게 요약한다.`;
let tagTarget = null; // 태그를 붙이는 초안 { id, items: Map(id → 항목) }

function suggestTags(s) {
  const doc = tagDoc();
  if (!doc) { log('err', '태그 문서를 받지 못했습니다(서버 태그 목록 없음)'); return; }
  tagTarget = { id: s.id, items: new Map([...s.scenarios, ...s.cases].map((c) => [c.id, c])) };
  const sc = s.scenarios.map((c) => `${c.id} ${c.title} (우선순위 ${c.priority}${c.changes_data ? ', 데이터 변경' : ''})\n  화면 ${(c.screens || []).join(', ')}\n  Then ${c.then.join(' / ')}`).join('\n');
  const tc = s.cases.map((c) => `${c.id} (${c.scenario}, ${c.technique}) ${c.title} · 검증: ${c.check}`).join('\n');
  instruct(`${TAG_PROMPT}\n\n[태그 목록 ${doc.id}@v${doc.version}]\n${tags.prompt(doc)}\n\n[시나리오]\n${sc}\n\n[케이스]\n${tc}`, { job: 'tags' });
}

function saveTags(args) {
  stepJob('save', `${args.items.length}개 항목`);
  const doc = tagDoc();
  if (!tagTarget || !doc) return { ok: false, error: '태그를 붙일 초안이 없습니다' };
  const out = {};
  const ignored = [];
  for (const { id, tags: suggested } of args.items) {
    const item = tagTarget.items.get(id);
    if (!item) { ignored.push(id); continue; }
    out[id] = tags.assign(doc, item, suggested);
  }
  // AI가 빠뜨린 항목도 자동 태그는 붙인다
  for (const [id, item] of tagTarget.items) if (!out[id]) out[id] = tags.assign(doc, item, []);
  send({ type: 'suite_tags', id: tagTarget.id, tags: out, tag_source: `${doc.id}@v${doc.version}`, tag_doc: doc });
  log('sys', `태그를 붙였습니다 · ${Object.keys(out).length}개 항목 · ${doc.id}@v${doc.version}`);
  return { ok: true, result: { tagged: Object.keys(out).length, ignored: ignored.length ? ignored : undefined } };
}

// ── 테스트 추가: 기존 묶음은 그대로 두고 새 시나리오·케이스와 그 코드만 덧붙인다 ──
const ADD_PROMPT = `[테스트 추가] 사용자가 기존 테스트 묶음에 시나리오나 누락된 테스트를 추가하려 한다.
- 먼저 브라우저에서 실제로 수행해 확인하고, 확인한 사실은 expect_* 로 검증한다. 수행하지 않은 것은 넣지 않는다.
- 기존 항목은 고치거나 다시 쓰지 않는다. 이미 있는 것과 겹치면 넣지 않고 어느 항목과 겹치는지 알려 준다.
- 새 시나리오 id는 기존 시나리오 번호 다음, 새 케이스 id는 속한 시나리오의 기존 케이스 번호 다음으로 매긴다. 기존 시나리오에 케이스만 더해도 된다.
- 데이터를 만들면 [koa] 이름 규칙을 지킨다.
- 끝나면 add_tests 로 새 항목만 저장하고, 무엇을 추가했는지 한국어로 짧게 요약한다.`;
let addTarget = null; // { id, ids: Set(기존 id) }

function addTests(request, s) {
  if (!request?.trim()) return;
  addTarget = { id: s.id, ids: new Set([...s.scenarios, ...s.cases].map((c) => c.id)) };
  const t = tags.prompt(tagDoc());
  const sc = s.scenarios.map((c) => `${c.id}${c.use === false ? ' (미채택)' : ''} ${c.title}`).join('\n');
  const tc = s.cases.map((c) => `${c.id} (${c.scenario}) ${c.title}`).join('\n');
  instruct(`${ADD_PROMPT}\n\n[사용자 요청]\n${request.trim()}\n\n[기존 묶음] ${s.name}\n범위: ${s.scope || '-'}\n[기존 시나리오]\n${sc}\n[기존 케이스]\n${tc}${t ? `\n\n[태그] 새 항목마다 '붙이는 경우'에 맞는 것만 tags에 고른다.\n${t}` : ''}`, { job: 'add' });
}

function saveAdded(args) {
  stepJob('save', `시나리오 ${args.scenarios.length} · 케이스 ${args.cases.length}`);
  if (!addTarget) return { ok: false, error: '테스트를 추가할 묶음이 정해지지 않았습니다. 사이드패널의 테스트 추가로 요청하세요' };
  const clash = [...args.scenarios, ...args.cases].map((c) => c.id).filter((id) => addTarget.ids.has(id));
  if (clash.length) return { ok: false, error: `이미 있는 id입니다: ${clash.join(', ')}. 기존 번호 다음으로 다시 매긴다` };
  if (!args.scenarios.length && !args.cases.length) return { ok: false, error: '추가할 항목이 없습니다' };
  const doc = tagDoc();
  const tagged = (c) => { const { tags: suggested = [], ...rest } = c; return { ...rest, tags: tags.assign(doc, rest, suggested), added: true, use: true }; };
  const add = { scenarios: args.scenarios.map((c) => tagged(withRole(c))), cases: args.cases.map(tagged), flow: args.flow || [] };
  // 초안 사본에도 덧붙여 둔다(패널 저장소가 비었을 때 복원용)
  const f = path.join(draftsDir(), `${addTarget.id}.json`);
  if (fs.existsSync(f)) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d.scenarios.push(...add.scenarios); d.cases.push(...add.cases); d.flow = [...(d.flow || []), ...add.flow];
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
  }
  for (const c of [...add.scenarios, ...add.cases]) addTarget.ids.add(c.id);
  send({ type: 'suite_add', id: addTarget.id, ...add });
  log('sys', `테스트 추가 · 시나리오 ${add.scenarios.length}개 · 케이스 ${add.cases.length}개 — 테스트 목록에서 고르고 반영하세요`);
  return { ok: true, result: { scenarios: add.scenarios.map((c) => c.id), cases: add.cases.map((c) => c.id) } };
}

// 새 테스트 코드만 덧붙이기: 기존 파일(appendBase) + AI가 쓴 조각. 다시 부르면 조각만 바뀐다
const APPEND_PROMPT = `[테스트 코드 추가] 아래 '새' 테스트만 Playwright 코드 조각으로 써서 append_code 로 저장한다. 기존 코드는 다시 쓰지 않는다.
- 조각은 기존 파일 끝에 붙는다. import 문은 쓰지 않고, 아래 기존 도우미 함수와 상수를 그대로 쓴다. 새 도우미가 필요하면 기존과 겹치지 않는 이름으로 조각 안에 둔다.
- 구조와 태그 규칙은 기존과 같다: test.describe('BDD', …) 안에 시나리오 테스트(Given/When/Then 을 test.step 으로), test.describe('TDD', …) 안에 test.describe('<시나리오 id> …', { tag: 물려줄 태그 }) 와 케이스 테스트. 기존 시나리오에 케이스만 더할 때도 TDD 안에 그 시나리오 describe 를 다시 열어 쓴다.
- 주소는 상대 경로, [koa] 데이터는 RUN 을 붙이고 정리한다.
- 계정은 시나리오의 역할로 로그인한다. 기존 파일에 역할별 로그인(ACCOUNTS·login(page, 역할))이 있으면 그대로 쓰고, 없는 역할이 필요하면 조각 안에 process.env.<계정>_USER! 를 글자 그대로 적어 둔다.
- 저장하면 새 테스트만 실행된다. 실패하면 원인을 보고 조각 전체를 고쳐 다시 저장한다. 검증을 빼서 통과시키지 않는다.`;
let appendBase = null; // { file, code, ids: [새 id] }

function codeOutline(src) {
  const imports = src.split('\n').filter((l) => /^import /.test(l)).join('\n');
  const decls = [...src.matchAll(/^(?:export )?(?:async )?function (\w+\([^)]*\))|^const (\w+)\s*=/gm)].map((m) => m[1] || m[2]).join(', ');
  const firstBdd = src.slice(src.indexOf("test.describe('BDD'"), src.indexOf("test.describe('BDD'") + 1800);
  return `[기존 import]\n${imports}\n[기존 도우미·상수] ${decls}\n[기존 BDD 테스트 앞부분(형식 참고)]\n${firstBdd}`;
}

// 채택한 테스트 → Playwright 코드. AI가 쓰고(save_code) 호스트가 로컬에서 바로 돌려 결과를 돌려준다.
// 서버는 이 코드를 받아 환경변수(주소·계정)만 자기 환경에 맞게 넣고 그대로 돌린다
const CODE_PROMPT = `[코드 작성] 아래 '채택된' 테스트를 Playwright 테스트 코드 한 파일로 작성해 save_code로 저장한다. 저장하면 호스트가 바로 로컬에서 실행해 테스트별 결과를 돌려준다.
- 두 묶음으로 쓴다. 채택되지 않은 것은 쓰지 않는다.
  · test.describe('BDD', …): 채택된 시나리오마다 test('<시나리오 id> <제목>') 하나. Given/When/Then 한 줄마다 await test.step('Given …' / 'When …' / 'And …' / 'Then …', async () => { … }) 로 쓰고, 단계 제목은 시나리오 문장을 그대로 쓴다. 사용자 흐름을 처음부터 끝까지 한 번에 따라간다.
  · test.describe('TDD', …): 시나리오마다 test.describe('<시나리오 id> <제목>') 안에 케이스마다 test('<케이스 id> <제목>'). 입력값·기대 결과를 하나씩 검증한다.
  · 테스트 제목은 반드시 시나리오 id 또는 케이스 id로 시작한다. 로그인·화면 이동 같은 공통 동작은 함수로 묶어 두 묶음이 함께 쓴다.
- 태그: 아래 목록에 적힌 태그를 그대로 쓴다(더하거나 빼지 않는다).
  · BDD: test('<시나리오 id> …', { tag: [시나리오 태그] }, …)
  · TDD: test.describe('<시나리오 id> …', { tag: [물려줄 태그] }, …) 안에 test('<케이스 id> …', { tag: [케이스 태그], annotation: [{ type: 'issue', description: '<이슈>' }] }, …). annotation은 이슈가 있을 때만.
- 실행 환경에 묶지 않는다: page.goto('/login')처럼 상대 경로만 쓴다(주소는 KOALA_BASE_URL). 계정은 환경변수 이름으로만 쓰고 값을 코드에 적지 않는다.
- 계정은 역할별이다. 시나리오마다 '역할'(로그인할 계정)이 적혀 있다. 케이스는 속한 시나리오의 역할을 따른다.
  · 파일 위쪽에 쓰는 역할만 모아 const ACCOUNTS = { ADMIN: { user: process.env.KOALA_ADMIN_USER!, pass: process.env.KOALA_ADMIN_PASS! }, … } 처럼 둔다(환경변수 이름을 글자 그대로 적어야 서버가 필요한 값을 안다).
  · 로그인 함수는 역할을 받는다: login(page, 'ADMIN'). 테스트마다 자기 역할로 로그인한다.
  · '역할별 기대'가 적힌 시나리오는 역할마다 테스트를 따로 만든다. 표를 상수로 두고 for (const [role, expect] of …) 로 돌며
    test(\`<시나리오 id> [\${role}] <제목>\`, { tag: [<역할 태그 말고 나머지 태그>, \`@role-\${role.toLowerCase()}\`] }, …). 허용이면 흐름을, 거부·일부면 막히는 방식(메뉴 없음, 돌려보냄, 버튼 비활성, 403)을 검증한다.
    그 시나리오의 TDD 케이스도 기대가 역할마다 다르면 같은 방식으로 역할마다 만든다(제목 '<케이스 id> [<역할>] …', 역할 태그도 그 역할 하나만).
- 테스트마다 혼자 돌 수 있게 로그인부터 한다(공통 로그인은 함수나 beforeEach로).
- 로케이터는 이 대화에서 실제로 조작·확인한 것(testid 우선)을 쓴다. 아래 녹화 기반 참고 코드의 로케이터를 그대로 가져와도 된다. 모르면 브라우저 도구로 화면을 다시 확인한다.
- [koa] 데이터는 실행 ID를 붙여(const RUN = Date.now().toString(36)) 겹치지 않게 하고, afterEach에서 정리 도우미로 정리한다.
- 오류 주입은 page.route(fulfill status / abort), 응답 지연은 route 안에서 기다린 뒤 continue, 탭 순서는 keyboard.press('Tab') 뒤 toBeFocused로 검증한다.
- 자동화할 수 없는 케이스(실제 동시 로그인, 다른 권한 계정 필요 등)는 test.fixme로 두고 이유를 주석으로 적는다.
- 실행 결과에 실패가 있으면 원인을 보고 고쳐 다시 save_code 한다. 테스트를 통과시키려고 검증을 빼지 않는다. 앱 결함으로 보이면 그대로 두고 보고한다. 같은 실패가 세 번 이어지면 멈춘다.
- 끝나면 통과/실패/보류를 한국어로 짧게 요약한다.`;
// 시나리오의 역할 → 코드가 로그인할 계정(환경변수 이름)
function roleLine(c) {
  const role = c.as || defaultRole();
  if (!role) return '';
  const a = accountFor(role);
  const acc = (k) => { const x = accountFor(k); return x ? `process.env.${x.key}_USER / ${x.key}_PASS` : '(계정 없음)'; };
  if (c.roles) return `\n  역할별 기대(역할마다 테스트):\n${Object.entries(c.roles).map(([k, v]) => `    - ${k} ${roleName(k)}: ${v} · 계정 ${acc(k)}`).join('\n')}`;
  return `\n  역할: ${role} ${roleName(role)}${c.as ? '' : ' (기본 역할)'} · 계정 ${acc(role)}`;
}
let codeTarget = null; // 코드를 만드는 테스트 묶음 id
let codeExpect = [];   // 코드에 들어가야 하는 시나리오·케이스 id
let codeTags = new Map(); // id → 실행 결과에 나와야 하는 태그(물려받은 것 포함)

function writeCode(s) {
  if (s?.append?.length) return writeAppend(s);
  if (!s?.cases?.length) { log('err', '채택된 TDD 케이스가 없습니다'); return; }
  setCodeExpect(s);
  const doc = tagDoc();
  const scById = new Map(s.scenarios.map((c) => [c.id, c]));
  const inh = (c) => tags.inherited(doc, scById.get(c.scenario));
  const tagLine = (xs, issue) => `${xs?.length ? `\n  태그: ${xs.join(' ')}` : ''}${issue ? `\n  이슈: ${issue}` : ''}`;
  const helpers = fs.existsSync(`${dir}tests/support`) ? fs.readdirSync(`${dir}tests/support`).filter((f) => f.endsWith('.ts')).map((f) => {
    const src = fs.readFileSync(`${dir}tests/support/${f}`, 'utf8');
    const ex = [...src.matchAll(/^export (?:async )?function (\w+\([^)]*\))/gm)].map((m) => m[1]).join(', ');
    return `- import { … } from '@support/${f.replace(/\.ts$/, '')}' : ${ex}`;
  }).join('\n') : '';
  const sc = s.scenarios.map((c) => `${c.id} ${c.title}${roleLine(c)}\n  Given ${c.given.join(' / ')}\n  When ${c.when.join(' / ')}\n  Then ${c.then.join(' / ')}${c.cleanup ? `\n  정리: ${c.cleanup}` : ''}${tagLine(c.tags, c.issue)}${
    tags.inherited(doc, c).length ? `\n  TDD describe에 물려줄 태그: ${tags.inherited(doc, c).join(' ')}` : ''}`).join('\n');
  const tc = s.cases.map((c) => `${c.id} (${c.scenario}, ${c.technique}) ${c.title}\n  입력: ${c.input}\n  기대: ${c.expected}\n  검증: ${c.check}${tagLine((c.tags || []).filter((t) => !inh(c).includes(t)), c.issue)}`).join('\n');
  instruct(`${CODE_PROMPT}\n\n파일 위치: ${codeFile(s.id)} (정리 도우미는 '@support/…' 로 불러온다)\n[정리 도우미]\n${helpers || '(없음)'}\n\n[채택된 BDD 시나리오]\n${sc}\n\n[채택된 TDD 케이스]\n${tc}\n\n[녹화 기반 참고 코드]\n${String(s.spec || '').slice(0, 15000)}`, { job: 'code' });
}

// 코드에 들어가야 하는 id와 각 테스트가 가져야 하는 태그(케이스는 시나리오에서 물려받은 것 포함)
function setCodeExpect(s) {
  const doc = tagDoc();
  const scById = new Map(s.scenarios.map((c) => [c.id, c]));
  codeTarget = s.id;
  codeExpect = [...s.scenarios.map((c) => c.id), ...s.cases.map((c) => c.id)];
  codeTags = new Map([...s.scenarios.map((c) => [c.id, c.tags || []]),
    ...s.cases.map((c) => [c.id, [...new Set([...tags.inherited(doc, scById.get(c.scenario)), ...(c.tags || [])])]])]);
}

// 태그·이슈만 바뀌었을 때: AI 없이 코드의 { tag, annotation } 부분만 바꿔 끼운다.
//   BDD test('<시나리오 id> …')  → 시나리오 태그
//   TDD test.describe('<시나리오 id> …') → 물려주는 태그, test('<케이스 id> …') → 케이스 자기 태그 + 이슈
// 옵션 객체에 tag·annotation 말고 다른 것이 있으면 손대지 않고 실패로 돌려준다(그때는 AI가 다시 쓴다)
function retagSource(src, s) {
  const doc = tagDoc();
  const scById = new Map(s.scenarios.map((c) => [c.id, c]));
  const q = (xs) => `[${xs.map((t) => `'${t}'`).join(', ')}]`;
  const opts = (xs, issue) => `{ tag: ${q(xs)}${issue ? `, annotation: [{ type: 'issue', description: ${JSON.stringify(issue)} }]` : ''} }`;
  const want = (id, isDescribe) => {
    const sc = scById.get(id);
    if (sc) return isDescribe ? { tags: tags.inherited(doc, sc) } : { tags: sc.tags || [], issue: sc.issue };
    const c = s.cases.find((x) => x.id === id);
    if (!c) return null;
    const inh = tags.inherited(doc, scById.get(c.scenario));
    return { tags: (c.tags || []).filter((t) => !inh.includes(t)), issue: c.issue };
  };
  const re = /test(\.describe)?\(\s*(['"`])((?:SC|TC)-[\w-]+)[^'"`]*\2\s*,\s*/g;
  let out = '', last = 0, m, changed = 0;
  while ((m = re.exec(src))) {
    const w = want(m[3], !!m[1]);
    if (!w) continue;
    let i = re.lastIndex, end = i;
    if (src[i] === '{') {
      // 옵션 객체 끝을 찾는다(문자열 안의 괄호는 건너뜀)
      let depth = 0, str = null;
      for (end = i; end < src.length; end++) {
        const ch = src[end];
        if (str) { if (ch === '\\') end++; else if (ch === str) str = null; continue; }
        if (ch === "'" || ch === '"' || ch === '`') str = ch;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) { end++; break; }
      }
      const body = src.slice(i, end);
      if (/^\{\s*(?:(?:tag|annotation)\s*:)/.test(body) === false && !/^\{\s*\}$/.test(body)) return { error: `${m[3]}: 옵션에 tag·annotation 말고 다른 값이 있음` };
      if (/\b(?!tag\b|annotation\b|type\b|description\b)[a-zA-Z_]+\s*:/.test(body.replace(/(['"`]).*?\1/g, ''))) return { error: `${m[3]}: 옵션에 tag·annotation 말고 다른 값이 있음` };
      while (/[\s,]/.test(src[end] || '')) end++;
    } else if (/^async\b|^\(/.test(src.slice(i))) end = i; // 옵션 없이 바로 함수
    else return { error: `${m[3]}: 코드 형태를 알 수 없음` };
    const next = w.tags.length || w.issue ? `${opts(w.tags, w.issue)}, ` : '';
    out += src.slice(last, i) + next;
    last = end;
    changed++;
  }
  return { code: out + src.slice(last), changed };
}

function writeAppend(s) {
  const file = codeFile(s.id);
  if (!fs.existsSync(`${file}`)) { log('err', '기존 테스트 코드 파일이 없습니다. 코드를 생성하세요'); return; }
  setCodeExpect(s);
  const code = fs.readFileSync(`${file}`, 'utf8');
  appendBase = { file, code, ids: s.append };
  const doc = tagDoc();
  const scById = new Map(s.scenarios.map((c) => [c.id, c]));
  const fresh = new Set(s.append);
  const sc = s.scenarios.filter((c) => fresh.has(c.id)).map((c) => `${c.id} ${c.title}${roleLine(c)}\n  Given ${c.given.join(' / ')}\n  When ${c.when.join(' / ')}\n  Then ${c.then.join(' / ')}${c.cleanup ? `\n  정리: ${c.cleanup}` : ''}\n  태그: ${(c.tags || []).join(' ') || '(없음)'}${c.issue ? `\n  이슈: ${c.issue}` : ''}`).join('\n');
  const tc = s.cases.filter((c) => fresh.has(c.id)).map((c) => {
    const inh = tags.inherited(doc, scById.get(c.scenario));
    return `${c.id} (${c.scenario} — ${scById.get(c.scenario)?.title || ''}, ${c.technique}) ${c.title}\n  입력: ${c.input}\n  기대: ${c.expected}\n  검증: ${c.check}\n  TDD describe 물려줄 태그: ${inh.join(' ') || '(없음)'}\n  케이스 태그: ${(c.tags || []).filter((t) => !inh.includes(t)).join(' ') || '(없음)'}${c.issue ? `\n  이슈: ${c.issue}` : ''}`;
  }).join('\n');
  instruct(`${APPEND_PROMPT}\n\n${codeOutline(code)}\n\n[새 BDD 시나리오]\n${sc || '(없음)'}\n\n[새 TDD 케이스]\n${tc || '(없음)'}`, { job: 'append' });
}

async function appendCode(args) {
  if (!appendBase) return { ok: false, error: '덧붙일 기존 코드가 정해지지 않았습니다. 사이드패널에서 새 테스트 코드 추가를 누르세요' };
  const { file, code: base, ids } = appendBase;
  const code = `${base.trimEnd()}\n\n// ── 테스트 추가 ${new Date().toISOString().slice(0, 10)}: ${ids.join(', ')} ──\n${args.code.trim()}\n`;
  fs.writeFileSync(`${file}`, code);
  stepJob('check', '빠진 테스트·태그·중복 확인');
  const pre = await runSpec(file, null, { list: true });
  if (pre.error && !pre.results.length) { fs.writeFileSync(`${file}`, base); stepJob('review', '코드에 문법 오류 · AI가 고치는 중'); return { ok: true, result: { compile_error: pre.error, note: '기존 파일은 되돌렸다. 조각을 고쳐 다시 저장한다' } }; }
  const chk = checkCode(pre.results);
  // 기존 테스트가 사라지거나 둘로 늘었는지도 본다(같은 id가 두 번이면 덧붙인 조각이 기존 것을 다시 쓴 것)
  const dup = codeExpect.filter((id) => pre.results.filter((r) => r.title.startsWith(`${id} `)).length > 1);
  if (chk.missing.length || chk.tagMismatch.length || dup.length) {
    fs.writeFileSync(`${file}`, base);
    log('err', `새 테스트 코드 검사: 빠진 ${chk.missing.length} · 태그 불일치 ${chk.tagMismatch.length} · 중복 ${dup.length} — 기존 파일로 되돌리고 AI에게 돌려줍니다`);
    stepJob('review', '검사에서 걸림 · AI가 고치는 중');
    return { ok: true, result: { not_run: '검사에서 걸려 실행하지 않았고 기존 파일로 되돌렸다', missing: chk.missing.length ? chk.missing : undefined, tag_mismatch: chk.tagMismatch.length ? chk.tagMismatch : undefined, duplicated: dup.length ? dup : undefined } };
  }
  send({ type: 'suite_listed', id: codeTarget, tests: listed(pre.results) });
  // 새 테스트만 실행한다
  const grep = `(${ids.join('|')}) `; // id는 영문·숫자·하이픈뿐이다
  return runAndReport(codeTarget, file, code, { grep, merge: true });
}

// Playwright JSON 결과 → [{ title, status, error, ms }]
function flatResults(report) {
  const out = [];
  const walk = (suite, prefix) => {
    for (const sp of suite.specs || []) {
      const t = sp.tests?.[0];
      const r = t?.results?.at(-1);
      const status = t?.status === 'skipped' || r?.status === 'skipped' ? 'skipped' : r?.status === 'passed' ? 'passed' : r ? 'failed' : 'skipped';
      // BDD 시나리오는 Given/When/Then 단계별 결과도 남긴다
      const gwt = (r?.steps || []).filter((x) => /^(Given|When|Then|And|But)\b/.test(x.title))
        .map((x) => ({ title: x.title, status: x.error ? 'failed' : 'passed', ms: x.duration }));
      // Playwright JSON은 태그를 '@' 없이 낸다
      out.push({ title: sp.title, tags: (sp.tags || []).map((x) => (x.startsWith('@') ? x : `@${x}`)), group: prefix, kind: /^SC-/.test(sp.title) ? 'bdd' : 'tdd', steps: gwt.length ? gwt : undefined, status, ms: r?.duration ?? 0,
        error: r?.error?.message ? r.error.message.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 800) : undefined });
    }
    for (const c of suite.suites || []) walk(c, c.title && !c.title.endsWith('.ts') ? c.title : prefix);
  };
  for (const s of report.suites || []) walk(s, '');
  return out;
}

// 로컬 실행은 기본으로 브라우저 창을 띄워 사용자가 직접 볼 수 있게 한다(KOALA_HEADED=0 이면 숨김)
const HEADED = process.env.KOALA_HEADED !== '0';
function runSpec(file, onProgress, { list = false, grep = null } = {}) {
  const outFile = path.join(os.tmpdir(), `koa-pw-${Date.now()}.json`);
  const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: outFile, KOALA_BASE_URL: profile?.target?.base_url || process.env.KOALA_BASE_URL || '' };
  for (const a of profile?.accounts || []) { env[`${a.key}_USER`] = secretValue(`${a.key}_USER`); env[`${a.key}_PASS`] = secretValue(`${a.key}_PASS`); }
  // 역할이 생기기 전 코드(process.env.KOALA_USER)는 기본 역할 계정으로 돈다
  if (!env.KOALA_USER) { env.KOALA_USER = secretValue('KOALA_USER'); env.KOALA_PASS = secretValue('KOALA_PASS'); }
  return new Promise((resolve) => {
    const p = spawn(WIN ? 'npx.cmd' : 'npx', ['playwright', 'test', file, '--project=suites', '--workers=1', ...(grep ? ['--grep', grep] : []), ...(list ? ['--list', '--reporter=json'] : ['--reporter=json,./pw-progress-reporter.cjs', ...(HEADED ? ['--headed'] : [])])], { cwd: dir, env, shell: WIN });
    let err = '';
    let buf = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.startsWith('KOA ')) { try { onProgress?.(JSON.parse(l.slice(4))); } catch {} }
    });
    p.isTestRun = true;
    children.add(p);
    const timer = setTimeout(() => p.kill(), 15 * 60 * 1000);
    p.on('close', () => {
      children.delete(p);
      clearTimeout(timer);
      try { resolve({ results: flatResults(JSON.parse(fs.readFileSync(outFile, 'utf8'))) }); }
      catch { resolve({ results: [], error: err.slice(-1500) || '실행 결과를 읽지 못했습니다' }); }
      fs.rmSync(outFile, { force: true });
    });
  });
}

// 채택했는데 코드에 없는 id, 코드의 태그가 테스트 목록과 다른 테스트(결과의 태그는 describe에서 물려받은 것까지 포함)
function checkCode(results) {
  const missing = codeExpect.filter((id) => !results.some((r) => r.title.startsWith(`${id} `) || r.title === id));
  const tagMismatch = [];
  for (const r of results) {
    const id = r.title.split(' ')[0];
    if (!codeTags.has(id)) continue;
    // 역할별로 나눈 테스트는 역할 태그를 하나씩만 가진다: 역할 태그는 '목록 안의 것, 하나 이상'이면 맞다
    const isRole = (t) => t.startsWith('@role-');
    const wantAll = [...codeTags.get(id)], gotAll = [...new Set(r.tags)];
    const want = wantAll.filter((t) => !isRole(t)).sort().join(' ');
    const got = gotAll.filter((t) => !isRole(t)).sort().join(' ');
    const wantR = wantAll.filter(isRole), gotR = gotAll.filter(isRole);
    const roleOk = wantR.length ? gotR.length > 0 && gotR.every((t) => wantR.includes(t)) && (wantR.length > 1 || gotR.length === 1) : !gotR.length;
    if (want !== got || !roleOk) tagMismatch.push({ id, want: wantAll.sort().join(' ') || '(없음)', got: gotAll.sort().join(' ') || '(없음)' });
  }
  return { missing, tagMismatch };
}

// 코드에 작성된 테스트 목록(실행하지 않고 --list로 몇 초). 사이드패널이 "작성됨/미실행"을 보여 줄 때 쓴다
const listed = (results) => results.map(({ title, tags: tg, kind }) => ({ title, tags: tg, kind }));
async function listCode(id) {
  const file = codeFile(id);
  if (!fs.existsSync(`${file}`)) { send({ type: 'suite_listed', id, tests: [], error: '코드 파일이 없습니다' }); return; }
  const pre = await runSpec(file, null, { list: true });
  send({ type: 'suite_listed', id, tests: listed(pre.results), error: pre.error && !pre.results.length ? pre.error : undefined });
}

// 태그만 바꿔 끼우고 목록 검사만 한다(실행하지 않음). 지난 실행 결과는 사이드패널이 그대로 쓴다
async function retagCode(s) {
  const file = codeFile(s.id);
  if (!fs.existsSync(`${file}`)) { send({ type: 'suite_retag', id: s.id, ok: false, error: '코드 파일이 없습니다. 코드를 다시 생성하세요' }); return; }
  const r = retagSource(fs.readFileSync(`${file}`, 'utf8'), s);
  if (r.error) { send({ type: 'suite_retag', id: s.id, ok: false, error: r.error }); log('err', `태그만 반영하지 못했습니다: ${r.error}`); return; }
  setCodeExpect(s);
  fs.writeFileSync(`${file}`, r.code);
  const t = Date.now();
  const pre = await runSpec(file, null, { list: true });
  const chk = checkCode(pre.results);
  const ok = !pre.error && !chk.missing.length && !chk.tagMismatch.length;
  send({ type: 'suite_retag', id: s.id, ok, code: r.code, results: pre.results.map(({ title, tags: tg }) => ({ title, tags: tg })), missing: chk.missing, tag_mismatch: chk.tagMismatch, error: pre.error && !pre.results.length ? pre.error : undefined });
  log(ok ? 'sys' : 'err', `태그만 코드에 반영 · ${r.changed}곳 · 목록 검사 ${ok ? '통과' : `실패(빠진 테스트 ${chk.missing.length}, 태그 불일치 ${chk.tagMismatch.length})`} (${((Date.now() - t) / 1000).toFixed(1)}초, 테스트는 실행하지 않음)`);
}

async function saveCode(args) {
  // 코드 생성 지시 없이 온 저장(예: 이전 호스트에서 남은 요청)은 받지 않는다
  if (!codeTarget) return { ok: false, error: '코드를 만들 테스트 묶음이 정해지지 않았습니다. 사이드패널에서 코드 생성을 다시 누르세요' };
  const id = codeTarget;
  const file = codeFile(id);
  fs.mkdirSync(path.dirname(`${file}`), { recursive: true });
  fs.writeFileSync(`${file}`, args.code);
  // 실행 환경이 채워야 할 값: 코드가 읽는 환경변수
  const env = [...new Set(['KOALA_BASE_URL', ...[...args.code.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1])])];
  // 실행 전에 목록만 뽑아(몇 초) 빠진 id·태그 불일치를 먼저 본다. 있으면 실행하지 않고 바로 고치게 한다
  stepJob('check', '빠진 테스트·태그 확인');
  const pre = await runSpec(file, null, { list: true });
  if (pre.error && !pre.results.length) return { ok: true, result: { file, compile_error: pre.error } };
  const preCheck = checkCode(pre.results);
  send({ type: 'suite_listed', id, tests: listed(pre.results) });
  if (preCheck.missing.length || preCheck.tagMismatch.length) {
    log('err', `실행 전 검사: 빠진 테스트 ${preCheck.missing.length}개 · 태그 불일치 ${preCheck.tagMismatch.length}개 — 실행하지 않고 AI에게 돌려줍니다`);
    stepJob('review', `검사에서 걸림(빠진 ${preCheck.missing.length} · 태그 ${preCheck.tagMismatch.length}) · AI가 고치는 중`);
    return { ok: true, result: { file, not_run: '실행 전 검사에서 걸려 실행하지 않았다. 고쳐서 다시 저장한다', missing: preCheck.missing.length ? preCheck.missing : undefined, tag_mismatch: preCheck.tagMismatch.length ? preCheck.tagMismatch : undefined } };
  }
  return runAndReport(id, file, args.code);
}

// 코드는 그대로 두고 테스트만 실행한다(사이드패널 "테스트 실행"). AI를 거치지 않는다
let codeRunning = false;
async function runCode(s, ids = [], only = false) {
  const file = codeFile(s.id);
  if (!fs.existsSync(`${file}`)) { log('err', '테스트 코드 파일이 없습니다. 코드를 생성하세요'); return; }
  if (codeRunning) { log('err', '이미 테스트를 실행하고 있습니다'); return; }
  setCodeExpect(s);
  stopRequested = false;
  startJob('localrun');
  // 고른 테스트(또는 실행 결과가 없는 테스트)만 돌리고 지난 결과에 합친다. id는 영문·숫자·하이픈뿐이다
  ids = ids.filter((x) => /^[\w-]+$/.test(x));
  if (only && !ids.length) { log('err', '실행할 테스트를 고르세요'); return; }
  if (only) log('sys', `고른 테스트 ${ids.length}개만 실행합니다: ${ids.join(', ')}`);
  const opt = ids.length ? { grep: `(${ids.join('|')}) `, merge: true } : {};
  await runAndReport(s.id, file, fs.readFileSync(`${file}`, 'utf8'), opt);
}

// 실행하고 결과를 사이드패널(진행·결과)과 AI(도구 결과)에 알린다
async function runAndReport(id, file, code, { grep = null, merge = false } = {}) {
  const env = [...new Set(['KOALA_BASE_URL', ...[...code.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1])])];
  codeRunning = true;
  log('sys', `테스트를 로컬에서 실행합니다 · ${file}`);
  stepJob('run', '브라우저를 여는 중');
  send({ type: 'suite_code', id, code, file, env, running: true, merge });
  const t = Date.now();
  // 테스트가 끝날 때마다 사이드패널·타임라인에 바로 보여 준다
  let total = 0, n = 0;
  const run = await runSpec(file, (ev) => {
    if (ev.ev === 'begin') { total = ev.total; detailJob(`0/${total}`); }
    if (ev.ev === 'test') detailJob(`${n}/${total} · ${ev.title.split(' ')[0]} 실행 중`);
    if (ev.ev === 'done') {
      n += 1;
      log(ev.status === 'passed' ? 'sys' : ev.status === 'skipped' ? 'sys' : 'err', `[${n}/${total}] ${ev.status === 'passed' ? '통과' : ev.status === 'skipped' ? '보류' : '실패'} · ${ev.title} (${(ev.ms / 1000).toFixed(1)}초)`);
    }
    send({ type: 'suite_code_progress', id, total, n, ...ev });
  }, { grep });
  const count = (st) => run.results.filter((r) => r.status === st).length;
  const summary = { passed: count('passed'), failed: count('failed'), skipped: count('skipped'), ms: Date.now() - t };
  audit('test_run', { suite: id, file, only: grep || undefined, summary, error: run.error?.slice(0, 500),
    results: run.results.map(({ title, status, ms, error }) => ({ title, status, ms, error: error?.slice(0, 300) })) });
  log(summary.failed || run.error ? 'err' : 'sys', `로컬 실행: 통과 ${summary.passed} · 실패 ${summary.failed} · 보류 ${summary.skipped} (${Math.round(summary.ms / 1000)}초)${run.error ? ` · ${run.error.slice(0, 200)}` : ''}`);
  // 일부만 실행했으면 빠진 id 검사는 하지 않는다(목록 검사에서 이미 봄)
  const { missing: miss0, tagMismatch } = checkCode(run.results);
  const missing = grep ? [] : miss0;
  if (tagMismatch.length) log('err', `태그가 목록과 다른 테스트 ${tagMismatch.length}개: ${tagMismatch.map((x) => x.id).join(', ')}`);
  codeRunning = false;
  // AI가 시킨 실행이면 결과를 AI가 본다. 사이드패널에서 누른 실행이면 여기서 끝난다
  if (job?.kind === 'localrun') endJob(!summary.failed && !run.error, `통과 ${summary.passed} · 실패 ${summary.failed} · 보류 ${summary.skipped}`);
  else stepJob('review', `통과 ${summary.passed} · 실패 ${summary.failed} · AI가 결과를 확인하는 중`);
  send({ type: 'suite_code', id, code, file, env, results: run.results, summary, error: run.error, ran_at: new Date().toISOString(), tag_mismatch: tagMismatch, merge });
  return { ok: true, result: { file, ...summary, missing: missing.length ? missing : undefined, tag_mismatch: tagMismatch.length ? tagMismatch : undefined, error: run.error, failures: run.results.filter((r) => r.status === 'failed').map(({ title, error }) => ({ title, error })) } };
}

// 세션 비우기: 대화 맥락만 지운다(수행 기록·타임라인은 유지). 다음 지시는 새 kaa-N으로 시작
function clearSession() {
  const old = sessionAlias;
  stopClaude();
  sessionId = null;
  sessionAlias = null;
  saveState();
  sendSession();
  log('sys', `세션 ${old || ''}을 비웠습니다. 새 대화로 시작합니다(수행 기록은 유지)`);
  scheduleWarm(300);
}
// 압축: Claude Code의 /compact로 지금까지 대화를 요약해 토큰을 줄인다. 같은 kaa-N이 유지된다
function compactSession() {
  if (!sessionId && !proc) { log('err', '압축할 대화가 없습니다'); return; }
  log('sys', `세션 ${sessionAlias || ''} 압축을 시작합니다`);
  sendToClaude('/compact');
}

// 반영된 테스트 묶음을 서버(동기화 저장소)로 보낸다
// 서버 전송은 프로필의 배포 서버(deploy.url)로 보낸다. 없으면 보내지 않는다.
// 배포 서버는 임시 동기화 저장소와 같은 모양의 API를 쓴다: PUT <서버>/sync/suites/<id> { base_version, data } → 문서 | 409 { current }
// 주소가 이 호스트(127.0.0.1:8765)면 이 PC의 임시 저장소(.koa/store)에 바로 쓴다
const isThisHost = (u) => { try { return [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(new URL(u).host); } catch { return false; } };
async function putToServer(server, kind, id, baseVersion, data) {
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

async function publishSuite(suite, baseVersion) {
  const server = profile?.deploy?.url;
  if (!server) {
    send({ type: 'suite_published', ok: false, error: '프로필에 배포 서버가 없습니다. 프로필 → 배포 서버에 주소를 넣으세요' });
    return;
  }
  // 코드가 불러오는 정리 도우미도 함께 보낸다(서버가 그대로 돌릴 수 있게)
  if (suite.code?.source) {
    suite.code.support = {};
    for (const [, f] of suite.code.source.matchAll(/from '(?:(?:\.\.\/)+|@)support\/([\w-]+)'/g)) {
      const p = `${dir}tests/support/${f}.ts`;
      if (fs.existsSync(p)) suite.code.support[`support/${f}.ts`] = fs.readFileSync(p, 'utf8');
    }
  }
  const where = isThisHost(server) ? '이 PC의 임시 서버' : new URL(server).host;
  let r;
  try { r = await putToServer(server, 'suite', suite.id, baseVersion, suite); } catch (e) {
    send({ type: 'suite_published', ok: false, error: `배포 서버(${where})에 보내지 못했습니다: ${e.message}` });
    return;
  }
  if (r.conflict) {
    send({ type: 'suite_published', ok: false, error: `배포 서버(${where})에 더 새 버전(v${r.current.version ?? '?'})이 있습니다`, current: r.current });
    return;
  }
  send({ type: 'suite_published', ok: true, id: suite.id, version: r.doc.version, server: where });
  log('sys', `테스트 묶음 "${suite.name}" v${r.doc.version}을 배포 서버(${where})로 보냈습니다 · BDD ${suite.scenarios.length}개 · TDD ${suite.cases.length}개`);
}

// 이번 지시를 수행할 역할(사이드패널 역할 칩). 여럿이면 차례로 수행하며 역할마다 메뉴 권한을 직접 찾는다
function rolePrompt(keys) {
  const list = (keys || []).filter((k) => roleOf(k));
  if (!list.length) return '';
  const who = (k) => `${k} ${roleName(k)}($${accountFor(k)?.key}_USER)`;
  if (list.length === 1) {
    if (actor?.role === list[0]) return `\n\n[역할] 이번 지시는 ${who(list[0])}로 수행한다. 지금 이 역할로 로그인되어 있다.`;
    return `\n\n[역할] 이번 지시는 ${who(list[0])}로 수행한다.${actor ? ` 지금은 ${roleName(actor.role) || actor.key}로 로그인되어 있으니 clear_login 하고 이 역할 계정으로 다시 로그인한다.` : ''}`;
  }
  return `\n\n[역할 범위] 이번 지시는 역할 ${list.length}개로 차례로 수행한다: ${list.map((k, i) => `${i + 1}) ${who(k)}`).join(' ')}
- 역할마다: clear_login으로 로그인 상태를 지우고 → 그 역할 계정으로 로그인 → 수행. 역할을 시작할 때 "▶ ${roleName(list[0])} (1/${list.length})"처럼 한 줄 알린다.
- 첫 역할로 지시를 끝까지 수행한다. 다음 역할부터는 같은 흐름을 처음부터 되풀이하지 말고, 권한에 따라 달라질 수 있는 지점만 확인한다.
- 메뉴 권한은 서비스마다 설정 방식이 달라 미리 주어지지 않는다. 역할마다 직접 찾는다:
  · 로그인 직후 보이는 메뉴(접힌 메뉴 그룹은 펼쳐서)
  · 대상 화면에 메뉴로 갈 수 있는지, 주소로 직접 들어가면 어떻게 되는지(열림 / 다른 화면으로 돌려보냄 / 권한 없음 안내)
  · 화면 안 버튼·입력의 활성 여부, 데이터 요청의 401·403 같은 권한 응답
  확인한 것은 expect_*로 남긴다(보이지 않아야 하는 메뉴는 expect_count 0, 돌려보내면 expect_url).
- 끝나면 역할 × 확인 항목 표(허용 / 거부 / 일부)로 요약한다. 차이가 의도된 권한인지 결함인지 화면만으로 판단할 수 없으면 그렇게 적는다.`;
}

// 도메인이 달라 막힌 지시. 사용자가 "그래도 진행"을 누르면 그대로 다시 보낸다
let blocked = null;
async function instruct(text, { derive = false, job: kind = 'run', roles = null, force = false } = {}) {
  stopRequested = false;
  blocked = null;
  startJob(kind);
  // Claude Code가 없거나 로그인이 안 됐으면 실행하지 않고 다시 확인해 알린다
  if (!claudeEnv.ok && !checkClaude().ok) {
    send({ type: 'env', claude: claudeEnv });
    log('err', 'Claude Code를 쓸 수 없어 실행하지 못했습니다. 사이드패널 상단 안내를 확인하세요.');
    endJob(false, 'Claude Code를 쓸 수 없습니다');
    return;
  }
  // 새 수행 기록이면 프로필의 시작 URL에서 출발한다(생성 코드도 거기서 시작한다)
  const startUrl = profile?.target?.start_url;
  if (steps.length === 0 && startUrl) {
    if (domain !== 'default' && hostOf(startUrl) !== domain) log('err', `시작 URL(${startUrl})이 프로필 도메인(${domain})과 달라 쓰지 않습니다`);
    else { log('sys', `시작 URL로 이동합니다: ${startUrl}`); await relay('goto', { url: startUrl }); }
  }
  const start = await relay('snapshot', {});
  // 대상 탭이 프로필 도메인이 아니면 멈추고 묻는다(다른 사이트를 조작하거나 다른 도메인의 기록에 섞이지 않게).
  // 사용자가 승인하면(force) 그대로 진행한다. 기록은 프로필 도메인 쪽에 남는다
  const tabHost = start.ok ? hostOf(start.result.url) : '';
  if (tabHost && domain !== 'default' && tabHost !== domain) {
    if (force) log('err', `대상 탭(${tabHost})이 프로필 도메인(${domain})이 아니지만 승인해서 진행합니다 · 기록은 ${domain}에 남습니다`);
    else {
      const go = startUrl && hostOf(startUrl) === domain ? startUrl : profile?.target?.base_url;
      blocked = { text, opts: { derive, job: kind, roles } };
      log('err', `대상 탭(${tabHost})이 프로필 도메인(${domain})이 아니라 멈췄습니다 · 이동하거나 그래도 진행을 고르세요`);
      send({ type: 'domain_mismatch', expected: domain, actual: tabHost, go, can_force: true });
      endJob(false, '대상 탭이 프로필 도메인이 아닙니다');
      send({ type: 'busy', busy: false });
      return;
    }
  }
  if (start.ok) {
    curScreen = await enterScreen(start.result.url);
    segment = [];
    if (steps.length === 0) {
      // 시나리오 시작 화면을 첫 단계로 남겨야 재실행 코드가 같은 곳에서 출발한다
      steps.push({ action: 'goto', url: start.result.url }); saveRec();
    }
  }
  if (derive) return sendToClaude(text);
  intent = text.slice(0, 120);
  text += profileContext();
  // 대화를 새로 열지 않게 지식 묶음(stamp)과 따로 붙인다
  if (actor) text += `\n지금 브라우저에 로그인한 역할(koa가 마지막으로 로그인한 계정): ${actor.role || '-'} ${roleName(actor.role)} · $${actor.key}_USER`;
  text += rolePrompt(roles);
  let known = [];
  try { known = curScreen ? await graph.knownPathsFrom(curScreen) : []; } catch (e) { graphError(e); }
  // 경로 모드(탐색/재생)는 계획/작성 모드(mode)와 별개다
  const pathMode = known.length ? 'replay' : 'explore';
  if (mode === 'plan') {
    // 계획: 꼼꼼히 둘러봐야 하므로 보통 속도. 알려진 경로는 메뉴 이동 참고용으로만 준다(입력·검증 단계 제외)
    send({ type: 'mode', mode: pathMode, speed: 'normal' });
    const nav = known.map((path) => path.map((e) => ({ ...e, steps: e.steps.filter((x) => !['type', 'fill'].includes(x.tool) && !x.tool.startsWith('expect')) })));
    text = `${text}${known.length ? `\n\n[참고: 이미 지나간 화면 이동] 메뉴 이동 경로 참고용이다. 그대로 재생하지 말고 화면을 직접 확인하며 둘러본다:\n${describeKnown(nav)}` : ''}`;
  } else {
    send({ type: 'mode', mode: pathMode, speed: pathMode === 'replay' ? 'fast' : 'slow' });
    log('sys', pathMode === 'replay' ? `재생 모드 · 이 화면에서 알려진 경로 ${known.length}개` : '탐색 모드 · 처음 가는 경로라 천천히 확인하며 진행');
    text = pathMode === 'replay'
      ? `${text}\n\n[재생 모드] 현재 화면(${curScreen})에서 이미 지나간 경로가 있다:\n${describeKnown(known)}\n`
        + '목표에 맞는 경로가 있으면 snapshot 없이 해당 steps를 이어 붙여 run 한 번으로 보낸다(값은 이번 지시에 맞게 바꿔도 된다). '
        + '실패하면 돌아온 화면 정보로 판단해 그 지점부터 탐색한다.'
      : `${text}\n\n[탐색 모드] 처음 가는 경로다. 화면이 바뀔 때마다 snapshot으로 확인하고, 필요하면 screenshot으로 눈으로 확인하며 정확하게 진행한다. run은 한 화면 안의 조작 단위로 짧게 묶는다.`;
  }
  sendToClaude(text);
}

// 대화 준비: 지식·프로필·모드(stamp)가 바뀌었으면 새 대화로 하고, 상주 프로세스가 없으면 띄운다
function ensureClaude() {
  // 지식·프로필 버전이 바뀌면 작업 폴더가 다시 만들어진다. 이전 대화는 이어 갈 수 없으니 새 세션으로 시작한다
  const ws = workspace.prepare(profile);
  ws.stamp += `|${mode}`; // 모드가 바뀌면 도구와 지시가 달라지므로 새 대화로 시작한다
  if (lastStamp && lastStamp !== ws.stamp) {
    stopClaude();
    sessionId = null;
    sessionAlias = null;
    sendSession();
    log('sys', '지식·프로필 또는 모드가 바뀌어 새 대화로 시작합니다');
  }
  lastStamp = ws.stamp;
  saveState();
  if (!PERSIST || proc) return { ws, spawned: false };
  proc = spawnClaude(['-p', '--input-format', 'stream-json', ...(sessionId ? ['--resume', sessionId] : [])], ws);
  return { ws, spawned: true };
}
const writeClaude = (text) => proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);

// Claude에 지시를 보낸다(상주 세션이면 같은 대화로 이어서)
function sendToClaude(text) {
  timing = { t0: Date.now(), tool: 0 };
  send({ type: 'busy', busy: true });
  const { ws, spawned } = ensureClaude();
  log('sys', `지식 ${ws.versions.knowledge.join(' · ') || '없음'}`);
  if (PERSIST) {
    if (spawned && sessionId) log('sys', '이전 대화를 이어서 진행합니다');
    if (!spawned) timing.warm = true;
    if (spawned && claudeConn !== 'ready') sendConn('connecting');
    writeClaude(text);
  } else {
    spawnClaude(['-p', text, ...(sessionId ? ['--resume', sessionId] : [])], ws);
  }
}

// ── 미리 연결: 패널이 열려 프로필을 받으면 Claude를 띄워 두고, 대화(세션)가 없으면 새로 연다 ──
// 첫 지시에서야 기동·로그인·이어받기 문제를 만나지 않게 하고, 시스템 지시를 미리 읽혀 첫 응답을 빠르게 한다.
// 짧은 확인 응답을 한 번 받아 실제로 대화가 되는지까지 본다(대화창에는 보이지 않는다)
let claudeConn = 'off'; // off(아직 안 띄움) | connecting | ready | failed
let claudeConnDetail = '';
let warming = null;     // { proc, t0, resumed, timer }
let warmTimer = null;
let warmFails = 0;      // 연달아 실패한 횟수. 3번이면 자동 재시도를 멈추고 다음 지시 때 다시 띄운다
let profileSeen = false; // 호스트를 켠 뒤 패널에서 프로필을 받았는지(받기 전에 띄우면 엉뚱한 프로필로 대화를 새로 연다)
const WARM_TIMEOUT = 90000;
function sendConn(state, detail = '') {
  claudeConn = state; claudeConnDetail = detail;
  send({ type: 'claude_conn', state, detail });
}
function scheduleWarm(ms = 600) {
  if (!PERSIST) return;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(warmClaude, ms);
}
function warmClaude() {
  if (!profileSeen || !panel || warming || job || codeRunning) return;
  if (proc) { if (claudeConn !== 'ready') sendConn('ready'); return; }
  if (!claudeEnv.ok && !checkClaude().ok) {
    send({ type: 'env', claude: claudeEnv });
    return sendConn('failed', 'Claude Code를 쓸 수 없습니다');
  }
  try { ensureClaude(); } catch (e) {
    // 타이머 안의 예외는 호스트를 끝내 버린다. 연결 실패로 알리고 다음 지시 때 다시 시도한다
    stopClaude();
    log('err', `Claude를 띄우지 못했습니다: ${e.message}`);
    return sendConn('failed', e.message.slice(0, 120));
  }
  warming = { proc, t0: Date.now(), resumed: !!sessionId };
  warming.timer = setTimeout(() => warmFailed(`${WARM_TIMEOUT / 1000}초 동안 응답이 없습니다`), WARM_TIMEOUT);
  sendConn('connecting');
  console.log(`[claude] 미리 연결 · ${sessionId ? `대화 ${sessionId.slice(0, 8)} 이어받기` : '새 대화'}`);
  writeClaude('[연결 확인] koa 사이드패널이 열려 연결을 확인한다. 도구를 쓰지 말고 "준비됨" 한 단어로만 답한다.');
}
function warmDone() {
  const { t0, resumed, timer } = warming;
  clearTimeout(timer);
  warming = null; warmFails = 0;
  sendConn('ready');
  log('sys', `Claude 연결됨 · 세션 ${sessionAlias || ''} ${resumed ? '이어서 사용' : '새로 열었습니다'} (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
}
function warmFailed(reason) {
  if (!warming) return;
  const { resumed, proc: p } = warming;
  stopClaude(); // warming 도 비운다
  // 이어받을 대화를 찾지 못하면(만료·삭제) 새 세션으로 연다. 그 밖의 실패에는 대화를 지우지 않는다
  if (resumed && /no conversation found|session.*not found/i.test(p?.lastErr || '')) {
    sessionId = null; sessionAlias = null; saveState(); sendSession();
    log('sys', '이전 대화를 이어받을 수 없어 새 세션을 엽니다');
    return warmClaude();
  }
  retryWarm(reason);
}
// 실패하면 잠시 뒤 다시 띄운다(5초, 10초). 연달아 3번 실패하면 멈추고 다음 지시 때 다시 시도한다
function retryWarm(reason) {
  warmFails += 1;
  sendConn('failed', reason);
  const again = warmFails < 3;
  log('err', `Claude 연결이 끊겼습니다: ${reason}${again ? ' · 잠시 뒤 다시 연결합니다' : ' · 다음 지시 때 다시 연결합니다'}`);
  if (again) scheduleWarm(5000 * warmFails);
}

// ---------- 저장된 상태 불러오기 ----------
// 예전(도메인 구분 전) 데이터는 기록된 첫 주소의 도메인으로 옮긴다
function migrateLegacy() {
  if (fs.existsSync(path.join(DATA, 'domains'))) return;
  let st = null;
  try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return; }
  if (!st || !('sessionId' in st || 'steps' in st)) return;
  const first = (st.steps || []).find((x) => x.action === 'goto')?.url;
  const d = hostOf(first) || 'default';
  const b = bucket(d);
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'state.json'), JSON.stringify({ ...st, domain: d, aliasSeq: undefined }, null, 2));
  for (const name of ['recording.json', 'recordings', 'drafts']) {
    const from = path.join(dir, name);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(b, name));
  }
  fs.writeFileSync(STATE, JSON.stringify({ domain: d, aliasSeq: st.aliasSeq || 0, savedAt: new Date().toISOString() }, null, 2));
  console.log(`[state] 예전 작업 데이터를 도메인 ${d}로 옮겼습니다`);
}
try { migrateLegacy(); } catch (e) { console.log('[state] 예전 데이터 옮기기 실패:', e.message); }
pruneLogs();
try {
  const g = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  aliasSeq = g.aliasSeq || 0;
  const st = loadDomain(g.domain || 'default');
  console.log(`[state] 이어서 시작 · 도메인 ${domain} · 대화 ${sessionId ? sessionId.slice(0, 8) : '없음'} · 기록 ${steps.length}단계 (${st.savedAt || '-'})`);
} catch { /* 처음 실행 */ }

// ── 접속 제한: 이 호스트는 사이드패널(확장)과 같은 PC의 koala 프로세스만 쓴다 ──
// 127.0.0.1 에만 열어도 사용자가 연 아무 웹 페이지나 접속할 수 있다(WebSocket·POST는 막히지 않는다).
// - Host 가 127.0.0.1/localhost 가 아니면 거절한다(DNS 리바인딩)
// - 브라우저 요청(Origin 있음)은 koala 확장 출처만 받는다
// - 확장의 GET은 Origin 없이 Sec-Fetch-Site: none 으로 온다. 웹 페이지의 <script>·<img> GET은 cross-site 라 거절된다
// - 그 밖(MCP 서버·자동 점검)은 .koa/host-token 을 내야 한다. /health 만 예외(실행기가 켜졌는지 본다)
const EXT_ORIGIN = process.env.KOALA_EXT_ORIGIN || 'chrome-extension://hgeagihneebddhldphmjhjpeeigmeahc';
const HOST_TOKEN = hostToken();
function allowed(req) {
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) return false;
  if (req.headers.origin) return req.headers.origin === EXT_ORIGIN;
  if (req.method === 'GET' && req.url === '/health') return true;
  if (req.method === 'GET' && req.headers['sec-fetch-site'] === 'none') return true;
  const t = String(req.headers[TOKEN_HEADER] || '');
  return t.length === HOST_TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(HOST_TOKEN));
}
function denied(req) {
  console.log(`[접속 거절] ${req.method} ${req.url} · origin ${req.headers.origin || '-'} · host ${req.headers.host || '-'}`);
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) { denied(req); res.statusCode = 403; return res.end(); }
  if (await sync.handle(req, res)) return;
  // 실행기(native-launcher)가 호스트가 켜졌는지 본다
  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: true, version: update.version() }));
  }
  // "Claude 설정 보기": 작업 폴더·파일·실제 전달 프롬프트
  if (req.method === 'GET' && req.url === '/claude/effective') {
    res.setHeader('content-type', 'application/json');
    try {
      const d = workspace.describe(profile);
      return res.end(JSON.stringify({
        ...d,
        flags: ['--setting-sources project', '--strict-mcp-config', '--tools ""', `--allowedTools mcp__koala__*`,
          ...(profile?.claude?.model ? [`--model ${profile.claude.model}`] : []), `--effort ${effortFor()}`],
        system: SYSTEM,
        profileContext: profileContext().trim(),
        claude: claudeEnv,
        recorded: steps.length, // '기록까지 비우기' 확인 창에 보여 줄 수행 기록 수
      }));
    } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ error: e.message })); }
  }
  // 릴리즈 노트: 이 설치본의 CHANGELOG.md(설치한 버전까지의 변경 내용). 사이드패널 메뉴의 '릴리즈 노트 보기'
  if (req.method === 'GET' && req.url === '/changelog') {
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    try { return res.end(fs.readFileSync(path.resolve(dir, '..', 'CHANGELOG.md'), 'utf8')); } catch { res.statusCode = 404; return res.end(''); }
  }
  // 가장 최근 테스트 초안(패널 저장소가 비었을 때 복원용)
  if (req.method === 'GET' && req.url === '/drafts/latest') {
    res.setHeader('content-type', 'application/json');
    const d = draftsDir(); // 지금 도메인의 초안만
    const files = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs })).sort((a, b) => b.t - a.t) : [];
    return res.end(files.length ? fs.readFileSync(path.join(d, files[0].f), 'utf8') : 'null');
  }
  // 사이드패널의 계획 목록: 활성 프로필의 계획 문서들
  if (req.method === 'GET' && req.url === '/plans') {
    res.setHeader('content-type', 'application/json');
    const plans = sync.catalog().filter((c) => c.kind === 'plan').map((c) => sync.get('plan', c.id))
      .filter((d) => !profile || d.profile === profile.id);
    return res.end(JSON.stringify(plans));
  }
  if (req.method === 'POST' && req.url === '/claude/open') {
    const d = workspace.prepare(profile);
    const [cmd, ...cmdArgs] = process.platform === 'darwin' ? ['open', d.dir] : WIN ? ['explorer', d.dir] : ['xdg-open', d.dir];
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
    return res.end('ok');
  }
  if (req.method === 'POST' && req.url === '/tool') {
    let body = '';
    for await (const c of req) body += c;
    const { name, args } = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    const t = Date.now();
    const out = name === 'run' ? await runPlan(args.steps || [])
      : name === 'save_tests' ? saveTests(args)
      : name === 'save_code' ? await saveCode(args)
      : name === 'save_tags' ? saveTags(args)
      : name === 'add_tests' ? saveAdded(args)
      : name === 'append_code' ? await appendCode(args)
      : name === 'make_tests' ? queueDerive(args)
      : await relay(name, args);
    if (timing) timing.tool += Date.now() - t;
    res.end(JSON.stringify(out));
  } else if (req.method === 'POST' && req.url === '/stop') {
    stopRun();
    res.end('ok');
  } else if (req.method === 'POST' && req.url === '/reset') {
    // 자동 점검용: 사이드패널의 "새 시나리오"와 같다
    archiveRec();
    sessionId = null; sessionAlias = null; steps = []; saveRec(); sendSession();
    stopClaude();
    send({ type: 'reset' });
    scheduleWarm(300);
    res.end('ok');
  } else if (req.method === 'POST' && req.url.startsWith('/instruct')) {
    mode = new URL(req.url, 'http://x').searchParams.get('mode') === 'plan' ? 'plan' : 'write';
    // 자동 점검용: 사이드패널에 입력한 것과 똑같이 처리한다
    let text = '';
    for await (const c of req) text += c;
    send({ type: 'log', kind: 'me', text });
    instruct(text);
    res.end('ok');
  } else { res.statusCode = 404; res.end(); }
});

// 연결이 여럿이어도(패널 다시 열기, 점검용 접속) 가장 최근에 열린 것을 패널로 쓰고, 그것이 끊기면 남은 연결로 돌아간다
const sockets = new Set();
new WebSocketServer({ server, verifyClient: ({ req }) => allowed(req) || (denied(req), false) }).on('connection', (ws) => {
  sockets.add(ws);
  panel = ws;
  console.log('사이드패널 연결됨');
  ws.send(JSON.stringify({ type: 'env', claude: checkClaude() }));
  ws.send(JSON.stringify({ type: 'session', alias: sessionAlias }));
  ws.send(JSON.stringify({ type: 'claude_conn', state: claudeConn, detail: claudeConnDetail }));
  sendUsage(ws);
  sendActor();
  sendUpdate(ws);
  checkUpdate(true); // 패널을 열 때마다 새로 확인한다
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'tool_result') { pending.get(m.id)?.(m); pending.delete(m.id); }
    // 사용자가 누른 것은 작업 기록에 남긴다(지시 원문은 instruct 에서)
    else if (!['profile', 'instruct', 'list_code', 'update_check'].includes(m.type)) audit('panel', { type: m.type, id: m.suite?.id || m.id, ids: m.ids });
    if (m.type === 'stop') stopRun();
    if (m.type === 'domain_override') {
      if (!blocked) log('err', '다시 진행할 지시가 없습니다. 지시를 다시 입력하세요');
      else if (job || codeRunning) log('err', '다른 작업이 진행 중입니다. 끝난 뒤 다시 누르세요');
      else { const b = blocked; instruct(b.text, { ...b.opts, force: true }); }
    }
    if (m.type === 'open_logs') {
      fs.mkdirSync(logsDir(), { recursive: true });
      const [cmd, ...cmdArgs] = process.platform === 'darwin' ? ['open', logsDir()] : WIN ? ['explorer', logsDir()] : ['xdg-open', logsDir()];
      spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
    }
    if (m.type === 'update_check') checkUpdate(true);
    if (m.type === 'update_apply') applyUpdate(m.tag);
    if (m.type === 'host_restart') {
      // 확장보다 옛 코드로 돌고 있을 때 사이드패널에서 다시 켠다. 작업 중이면 거절한다
      if (job || codeRunning) log('err', 'AI 작업이나 테스트 실행 중에는 호스트를 다시 켤 수 없습니다. 끝난 뒤 다시 누르세요');
      else { log('sys', '호스트를 새 코드로 다시 켭니다'); restartSelf(); }
    }
    if (m.type === 'derive') deriveTests();
    if (m.type === 'session_clear') clearSession();
    if (m.type === 'session_compact') compactSession();
    if (m.type === 'reinforce') reinforceTests(m.summary);
    if (m.type === 'publish') publishSuite(m.suite, m.base_version ?? 0);
    if (m.type === 'write_code') writeCode(m.suite);
    if (m.type === 'suggest_tags') suggestTags(m.suite);
    if (m.type === 'retag_code') retagCode(m.suite);
    if (m.type === 'list_code') listCode(m.id);
    if (m.type === 'run_code') runCode(m.suite, m.ids, !!m.only);
    if (m.type === 'add_tests') addTests(m.request, m.suite);
    if (m.type === 'profile') {
      if (!switchDomain(m.domain || domainOf(m.profile))) return;
      profile = m.profile;
      profileSeen = true;
      scheduleWarm(); // 패널을 열었거나 프로필이 바뀌었다. 같은 대화가 떠 있으면 그대로 둔다
      sendActor();
      if (profile) console.log(`[profile] ${profile.id} v${profile.version} · 계정 ${(profile.accounts || []).map((a) => `${a.key}${a.role ? `·${a.role}` : ''}(${secretValue(`${a.key}_USER`) && secretValue(`${a.key}_PASS`) ? '값 있음' : '값 없음'})`).join(', ')}`);
    }
    if (m.type === 'instruct') {
      if (m.profile) {
        if (!switchDomain(m.domain || domainOf(m.profile))) return;
        profile = m.profile; profileSeen = true;
      }
      if (m.mode) mode = m.mode === 'plan' ? 'plan' : 'write';
      audit('request', { text: m.text, roles: m.roles, mode });
      instruct(m.text, { roles: m.roles });
    }
    if (m.type === 'reset') { archiveRec(); sessionId = null; sessionAlias = null; steps = []; actor = null; saveRec(); sendActor(); stopClaude(); sendSession(); log('sys', '새 시나리오 시작'); scheduleWarm(300); }
  });
  ws.on('close', () => {
    sockets.delete(ws);
    if (panel === ws) panel = [...sockets].filter((x) => x.readyState === 1).at(-1) || null;
  });
});

// ── 업데이트 ──
// 1) 설치본: 최신 GitHub 릴리즈를 켜질 때·패널이 연결될 때·1분마다 본다
// 2) 디스크의 코드가 바뀌었는데(개발 폴더에 새 커밋, 업데이트 적용) 이 호스트는 옛 코드로 돌고 있으면 stale 로 알린다.
//    package.json 을 몇 초마다 지켜보다가 바뀌면 바로 사이드패널에 알린다
const RUNNING_VERSION = update.version();
let updateInfo = null;
async function checkUpdate(force = false) {
  // home: 이 호스트의 폴더. 확장이 다른 폴더(다른 설치본)에서 불러온 것이면 사이드패널이 알린다
  updateInfo = { ...(await update.check()), version: RUNNING_VERSION, disk: update.version(), home: path.dirname(path.resolve(dir)), repo: update.repo() };
  updateInfo.stale = updateInfo.disk !== RUNNING_VERSION;
  if (updateInfo.available) console.log(`[update] 새 릴리즈 ${updateInfo.latest.tag} (지금 v${updateInfo.version})`);
  if (force || updateInfo.available || updateInfo.stale) sendUpdate();
}
fs.watchFile(path.join(dir, 'package.json'), { interval: 3000 }, () => checkUpdate(true));
function sendUpdate(to) {
  if (!updateInfo) return;
  const m = JSON.stringify({ type: 'update', ...updateInfo });
  (to || panel)?.readyState === 1 && (to || panel).send(m);
}
async function applyUpdate(tag) {
  // 상주 모드에서는 Claude 프로세스가 늘 떠 있으므로, 실제로 작업 중인지(job)로 판단한다
  if (job || codeRunning) { log('err', 'AI 작업이나 테스트 실행 중에는 업데이트할 수 없습니다. 끝난 뒤 다시 누르세요'); return; }
  try {
    const r = await update.apply(tag, (t) => log('sys', t));
    log('sys', `v${r.from} → v${r.to} 업데이트를 마쳤습니다. 호스트를 다시 켭니다`);
    send({ type: 'update_done', ...r });
    restartSelf();
  } catch (e) {
    log('err', `업데이트하지 못했습니다: ${e.message}`);
  }
}
// 새 호스트를 띄우고 이 프로세스는 끝낸다. 새 호스트는 포트가 비기를 기다렸다가 연다
function restartSelf() {
  const logDir = path.join(os.homedir(), '.koala');
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'host.log'), 'a');
  spawn(process.execPath, [path.join(dir, 'host.mjs')], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: { ...process.env, KOALA_WAIT_PORT: '1' } }).unref();
  setTimeout(() => process.exit(0), 300);
}

// 재시작 직후에는 이전 호스트가 포트를 놓을 때까지 잠시 다시 시도한다
let listenTries = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && process.env.KOALA_WAIT_PORT && listenTries++ < 40) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 250);
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`koala host: http://127.0.0.1:${PORT} · v${update.version()}`);
  checkUpdate();
  setInterval(checkUpdate, 60 * 1000).unref(); // 1분마다. 웹 주소로 보므로 GitHub API 한도를 쓰지 않는다(update.mjs)
});
