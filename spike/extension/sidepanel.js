// 사이드패널: 호스트와 WebSocket으로 연결하고, 도구 호출을 현재 탭에서 실행하며
// 조작·네트워크·콘솔·페이지 상태를 사람이 보도록 그린다.
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// pre: 강조 후 조작 전, move: 커서 이동, type: 글자 간격, post: 조작 후, hold: 검증 결과 표시 유지
// 배속: AI 가 작업 탭에서 조작할 때 단계를 보여 주는 대기(커서 이동·강조·입력 간격). x2 는 대기를 절반으로
const BASE_PACE = { pre: 300, move: 450, type: 45, post: 350, hold: 300 };
const RATES = [1, 2];
const nap = (ms) => (ms > 0 ? sleep(ms) : null);
let rate = 1;
const sp = () => Object.fromEntries(Object.entries(BASE_PACE).map(([k, v]) => [k, Math.round(v / rate)]));
const SLOW_MS = 1000;
const isBad = (r) => r.status === 'ERR' || r.status >= 400;
const isSlow = (r) => r.ms >= SLOW_MS;

let ws;
let paused = false;
let tabId = null;
let attachedTo = null;
let currentStep = null;
const requests = new Map(); // requestId → 요청 정보
const inflight = new Map(); // requestId → 시작 시각(ms)
const consoles = [];
const stepEls = new Map(); // 단계 번호 → 카드 (늦게 끝난 요청을 카드에 반영)
let netErr = 0;
let conErr = 0;
let lastAi = null;
// koa가 입력한 비밀값($KOALA_PASS 등)은 상세 보기·복사에서 가린다
const secrets = new Set();
const SECRET_KEY = /pass(word)?|pwd|secret|token|credential/i;
function mask(text) {
  let out = String(text ?? '');
  // 1) koa가 입력한 비밀값: 그대로 / URL 인코딩 / 폼 인코딩(! → %21 등) / JSON 이스케이프 형태 모두
  for (const v of secrets) {
    if (!v) continue;
    const forms = [v, encodeURIComponent(v), new URLSearchParams({ v }).toString().slice(2), JSON.stringify(v).slice(1, -1)];
    for (const form of new Set(forms)) out = out.split(form).join('••••');
  }
  // 2) 이름이 비밀번호·토큰처럼 생긴 폼 필드와 JSON 키의 값(헤더의 XSRF 같은 줄은 그대로 둔다)
  out = out.replace(/(^|[?&])([^=&\s]+)=([^&\s]*)/g, (m, sep, k, v) => (SECRET_KEY.test(k) && !/xsrf|csrf/i.test(k) ? `${sep}${k}=••••` : m));
  out = out.replace(/("([^"]+)"\s*:\s*)"([^"]*)"/g, (m, pre, k) => (SECRET_KEY.test(k) && !/xsrf|csrf/i.test(k) ? `${pre}"••••"` : m));
  return out;
}

// ---------------- 호스트 연결 ----------------

function connect() {
  ws = new WebSocket('ws://127.0.0.1:8765');
  ws.onopen = () => {
    hostUp = true; nativeState = null; renderEnvAlert();
    setSentOnOpen = false; // 호스트가 보내는 세트 목록(sets)을 받으면 지금 세트를 알린다
    // 끊기기 전의 진행 중 작업은 끝난 것으로 본다. 호스트가 아직 하고 있으면 연결하자마자 job 을 다시 보낸다
    if (jobNow && !jobNow.done) { jobNow = null; renderJob(); }
    clearStaleRun?.();
    sendClaudePrefs(); // 내가 고른 모델·effort 를 Claude 를 띄우기 전에 알린다
    maybeMigrate(); // 옮길 예전 데이터가 있으면 세트 작업보다 먼저
    renderSetChip();
  };
  ws.onclose = () => {
    hostUp = false; renderEnvAlert();
    requeueSent(); // 받았다는 답이 없던 테스트 목록 변경은 다시 연결되면 보낸다
    onMigrateSocketClosed();
    renderSetChip();
    if (sheetMode === 'set' || sheetMode === 'suite') renderSheet();
    startHost();
    setTimeout(connect, 2000);
  };
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'log') msg(m.kind, m.text);
    if (m.type === 'busy') setBusy(m.busy);
    if (m.type === 'env') { claudeEnv = m.claude; renderEnvAlert(); }
    if (m.type === 'job') { onJob(m); if (m.done) flushSuite(); }
    if (m.type === 'update') onUpdate(m);
    if (m.type === 'update_done') onUpdateDone(m);
    if (m.type === 'claude_run') renderClaudeRun(m.model, m.effort);
    if (m.type === 'claude_conn') { claudeConn = m; updateAiDot(); }
    if (m.type === 'claude_usage') onClaudeUsage(m);
    if (m.type === 'domain_mismatch') onDomainMismatch(m);
    if (m.type === 'session') renderSession(m.alias);
    if (m.type === 'actor') renderActor(m.actor);
    if (m.type === 'sets') onSets(m);
    if (m.type === 'set_active') onSetActive(m);
    if (m.type === 'migration_needed') onMigrationNeeded();
    if (m.type === 'migrated') onMigrated(m);
    if (m.type === 'tests') onTests(m);
    if (m.type === 'tests_saved') onTestsSaved(m);
    if (m.type === 'suite_tags') onSuiteTags(m);
    if (m.type === 'suite_retag') onSuiteRetag(m);
    if (m.type === 'suite_listed') onSuiteListed(m);
    if (m.type === 'suite_published') onSuitePublished(m);
    if (m.type === 'suite_code') onSuiteCode(m);
    if (m.type === 'suite_code_progress') onSuiteCodeProgress(m);
    if (m.type === 'plan') queuePlan(m.steps);
    if (m.type === 'plan_end') endPlan(m.skipped);
    if (m.type === 'reset') clearView();
    if (m.type === 'mode') setMode(m.mode, m.speed);
    if (m.type === 'tool') {
      let reply;
      try {
        reply = { ok: true, result: await runTool(m.name, m.args) };
      } catch (err) {
        reply = { ok: false, error: String(err.message || err), context: stepContext() };
      }
      ws.send(JSON.stringify({ type: 'tool_result', id: m.id, ...reply }));
    }
  };
}

$('f').onsubmit = async (e) => {
  e.preventDefault();
  if (aiBusy) return stopRun();
  const text = $('q').value.trim();
  if (!text || ws?.readyState !== 1) return;
  if (migrationNeeded) return msg('err', migrationText());
  if (!setInfo()?.received) return msg('err', '세트를 먼저 고르세요 · 위쪽 세트 칩에서 세트를 받고 고릅니다');
  msg('me', text);
  const roles = profileRoles().length > 1 ? scopeRoles() : undefined;
  if (roles?.length > 1) msg('sys', `역할 ${roles.map(roleLabel).join(' · ')}(으)로 차례로 수행합니다`);
  $('q').value = ''; // 탭 목록을 모으는 동안 입력한 글자가 지워지지 않게 먼저 비운다
  const tabs = await tabsForAi().catch(() => []);
  ws.send(JSON.stringify({ type: 'instruct', text, roles, tabs, set: activeSet }));
};
// 채팅처럼: Enter 로 실행, Shift+Enter 로 줄바꿈. 한글 입력 중(조합 중)의 Enter 는 글자 확정이라 실행하지 않는다
$('q').onkeydown = (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  // AI 작업 중에는 실행 버튼이 '중지'다. Enter 로 작업을 멈추지 않게 보내지 않고 알린다(중지는 버튼으로)
  if (aiBusy) { if (!enterBusyNoted) msg('sys', 'AI 작업 중입니다. 끝난 뒤 Enter 로 보내세요(멈추려면 중지 버튼)'); enterBusyNoted = true; return; }
  enterBusyNoted = false;
  $('f').requestSubmit();
};
let enterBusyNoted = false;
// ---------- 타임라인 저장·복원: 다시 열어도 그 시점부터 이어 본다 ----------
$('timeline').addEventListener('click', (e) => {
  const step = e.target.closest('.step');
  if (e.target.closest('.req-toggle') && step) return openSheet('net', { step: Number(step.dataset.n) });
  if (e.target.closest('.open-suite')) return openSheet('suite');
  if (e.target.closest('.step .h')) step.classList.toggle('open');
});
// 타임라인은 세트별로 저장한다(timeline@<세트 id>). 세트는 profile.js 의 viewSet
const timelineKey = (id) => `timeline@${id}`;
let saveTimer;
let restoringTimeline = false; // 세트를 바꾸며 화면을 비우고 채우는 동안에는 저장하지 않는다
function saveTimelineNow(d = viewSet) {
  clearTimeout(saveTimer);
  if (!d || restoringTimeline) return;
  const reqs = [...requests.values()].slice(-300).map((r) => ({ ...r, body: r.body?.slice(0, 20000) }));
  chrome.storage.local.set({ [timelineKey(d)]: { html: $('timeline').innerHTML, stepNo, reqs, consoles: consoles.slice(-200), netErr, conErr } }).catch(() => {});
}
function saveTimeline() {
  if (restoringTimeline) return;
  clearTimeout(saveTimer);
  const d = viewSet; // 0.8초 뒤 세트가 바뀌어 있어도 지금 세트에 저장한다
  saveTimer = setTimeout(() => saveTimelineNow(d), 800);
}
new MutationObserver(saveTimeline).observe($('timeline'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
async function restoreTimeline(d, label = d) {
  const key = timelineKey(d);
  const { [key]: st } = await chrome.storage.local.get([key]).catch(() => ({}));
  if (!st?.html) return;
  restoringTimeline = true;
  const empty = $('empty');
  $('timeline').innerHTML = st.html;
  if (!$('empty')) $('timeline').prepend(empty); // 저장본에 빈 화면 안내가 없어도 다시 둔다
  $('empty').hidden = !!$('timeline').querySelector('.step, .me, .ai');
  stepNo = st.stepNo || 0;
  for (const el of $('timeline').querySelectorAll('.step[data-n]')) {
    // 진행 중이던 카드는 중단된 것으로 표시
    if (el.classList.contains('run') || el.classList.contains('pending')) { el.classList.remove('run', 'pending'); el.classList.add('skipped'); el.querySelector('.meta').textContent = '중단됨'; }
    stepEls.set(Number(el.dataset.n), el);
  }
  for (const r of st.reqs || []) requests.set(r.id, r);
  consoles.push(...(st.consoles || []));
  netErr = st.netErr || 0; conErr = st.conErr || 0;
  renderCounts();
  await new Promise((r) => setTimeout(r)); // 위 변경으로 생긴 저장 예약을 건너뛴다
  restoringTimeline = false;
  msg('sys', `이전 기록을 불러왔습니다(${label}). 이어서 지시하면 같은 대화로 진행합니다`);
}

// 화면만 비운다(저장된 타임라인은 그대로). 세트를 바꿀 때 쓴다
function clearTimelineView() {
  restoringTimeline = true;
  [...$('timeline').children].forEach((c) => c.id !== 'empty' && c.remove());
  $('empty').hidden = false;
  requests.clear(); consoles.length = 0; stepEls.clear(); netErr = 0; conErr = 0; stepNo = 0; queue = []; renderCounts();
  setTimeout(() => { restoringTimeline = false; });
}
function clearView() {
  clearTimelineView();
  if (viewSet) chrome.storage.local.remove(timelineKey(viewSet)).catch(() => {});
}
function resetScenario() { clearView(); closeSheet(); ws.send(JSON.stringify({ type: 'reset' })); }
$('pause').onclick = () => {
  paused = !paused;
  $('pause').classList.toggle('on', paused);
  $('pause').textContent = paused ? '▶' : '❚❚';
  renderPlay();
};
// 배속은 AI 가 조작하는 동안에만 켠다(그때만 효과가 있다). 바꾸면 다음 단계부터 적용
function setRate(r) {
  rate = RATES.includes(r) ? r : 1;
  renderPlay();
}
function renderPlay() {
  $('rate-v').textContent = `x${rate}`;
  $('rate-down').disabled = !aiBusy || rate === RATES[0];
  $('rate-up').disabled = !aiBusy || rate === RATES.at(-1);
  $('rate').classList.toggle('off', !aiBusy);
  $('pause').disabled = !aiBusy;
  $('rate').dataset.tip = `조작 배속 · 지금 x${rate}${aiBusy ? '' : ' (AI가 조작할 때만 켜집니다)'}
AI가 작업 탭에서 클릭·입력할 때 커서 이동과 강조를 얼마나 천천히 보여 줄지입니다.
· x1: 단계마다 커서·강조를 보여 주며 진행
· x2: 보여 주는 대기를 절반으로
지시를 시작할 때 자동으로 정합니다: 처음 가는 경로(탐색)는 x1, 이미 지나간 경로(재생)는 x2.
진행 중에 바꾸면 다음 단계부터 적용됩니다. 테스트 결과, 생성 코드, Playwright 로컬 실행 속도에는 영향이 없습니다.`;
  $('pause').dataset.tip = !aiBusy ? '일시정지 · AI가 조작할 때만 켜집니다' : paused ? '이어서 진행' : '다음 조작 전에 멈춥니다(지금 단계는 끝까지)';
}
$('rate-down').onclick = () => setRate(RATES[Math.max(0, RATES.indexOf(rate) - 1)]);
$('rate-up').onclick = () => setRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(rate) + 1)]);
$('b-net').onclick = () => openSheet('net');
$('b-neterr').onclick = () => openSheet('net', { errorsOnly: true });
$('b-con').onclick = () => openSheet('con');

// 탐색(처음 가는 경로, 느리게) / 재생(알려진 경로, 빠르게)
function setMode(mode, v) {
  $('mode').hidden = false;
  $('mode').textContent = mode === 'replay' ? '재생 모드' : '탐색 모드';
  $('mode').className = `pill mode ${mode}`;
  $('mode').title = mode === 'replay'
    ? '재생 모드: 이 화면에서 이미 지나간 경로가 있어, 저장된 경로를 빠르게 이어서 실행합니다'
    : '탐색 모드: 처음 가는 경로라 화면을 하나씩 확인하며 천천히 진행합니다';
  setRate(v === 'fast' ? 2 : 1); // 호스트: 탐색·계획은 normal(x1), 재생은 fast(x2)
}

// ---------- 실행 환경 경고: 호스트 꺼짐 / Claude Code 없음 / 로그인 안 됨 ----------
let hostUp = false;
let aiBusy = false;
renderPlay(); // 배속·일시정지는 AI 가 조작할 때만 켜진다(처음에는 꺼짐)

// Claude 버튼의 점: 작업 중(밝게 맥동) / 연결 중(노랑 맥동) / 대기(파랑) / 연결 안 됨(빨강: 호스트 꺼짐·Claude Code 사용 불가·연결 실패)
// 호스트는 패널이 열리면 Claude를 미리 띄우고 대화를 연다(claude_conn: off | connecting | ready | failed)
let claudeConn = { state: 'off', detail: '' };
function updateAiDot() {
  const failed = hostUp && claudeConn.state === 'failed';
  const off = !hostUp || (claudeEnv && !claudeEnv.ok) || failed;
  const state = off ? 'off' : aiBusy ? 'busy' : claudeConn.state === 'connecting' ? 'connecting' : 'idle';
  const label = {
    off: !hostUp ? 'AI 연결 안 됨 (호스트 꺼짐)' : failed ? `AI 연결 실패 (${claudeConn.detail || '원인 모름'}) · 다음 지시 때 다시 연결합니다` : 'AI 연결 안 됨 (Claude Code를 쓸 수 없음)',
    busy: 'AI 작업 중',
    connecting: 'Claude 연결 중 (세션 준비)',
    idle: claudeConn.state === 'ready' ? 'AI 대기 (연결됨)' : 'AI 대기',
  }[state];
  $('ai-dot').className = `ai-dot ${state}`;
  $('ai-dot').setAttribute('aria-label', label);
  updateClaudeTip?.();
}

// ---------- 빠른 툴팁: 상단 요소의 title을 기본 툴팁(약 1초 지연) 대신 바로 보여 준다 ----------
const tipEl = document.createElement('div');
tipEl.className = 'tip';
tipEl.hidden = true;
document.body.appendChild(tipEl);
let tipTimer;
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('.top [title], .top [data-tip], .status [title], .status [data-tip]');
  if (!el) return;
  if (el.title) { el.dataset.tip = el.title; el.removeAttribute('title'); } // 기본 툴팁이 겹치지 않게
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    tipEl.textContent = el.dataset.tip;
    tipEl.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    tipEl.style.left = `${Math.max(6, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 6))}px`;
    tipEl.style.top = `${r.bottom + 6}px`;
  }, 90);
});
document.addEventListener('mouseout', (e) => {
  const el = e.target.closest('.top [data-tip], .status [data-tip]');
  if (el && !el.contains(e.relatedTarget)) { clearTimeout(tipTimer); tipEl.hidden = true; }
});
let claudeEnv = null;
let hostSeen = false;
// 호스트가 꺼져 있으면 Native Messaging 실행기로 켠다(설치 스크립트가 등록). 10초에 한 번만 시도
const NATIVE_HOST = 'io.github.xivicwon.koala';
let nativeState = null; // null | 'starting' | 'missing' | 'failed'
let nativeTried = 0;
function startHost() {
  if (Date.now() - nativeTried < 10000 || !chrome.runtime.sendNativeMessage) return;
  nativeTried = Date.now();
  nativeState = 'starting';
  chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'start' }, (r) => {
    if (chrome.runtime.lastError) nativeState = 'missing'; // 등록되지 않음(개발 설치 등)
    else nativeState = r?.ok ? null : 'failed';
    nativeError = r?.error || '';
    renderEnvAlert();
  });
}
let nativeError = '';
function renderEnvAlert() {
  const el = $('env-alert');
  let html = '';
  if (!hostUp) {
    // 패널을 연 직후 연결 중인 짧은 순간에는 띄우지 않는다
    if (nativeState === 'starting') html = '<b>호스트를 켜는 중입니다…</b>';
    else if (nativeState === 'failed') html = `<b>호스트를 켜지 못했습니다.</b> ${esc(nativeError)}`;
    else if (hostSeen || performance.now() > 4000) html = nativeState === 'missing'
      ? `<b>호스트가 실행 중이 아닙니다.</b> 설치 스크립트로 설치하면 자동으로 켜집니다. 직접 켜려면 <code>spike</code> 폴더에서 <code>npm start</code>를 실행하세요.`
      : `<b>호스트가 실행 중이 아닙니다.</b> <code>spike</code> 폴더에서 <code>npm start</code>를 실행하세요.`;
  } else if (claudeEnv && !claudeEnv.ok) {
    html = {
      not_installed: `<b>이 PC에서 Claude Code를 찾을 수 없습니다.</b> Claude Code를 설치한 뒤(<code>claude.com/claude-code</code>) 호스트를 다시 실행하세요. 다른 위치에 설치했다면 <code>CLAUDE_BIN</code> 환경변수로 경로를 알려 주세요.`,
      not_logged_in: `<b>Claude Code에 로그인되어 있지 않습니다.</b> 터미널에서 <code>claude auth login</code>을 실행해 로그인하세요.`,
    }[claudeEnv.reason] || `<b>Claude Code 상태를 확인하지 못했습니다.</b> ${esc(claudeEnv.detail || '')}`;
  }
  if (hostUp) hostSeen = true;
  el.innerHTML = html;
  el.hidden = !html;
  $('send').disabled = !!html && !aiBusy;
  updateAiDot();
  $('send').title = html ? '실행 환경을 먼저 확인하세요' : '';
  if (typeof updateDeriveBtn === 'function') updateDeriveBtn();
}
setTimeout(renderEnvAlert, 4100);

// 작업 중에는 실행 버튼이 중지 버튼이 된다
function stopRun() {
  if (ws?.readyState !== 1) return;
  cancelled = true;
  paused = false;
  ws.send(JSON.stringify({ type: 'stop' }));
  for (const c of queue) { c.el.classList.remove('pending'); c.el.classList.add('skipped'); c.el.querySelector('.meta').textContent = '중지됨'; }
  queue = [];
}
let cancelled = false;

function setBusy(b) {
  aiBusy = b;
  if (b) cancelled = false;
  if (!b && paused) { paused = false; $('pause').classList.remove('on'); $('pause').textContent = '❚❚'; }
  renderPlay();
  $('send').textContent = b ? '중지' : '실행';
  $('send').classList.toggle('stop', b);
  $('send').title = b ? 'AI 작업을 멈춥니다' : '';
  updateAiDot();
  $('send').disabled = !b && !$('env-alert').hidden;
  if (!b && lastAi) lastAi.classList.add('final'); // 마지막 AI 말은 요약으로 강조
  if (typeof updateDeriveBtn === 'function') updateDeriveBtn();
  if (sheetMode === 'set') renderSheet(); // 작업 중에는 세트 바꾸기·받기를 막는다
}
function msg(kind, text) {
  const d = document.createElement('div');
  if (kind === 'ai') {
    d.className = 'ai';
    const t = document.createElement('div');
    t.className = 't';
    t.innerHTML = md(text);
    d.appendChild(t);
    lastAi = d;
  } else {
    d.className = kind === 'tool' ? 'sys' : kind;
    d.textContent = text;
  }
  if (kind === 'me') lastAi = null;
  append(d);
}
// AI 말에 쓰이는 정도의 마크다운만: 굵게, 인라인 코드, 목록, 제목
function md(text) {
  return esc(text).split('\n').map((line) => {
    const inline = (x) => x.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    if (/^\s*[-*] /.test(line)) return `<div class="li">${inline(line.replace(/^\s*[-*] /, ''))}</div>`;
    if (/^#{1,3} /.test(line)) return `<div class="mh">${inline(line.replace(/^#{1,3} /, ''))}</div>`;
    return line.trim() ? `<div>${inline(line)}</div>` : '<div class="gap"></div>';
  }).join('');
}

function append(el) {
  const box = $('timeline');
  $('empty').hidden = true;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.appendChild(el);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------------- 탭 · 디버거 ----------------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowType: 'normal' });
  return tab;
}

// AI는 작업 탭(worktab.js)에만 붙는다. 화면에 보이는 탭이 바뀌어도 따라가지 않는다
async function ensureAttached() {
  const tab = await workTab();
  if (!tab) throw new Error('작업할 탭이 없습니다');
  tabId = tab.id;
  if (attachedTo !== tabId) {
    if (attachedTo) await chrome.debugger.detach({ tabId: attachedTo }).catch(() => {});
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTo = tabId;
    await cdp('Network.enable');
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    // 작업 탭이 뒤로 가도(사용자가 다른 탭을 봐도) 화면 그리기·타이머가 멈추지 않게 포커스를 흉내 낸다
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    fetchOn = false;
    await updateFetch();
  }
  return tab;
}

const cdp = (method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

// ---------- 계획 모드 네트워크 차단 ----------
// 어떤 버튼을 눌러도 서버 데이터가 바뀌지 않도록, 데이터 변경 요청을 브라우저가 보내기 직전에 막는다.
// 로그인·인증 요청과 조회(GET)는 허용한다
const NET_ALLOW = /\/(auth|login|logout|signin|session|sso)(\/|$|\?)/i;
let netGuard = false;
// 오류 주입: 이 요청이 오면 서버 대신 오류 응답·지연·네트워크 끊김을 돌려준다(실제 서버에는 가지 않음)
let faults = []; // { method, path(정규식), kind: status|delay|network, status, body, delay_ms, times }
let fetchOn = false;
async function updateFetch() {
  const want = netGuard || faults.length > 0;
  if (want === fetchOn) return;
  fetchOn = want;
  if (want) await cdp('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  else await cdp('Fetch.disable').catch(() => {});
}
async function setNetGuard(on) {
  netGuard = on;
  await updateFetch();
}
const b64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));
chrome.debugger.onEvent.addListener(async (src, method, p) => {
  if (src.tabId !== attachedTo || method !== 'Fetch.requestPaused') return;
  const m = p.request.method.toUpperCase();
  const reqPath = new URL(p.request.url).pathname + new URL(p.request.url).search;
  const f = faults.find((x) => (!x.method || x.method.toUpperCase() === m) && new RegExp(x.path).test(reqPath));
  if (f) {
    f.hits = (f.hits || 0) + 1;
    if (f.times && f.hits >= f.times) faults = faults.filter((x) => x !== f);
    injected.push({ method: m, path: reqPath, kind: f.kind, status: f.status, step: currentStep?.n });
    msg('sys', `오류 주입: ${m} ${reqPath} → ${f.kind === 'status' ? f.status : f.kind === 'delay' ? `${f.delay_ms}ms 지연` : '네트워크 끊김'}`);
    if (f.kind === 'network') { await cdp('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' }).catch(() => {}); updateFetch(); return; }
    if (f.kind === 'delay') { await sleep(f.delay_ms || 3000); await cdp('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); updateFetch(); return; }
    const body = f.body ?? JSON.stringify({ status: f.status, error: 'koa fault injection', message: '오류 주입 테스트' });
    await cdp('Fetch.fulfillRequest', {
      requestId: p.requestId, responseCode: f.status || 500,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: b64(body),
    }).catch(() => {});
    updateFetch();
    return;
  }
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(m);
  if (netGuard && mutating && !NET_ALLOW.test(new URL(p.request.url).pathname)) {
    await cdp('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    const path = new URL(p.request.url).pathname;
    blockedReqs.push({ method: m, path, step: currentStep?.n });
    msg('sys', `계획 모드라 데이터 변경 요청을 막았습니다: ${m} ${path}`);
    return;
  }
  await cdp('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
});
const blockedReqs = [];
const injected = [];

chrome.debugger.onDetach.addListener((src) => { if (src.tabId === attachedTo) attachedTo = null; });

// 요청·응답을 상세 보기와 복사에 쓸 수 있게 헤더와 본문까지 모은다
// 요청이 나가는 시점의 쿠키 저장소(HttpOnly 포함)를 요청마다 따로 남기고, 세션 쿠키를 직전 요청과 비교한다
const SESSION_COOKIE = /^(SESSION|JSESSIONID|PHPSESSID|connect\.sid|sid)$/i;
let lastSession; // 직전 요청 시점의 세션 쿠키 값(undefined: 아직 없음)
async function snapshotCookies(r) {
  try {
    const { cookies } = await cdp('Network.getCookies', { urls: [r.url] });
    r.cookies = cookies;
    const sess = cookies.find((c) => SESSION_COOKIE.test(c.name));
    r.session = sess ? { name: sess.name, value: sess.value } : null;
    const prev = lastSession;
    r.sessionChange = !sess ? (prev ? '사라짐' : '없음') : prev === undefined || prev === null ? '새로 생김' : prev === sess.value ? '같음' : '바뀜';
    lastSession = sess ? sess.value : null;
  } catch { r.cookies = null; }
}
const extraInfo = new Map(); // ExtraInfo 이벤트가 requestWillBeSent 보다 먼저 올 때 잠시 보관
const BODY_MAX = 1_000_000;

chrome.debugger.onEvent.addListener(async (src, method, p) => {
  if (src.tabId !== attachedTo) return;
  if (method === 'Network.requestWillBeSentExtraInfo' || method === 'Network.responseReceivedExtraInfo') {
    const key = method.startsWith('Network.request') ? 'reqHeadersRaw' : 'resHeadersRaw';
    const r = requests.get(p.requestId);
    if (r) r[key] = p.headers;
    else extraInfo.set(p.requestId, { ...extraInfo.get(p.requestId), [key]: p.headers });
    return;
  }
  if (method === 'Network.requestWillBeSent') {
    if (!['XHR', 'Fetch', 'Document'].includes(p.type)) return;
    const u = new URL(p.request.url);
    const r = { id: p.requestId, method: p.request.method, url: p.request.url, path: u.pathname + u.search, host: u.host,
      type: p.type, start: p.timestamp, wall: p.wallTime, step: currentStep?.n,
      reqHeaders: p.request.headers, post: p.request.postData, hasPost: p.request.hasPostData,
      ...extraInfo.get(p.requestId) };
    extraInfo.delete(p.requestId);
    if (p.type === 'Document') inflight.clear(); // 페이지 이동 시 끝나지 않은 이전 요청은 버린다
    requests.set(p.requestId, r);
    snapshotCookies(r);
    inflight.set(p.requestId, Date.now());
    lastReqStart = Date.now();
    refreshSheet();
  }
  const r = requests.get(p.requestId);
  if (!r) return;
  if (method === 'Network.responseReceived') {
    r.status = p.response.status;
    r.statusText = p.response.statusText;
    r.mime = p.response.mimeType;
    r.resHeaders = p.response.headers;
    r.protocol = p.response.protocol;
    r.remote = p.response.remoteIPAddress ? `${p.response.remoteIPAddress}:${p.response.remotePort}` : undefined;
  }
  if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    inflight.delete(p.requestId);
    r.ms = Math.round((p.timestamp - r.start) * 1000);
    r.size = p.encodedDataLength;
    if (method === 'Network.loadingFailed') { r.status = r.status || 'ERR'; r.failed = p.errorText; }
    if (r.status === 'ERR' || r.status >= 400) netErr++;
    if (r.hasPost && r.post == null) {
      try { r.post = (await cdp('Network.getRequestPostData', { requestId: p.requestId })).postData; } catch {}
    }
    if (method === 'Network.loadingFinished' && /json|text|xml|javascript|html/.test(r.mime || '')) {
      try {
        const b = await cdp('Network.getResponseBody', { requestId: p.requestId });
        const text = b.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(b.body), (c) => c.charCodeAt(0))) : b.body;
        r.body = text.length > BODY_MAX ? `${text.slice(0, BODY_MAX)}\n…(${text.length}자 중 앞부분)` : text;
      } catch {}
    } else if (method === 'Network.loadingFinished' && r.mime) {
      r.body = `(바이너리 · ${r.mime} · ${r.size ?? '?'} bytes)`;
    }
    renderCounts();
    renderIssues(r.step);
    refreshSheet();
  }
});

chrome.debugger.onEvent.addListener((src, method, p) => {
  if (src.tabId !== attachedTo) return;
  let entry;
  if (method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) {
    entry = { level: p.type, text: p.args.map((a) => a.value ?? a.description ?? a.type).join(' ') };
  }
  if (method === 'Runtime.exceptionThrown') {
    entry = { level: 'error', text: p.exceptionDetails.exception?.description || p.exceptionDetails.text };
  }
  if (!entry) return;
  entry.step = currentStep?.n;
  consoles.push(entry);
  if (entry.level === 'error') conErr++;
  renderCounts();
  renderIssues(entry.step);
  refreshSheet();
});

const checkedSecs = new Map(); // requestId → 체크한 영역 번호 Set
const openReqs = new Set();

const pretty = (text) => {
  if (text == null || text === '') return '';
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return String(text); }
};
const headerText = (h) => (h ? Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n') : '');

// 한 요청의 각 영역을 텍스트로: 화면 표시와 복사가 같은 내용을 쓴다
function reqSections(r) {
  const general = [
    `URL: ${r.url}`,
    `메서드: ${r.method}`,
    `상태: ${r.status ?? '대기'}${r.statusText ? ` ${r.statusText}` : ''}${r.failed ? ` (${r.failed})` : ''}`,
    `종류: ${r.type}${r.mime ? ` · ${r.mime}` : ''}${r.protocol ? ` · ${r.protocol}` : ''}`,
    r.remote && `원격 주소: ${r.remote}`,
    `시간: ${r.ms != null ? `${r.ms}ms` : '-'}${r.size != null ? ` · ${r.size} bytes` : ''}${r.wall ? ` · ${new Date(r.wall * 1000).toLocaleTimeString()}` : ''}`,
    r.step && `단계: #${r.step}`,
  ].filter(Boolean).join('\n');
  const sessionLine = r.cookies == null ? '(조회 실패)'
    : r.session ? `있음 · ${r.session.name}=${r.session.value} · 직전 요청 대비 ${r.sessionChange}`
    : `없음 · 직전 요청 대비 ${r.sessionChange}`;
  const cookieText = r.cookies == null ? '' : r.cookies.length ? r.cookies.map((c) => [
    `${c.name}=${c.value}`,
    `domain=${c.domain}`, `path=${c.path}`,
    c.expires > 0 ? `expires=${new Date(c.expires * 1000).toISOString()}` : 'session',
    c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite && `SameSite=${c.sameSite}`,
  ].filter(Boolean).join('; ')).join('\n') : '(쿠키 없음)';
  const resH = r.resHeadersRaw || r.resHeaders || {};
  const setCookie = Object.entries(resH).filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v).join('\n');
  return [
    ['일반', general],
    ['세션', sessionLine],
    ['쿠키 (요청 시점)', cookieText],
    ['요청 헤더', headerText(r.reqHeadersRaw || r.reqHeaders)],
    ['요청 본문', pretty(r.post)],
    ['응답 헤더', headerText(resH)],
    ['Set-Cookie (응답)', setCookie],
    ['응답 본문', pretty(r.body)],
  ].map(([title, text]) => [title, mask(text)]);
}
// ---------- 복사: 영문 키로 된 구조화 데이터 → YAML 또는 JSON ----------
const SESSION_EN = { '같음': 'same', '바뀜': 'changed', '사라짐': 'removed', '새로 생김': 'created', '없음': 'none' };
const parseJson = (t) => { try { return JSON.parse(t); } catch { return undefined; } };

// only: 복사할 영역 번호 Set(없으면 전체). 번호는 reqSections 순서와 같다
function reqData(r, only, format) {
  const want = (i) => !only || only.has(i);
  const resH = r.resHeadersRaw || r.resHeaders || {};
  const setCookie = Object.entries(resH).filter(([k]) => k.toLowerCase() === 'set-cookie')
    .flatMap(([, v]) => String(v).split('\n'));
  // 본문: JSON은 YAML에선 정렬한 원문 블록으로, JSON에선 객체로 넣는다
  const body = (t) => {
    if (t == null || t === '') return undefined;
    const j = parseJson(t);
    return j === undefined ? t : format === 'json' ? j : JSON.stringify(j, null, 2);
  };
  const d = {};
  if (want(0)) d.general = {
    url: r.url, method: r.method, status: r.status ?? 'pending', status_text: r.statusText || undefined,
    error: r.failed, resource_type: r.type, mime_type: r.mime, protocol: r.protocol, remote_address: r.remote,
    time_ms: r.ms, size_bytes: r.size, started_at: r.wall ? new Date(r.wall * 1000).toISOString() : undefined, step: r.step,
  };
  if (want(1)) d.session = r.cookies == null ? { error: 'cookie lookup failed' } : {
    present: !!r.session, name: r.session?.name, value: r.session?.value,
    change_from_previous_request: SESSION_EN[r.sessionChange] ?? r.sessionChange,
  };
  if (want(2) && r.cookies) d.cookies_at_request_time = r.cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session',
    http_only: c.httpOnly, secure: c.secure, same_site: c.sameSite,
  }));
  if (want(3) || want(4)) d.http_request = {
    headers: want(3) ? (r.reqHeadersRaw || r.reqHeaders) : undefined,
    body: want(4) ? body(r.post) : undefined,
  };
  if (want(5) || want(6) || want(7)) d.http_response = {
    headers: want(5) ? resH : undefined,
    set_cookie: want(6) && setCookie.length ? setCookie : undefined,
    body: want(7) ? body(r.body) : undefined,
  };
  return prune(d);
}
// 값이 없는 키는 뺀다
function prune(v) {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x);
      if (p !== undefined && !(p && typeof p === 'object' && !Array.isArray(p) && !Object.keys(p).length)) o[k] = p;
    }
    return o;
  }
  return v;
}

// 작은 YAML 직렬화: 여러 줄 문자열은 | 블록, 애매한 문자열은 큰따옴표
function yamlScalar(v, indent) {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const t = String(v);
  if (t.includes('\n') && !/^\s/.test(t)) return `|\n${t.replace(/\n$/, '').split('\n').map((l) => `${indent}${l}`).join('\n')}`;
  if (t === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$|: | #|^(true|false|null|yes|no|on|off|~)$|^[\d.+-]+$/i.test(t) || t.includes('\n')) return JSON.stringify(t);
  return t;
}
const yamlKey = (k) => (/^[\w.-]+$/.test(k) ? k : JSON.stringify(k));
function toYaml(v, indent = '') {
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v.map((x) => {
      if (x && typeof x === 'object') {
        const inner = toYaml(x, `${indent}  `);
        return `${indent}- ${inner.slice(indent.length + 2)}`;
      }
      return `${indent}- ${yamlScalar(x, `${indent}  `)}`;
    }).join('\n');
  }
  if (v && typeof v === 'object') {
    return Object.entries(v).map(([k, x]) => {
      if (x && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length)) {
        return `${indent}${yamlKey(k)}:\n${toYaml(x, `${indent}  `)}`;
      }
      return `${indent}${yamlKey(k)}: ${x && typeof x === 'object' ? (Array.isArray(x) ? '[]' : '{}') : yamlScalar(x, `${indent}  `)}`;
    }).join('\n');
  }
  return yamlScalar(v, indent);
}

let copyFormat = 'yaml';
try { copyFormat = localStorage.getItem('koa.copyFormat') || 'yaml'; } catch {}
function reqCopyText(r, only) {
  const data = reqData(r, only, copyFormat);
  // 요약 줄은 general이 없을 때만 붙인다(general에 같은 정보가 있다)
  const summary = data.general ? null : `${r.method} ${r.url} -> ${r.status ?? 'pending'}${r.ms != null ? ` (${r.ms}ms)` : ''}`;
  const text = copyFormat === 'json'
    ? JSON.stringify(summary ? { request: summary, ...data } : data, null, 2)
    : `${summary ? `# ${summary}\n` : ''}${toYaml(data)}\n`;
  return mask(text);
}

function reqRow(r) {
  const st = r.status ?? '…';
  const open = openReqs.has(r.id);
  const detail = open ? `<div class="req-detail">
      <div class="req-actions">
        <button type="button" class="btn sm copy" data-copy="checked" ${checkedSecs.get(r.id)?.size ? '' : 'disabled'}>체크한 영역 복사${checkedSecs.get(r.id)?.size ? ` (${checkedSecs.get(r.id).size})` : ''}</button>
        <button type="button" class="btn sm copy" data-copy="req">이 요청 전체 복사</button>
        <span class="fmt" role="radiogroup" aria-label="복사 형식">
          <label><input type="radio" name="fmt-${esc(r.id)}" value="yaml" ${copyFormat === 'yaml' ? 'checked' : ''}> YAML</label>
          <label><input type="radio" name="fmt-${esc(r.id)}" value="json" ${copyFormat === 'json' ? 'checked' : ''}> JSON</label>
        </span></div>
      ${reqSections(r).map(([title, text], i) => `<section class="sec">
        <div class="sec-h"><label class="sec-ck"><input type="checkbox" class="sck" data-sec="${i}" ${checkedSecs.get(r.id)?.has(i) ? 'checked' : ''}>
          <b>${title}</b></label></div>
        <pre class="mono">${text ? esc(text) : '<span class="none-inline">(없음)</span>'}</pre></section>`).join('')}
    </div>` : '';
  return `<div class="req ${open ? 'open' : ''}" data-id="${esc(r.id)}"><div class="l mono">
      <span class="sess ${r.session ? (r.sessionChange === '바뀜' ? 'chg' : 'on') : 'off'}" title="세션: ${r.session ? `있음 (${r.sessionChange})` : `없음 (${r.sessionChange ?? '-'})`}"></span>
      <span class="st ${isBad(r) ? 'bad' : r.status == null ? 'pend' : ''}">${st}</span>
      <span class="m">${r.method}</span>
      <span class="p" title="${esc(r.url)}">${esc(r.path)}</span>
      ${r.step ? `<span class="sn">#${r.step}</span>` : ''}
      <span class="t ${isSlow(r) ? 'slow' : ''}">${r.ms != null ? `${r.ms}ms` : ''}</span></div>${detail}</div>`;
}

async function copyText(text, btn) {
  await navigator.clipboard.writeText(text);
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = '복사됨';
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1200);
}

// ---------------- 시트: 요청할 때만 여는 네트워크 · 콘솔 · 코드 ----------------

let sheetMode = null;
let sheetOpts = {};
function openSheet(mode, opts = {}) {
  sheetMode = mode; sheetOpts = opts;
  $('sheet').hidden = false;
  renderSheet();
}
function closeSheet() { $('sheet').hidden = true; sheetMode = null; }
$('sheet-close').onclick = closeSheet;
document.querySelector('.sheet-backdrop').onclick = closeSheet;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetMode) closeSheet(); });
$('sheet-body').addEventListener('click', (e) => {
  const row = e.target.closest('.req');
  const r = row && requests.get(row.dataset.id);
  if (e.target.matches('.fmt input')) {
    copyFormat = e.target.value;
    try { localStorage.setItem('koa.copyFormat', copyFormat); } catch {}
    return;
  }
  if (e.target.matches('.sck') && r) {
    const set = checkedSecs.get(r.id) || new Set();
    const i = Number(e.target.dataset.sec);
    e.target.checked ? set.add(i) : set.delete(i);
    set.size ? checkedSecs.set(r.id, set) : checkedSecs.delete(r.id);
    return renderSheet();
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    // 복사는 한 요청 단위. 복사하고 나면 체크를 모두 푼다
    if (!r) return;
    const text = copy.dataset.copy === 'checked' ? reqCopyText(r, checkedSecs.get(r.id)) : reqCopyText(r);
    checkedSecs.clear();
    copyText(text).then(() => {
      renderSheet();
      const btn = $('sheet-body').querySelector(`.req[data-id="${CSS.escape(r.id)}"] [data-copy="${copy.dataset.copy}"]`);
      if (btn) { btn.textContent = '복사됨'; btn.disabled = false; btn.classList.add('done'); }
      setTimeout(() => renderSheet(), 1200);
    });
    return;
  }
  if (e.target.closest('.req .l') && r) {
    openReqs.has(r.id) ? openReqs.delete(r.id) : openReqs.add(r.id);
    renderSheet();
  }
});


let sheetTimer;
function refreshSheet() {
  if (sheetMode !== 'net' && sheetMode !== 'con') return;
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(renderSheet, 250);
}
function renderSheet() {
  const body = $('sheet-body');
  $('net-tools').hidden = sheetMode !== 'net';
  if (sheetMode === 'set') return renderSetSheet(body);
  if (sheetMode === 'claude') return renderClaudeSheet(body);
  if (sheetMode === 'suite') return renderSuiteSheet(body);
  if (sheetMode === 'release') return renderReleaseSheet(body);
  if (sheetMode === 'guide') return renderGuideSheet(body);
  if (sheetMode === 'wip') return renderWipSheet(body);
  if (sheetMode === 'feedback') return renderFeedbackSheet(body);
  if (sheetMode === 'confirm') {
    // Claude 설정의 '기록까지 비우기'에서 연다. 지울 것을 호스트 기준(세션·기록 수)으로 보여 주고 항상 확인한다
    $('sheet-title').textContent = '기록까지 비울까요?';
    body.innerHTML = `<div class="confirm">
      <p>다음을 비우고 처음부터 시작합니다.</p>
      <ul>
        <li>AI 대화 세션 <b>${esc(sheetOpts.alias || '새 대화')}</b> → 다음 지시는 새 세션으로 시작</li>
        <li>수행 기록${typeof sheetOpts.recorded === 'number' ? ` <b>${sheetOpts.recorded}단계</b>` : ''} (TDD·BDD를 만드는 근거)</li>
        <li>진행 타임라인, 요청·콘솔 내역</li>
      </ul>
      <p class="note">테스트 목록과 지나간 경로(그래프)는 그대로 남습니다. 수행 기록은 호스트의 <code>recordings/</code> 폴더에 보관됩니다.<br>대화만 새로 시작하려면 '세션 비우기'를 쓰세요(수행 기록 유지).</p>
      <div class="confirm-row">
        <button type="button" class="btn ghost" data-act="cancel">취소</button>
        <span class="grow"></span>
        <button type="button" class="danger" data-act="reset">기록까지 비우기</button>
      </div></div>`;
    body.querySelector('[data-act=cancel]').onclick = () => { claudeView = null; openSheet('claude'); loadClaudeView(); };
    body.querySelector('[data-act=reset]').onclick = resetScenario;
    return;
  }
  if (sheetMode === 'net') {
    let list = [...requests.values()];
    if (sheetOpts.step) list = list.filter((r) => r.step === sheetOpts.step);
    if (sheetOpts.errorsOnly) list = list.filter(isBad);
    $('sheet-title').textContent = `${sheetOpts.step ? `#${sheetOpts.step} 단계 ` : ''}${sheetOpts.errorsOnly ? 'API 오류' : '요청'} ${list.length}`;
    const scroll = body.scrollTop;
    body.innerHTML = list.length ? list.map(reqRow).join('') : '<div class="none">해당하는 요청이 없습니다</div>';
    body.scrollTop = scroll;
  }
  if (sheetMode === 'con') {
    $('sheet-title').textContent = `콘솔 ${consoles.length}`;
    body.innerHTML = consoles.length
      ? consoles.map((c) => `<div class="con mono ${c.level}">${c.step ? `#${c.step} ` : ''}${esc(c.text.slice(0, 1500))}</div>`).join('')
      : '<div class="none">콘솔 오류·경고가 없습니다</div>';
  }
}

function renderCounts() {
  $('c-net').textContent = requests.size;
  $('c-neterr').textContent = netErr; $('b-neterr').classList.toggle('bad', netErr > 0);
  $('c-con').textContent = consoles.length; $('b-con').classList.toggle('bad', conErr > 0);
}

async function renderPageState() {
  const tab = (await workTab({ claim: false })) || await activeTab();
  renderWorkTab();
  if (!tab) return;
  $('s-url').textContent = tab.url;
}
setInterval(renderPageState, 500);

// 3초 넘게 안 끝나는 요청(롱폴링·스트리밍)은 화면 안정 판단에서 뺀다
let lastReqStart = 0;
const activeInflight = () => [...inflight.values()].filter((t) => Date.now() - t < 3000).length;

async function waitIdle(since, max = 6000) {
  // 조작이 요청을 일으키지 않았으면 50ms만 보고 끝낸다.
  // 요청이 있었으면 진행 중인 요청이 150ms 동안 0개가 될 때까지 기다린다.
  await sleep(50);
  if (lastReqStart < since && !activeInflight()) return;
  const end = Date.now() + max;
  let quietSince = Date.now();
  while (Date.now() < end) {
    if (activeInflight()) quietSince = Date.now();
    else if (Date.now() - quietSince > 150) return;
    await sleep(30);
  }
}

// ---------------- 페이지 안에서 실행할 함수 (바깥 변수 사용 불가) ----------------

async function inPage(func, ...args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId } , func, args });
  return r.result;
}
async function overlay(fn, ...args) {
  const call = () => chrome.scripting.executeScript({
    target: { tabId },
    func: (fn, args) => { if (!window.__koala) return false; window.__koala[fn](...args); return true; },
    args: [fn, args],
  }).then((r) => r[0]?.result).catch(() => true);
  if (await call()) return;
  // 페이지가 바뀌어 표시물이 없을 때만 다시 주입한다
  await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] }).catch(() => {});
  await call();
}

function pageSnapshot() {
  const vis = (e) => !e.closest('[data-koala-overlay]') && (e.offsetParent !== null || e.getClientRects().length > 0);
  const nearLabel = (e) => e.labels?.[0]?.innerText || e.getAttribute('aria-label') || e.placeholder
    || e.closest('.v-input')?.previousElementSibling?.innerText || undefined;
  const elements = [...document.querySelectorAll('[data-testid], a[href], button, input, textarea, select, [role=tab], [role=button], [role=option], [role=dialog], h1, h2, h3')]
    .filter(vis).slice(0, 150).map((e) => ({
      tag: e.tagName.toLowerCase(),
      testid: e.getAttribute('data-testid') || undefined,
      role: e.getAttribute('role') || undefined,
      type: e.type || undefined,
      label: e.matches('input,textarea,select') ? nearLabel(e) : undefined,
      value: e.matches('input,textarea,select') && e.type !== 'password' ? e.value || undefined : undefined,
      text: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50) || undefined,
    }));
  const tables = [...document.querySelectorAll('table')].filter(vis).map((t) => ({
    testid: t.closest('[data-testid]')?.getAttribute('data-testid') || undefined,
    headers: [...t.querySelectorAll('thead th')].map((th) => th.innerText.trim()).filter(Boolean),
    rows: t.querySelectorAll('tbody tr').length,
    firstRows: [...t.querySelectorAll('tbody tr')].slice(0, 3).map((tr) => tr.innerText.trim().replace(/\s+/g, ' ').slice(0, 120)),
  }));
  return { elements, tables };
}

function pageResolve(l, opts) {
  const visible = (e) => e.offsetParent !== null || e.getClientRects().length > 0;
  let els = [];
  if (l.testid) els = [...document.querySelectorAll(`[data-testid="${CSS.escape(l.testid)}"]`)];
  else if (l.css) {
    try { els = [...document.querySelectorAll(l.css)]; } catch {
      return { ok: false, matched: 0, total: 0, error: `브라우저가 지원하지 않는 CSS 선택자: ${l.css} (:has-text 같은 Playwright 전용 문법은 text locator를 쓴다)` };
    }
  }
  else if (l.text) {
    const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');
    els = [...document.querySelectorAll('body *')].filter((e) => norm(e.innerText) === l.text
      && ![...e.children].some((c) => norm(c.innerText) === l.text));
  }
  els = els.filter((e) => !e.closest('[data-koala-overlay]'));
  const vis = els.filter(visible);
  const pool = opts?.anyVisibility ? els : vis;
  const el = pool[l.nth ?? 0];
  const info = { matched: pool.length, total: els.length };
  if (!el) return { ok: false, ...info, error: `요소 없음: ${JSON.stringify(l)}` };
  if (opts?.scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  const input = el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select');
  const btn = el.closest('button, [role=button], input[type=submit], input[type=button], a.v-btn, .v-btn');
  return {
    ok: true, ...info,
    testid: el.getAttribute('data-testid') || btn?.getAttribute('data-testid') || undefined,
    buttonLike: !!btn,
    buttonText: btn ? (btn.innerText || btn.value || '').trim().replace(/\s+/g, ' ').slice(0, 60) : undefined,
    inNav: !!el.closest('nav, aside, [role=tablist], [role=menu], [role=listbox], [data-testid^="nav-"]'),
    rect: { x: r.x, y: r.y, w: r.width, h: r.height }, x, y,
    hitOk: !!hit && (el === hit || el.contains(hit) || hit.contains(el)),
    hitDesc: hit ? `${hit.tagName.toLowerCase()}${hit.getAttribute('data-testid') ? `[${hit.getAttribute('data-testid')}]` : ''}` : null,
    visible: visible(el),
    tag: el.tagName.toLowerCase(),
    nativeSelect: el.tagName === 'SELECT',
    text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200),
    value: input && input.type !== 'password' ? input.value : undefined,
  };
}

// 지금 키보드 포커스가 있는 요소(탭 순서 측정용)
function pageFocused() {
  const el = document.activeElement;
  if (!el || el === document.body) return { none: true };
  const label = el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.placeholder
    || el.closest('.v-input')?.previousElementSibling?.innerText || '';
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(), type: el.type || undefined,
    testid: el.getAttribute('data-testid') || el.closest('[data-testid]')?.getAttribute('data-testid') || undefined,
    label: label.trim().slice(0, 40) || undefined,
    text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40) || undefined,
    inDialog: !!el.closest('[role=dialog], .v-overlay__content'),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
}
function pageFocus(l) {
  let el = null;
  if (l.testid) el = document.querySelector(`[data-testid="${CSS.escape(l.testid)}"]`);
  else if (l.css) { try { el = document.querySelector(l.css); } catch {} }
  const target = el?.matches('input,textarea,select,button,a,[tabindex]') ? el : el?.querySelector('input,textarea,select,button,a,[tabindex]');
  target?.focus();
  return !!target && document.activeElement === target;
}
function pageIsFocused(l) {
  const a = document.activeElement;
  let els = [];
  if (l.testid) els = [...document.querySelectorAll(`[data-testid="${CSS.escape(l.testid)}"]`)];
  else if (l.css) { try { els = [...document.querySelectorAll(l.css)]; } catch {} }
  else if (l.text) els = [...document.querySelectorAll('body *')].filter((e) => (e.innerText || '').trim() === l.text);
  return { pass: els.some((e) => e === a || e.contains(a)), active: a ? `${a.tagName.toLowerCase()}${a.getAttribute('data-testid') ? `[${a.getAttribute('data-testid')}]` : ''}` : null };
}

function pageSelectAll() {
  // 클릭으로 포커스가 간 입력란의 기존 값을 선택해 두면 다음 입력이 덮어쓴다
  const input = document.activeElement;
  if (!input?.matches('input,textarea')) return false;
  input.select?.();
  return true;
}

// ---------------- 실제 입력 (CDP) ----------------

async function mouseTo(x, y) {
  await overlay('cursor', x, y, sp().move);
  await nap(sp().move);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  lastCursor = { x, y };
}
async function mouseClick(x, y) {
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await overlay('ripple', x, y);
}
const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Escape: { code: 'Escape', vk: 27 }, Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 }, ArrowDown: { code: 'ArrowDown', vk: 40 }, ArrowUp: { code: 'ArrowUp', vk: 38 },
};
async function pressKey(key) {
  const k = KEYS[key];
  if (!k) throw new Error(`지원하지 않는 키: ${key}`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: k.code, windowsVirtualKeyCode: k.vk, text: k.text });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.vk });
}

// ---------------- 도구 실행 ----------------

// 계획 모드에서 누르면 안 되는 버튼. 버튼 글자로 판단하고, testid에서는 뜻이 분명한 단어만 본다
// (예: 로그인 버튼 testid 'auth-login-submit-btn'의 submit은 데이터 변경이 아니다). 메뉴·탭 안의 요소는 제외
// 데이터 변경은 네트워크 단계에서 막으므로(아래 Fetch 차단), 글자로는 되돌리기 어려운 동작만 막는다
const PLAN_BLOCK_TEXT = /삭제|철회|회수|승인|반려|상신|delete|remove|approve|reject|revoke/i;
const PLAN_BLOCK_ID = /delete|remove|approve|reject|revoke|recall/i;
const PLAN_ALLOW = /로그인|login|sign.?in|검색|search|조회|필터|filter/i;
function planBlocked(t) {
  const text = t.buttonText || '';
  const id = t.testid || '';
  if (PLAN_ALLOW.test(text) || PLAN_ALLOW.test(id)) return false;
  return PLAN_BLOCK_TEXT.test(text) || PLAN_BLOCK_ID.test(id);
}

const LABEL = { click: '클릭', type: '입력', select: '선택', hover: '올리기', press: '키',
  expect_visible: '보이는지', expect_text: '글자 확인', expect_value: '값 확인', expect_count: '개수 확인' };
const STEP_UI = {
  snapshot: ['◎', '화면 읽기'], screenshot: ['▣', '스크린샷'], goto: ['→', '이동'], back: ['←', '뒤로'],
  click: ['↖', '클릭'], type: ['⌨', '입력'], select: ['▾', '선택'], hover: ['◌', '올리기'], press: ['⏎', '키 입력'],
  expect_visible: ['✓', '보이는지 확인'], expect_text: ['✓', '글자 확인'], expect_value: ['✓', '값 확인'],
  expect_count: ['✓', '개수 확인'], expect_url: ['✓', 'URL 확인'],
  tab_order: ['⇥', '탭 순서'], expect_focused: ['✓', '포커스 확인'],
  fault: ['⚡', '오류 주입'], fault_clear: ['⚡', '오류 주입 해제'],
};
const READ_ONLY = new Set(['snapshot', 'screenshot', 'tab_order']);
let stepNo = 0;

function locText(l) {
  if (!l) return '';
  const base = l.testid ? l.testid : l.text ? `"${l.text}"` : l.css;
  return l.nth != null ? `${base} [${l.nth}]` : base;
}

function stepCard(name, args, state) {
  const n = ++stepNo;
  const [icon, label] = STEP_UI[name] || ['•', name];
  const el = document.createElement('div');
  el.className = `step ${state} ${READ_ONLY.has(name) ? 'read' : ''} ${name.startsWith('expect') ? 'verify' : ''}`;
  const tgt = args.locator ? locText(args.locator) : args.url || args.pattern || args.key || '';
  const val = args.secret ? '•••••' : args.value ?? args.text ?? args.option ?? (args.count != null ? `${args.count}개` : '');
  el.innerHTML = `<div class="h" title="${esc(name)}"><span class="ic">${icon}</span><span class="name">${label}</span>
    <span class="tgt mono">${esc(tgt)}${val !== '' ? ` · ${esc(val)}` : ''}</span>
    <span class="meta">${state === 'pending' ? '대기' : '진행 중'}</span></div>
    <div class="issues"></div><div class="detail"></div>`;
  el.dataset.n = n;
  stepEls.set(n, el);
  return { n, el, name };
}

// AI가 run으로 보낸 계획은 대기 카드로 미리 쌓아 두고, 실행되는 대로 위에서부터 채운다
let queue = [];
function queuePlan(steps) {
  const head = document.createElement('div');
  head.className = 'plan-head';
  head.textContent = `계획 ${steps.length}단계`;
  append(head);
  queue = steps.map((s) => {
    const c = stepCard(s.tool, s.args || {}, 'pending');
    append(c.el);
    return c;
  });
}
function endPlan(skipped) {
  for (const c of queue) {
    c.el.classList.remove('pending');
    c.el.classList.add('skipped');
    c.el.querySelector('.meta').textContent = '건너뜀';
  }
  if (skipped) msg('sys', `실패 지점에서 멈췄습니다 · 남은 ${skipped}단계는 AI가 다시 판단합니다`);
  queue = [];
}

function newStep(name, args) {
  if (queue.length && queue[0].name === name) {
    const c = queue.shift();
    c.el.classList.replace('pending', 'run');
    c.el.querySelector('.meta').textContent = '진행 중';
    c.el.scrollIntoView({ block: 'nearest' });
    return { n: c.n, el: c.el, t0: performance.now() };
  }
  const c = stepCard(name, args, 'run');
  append(c.el);
  return { n: c.n, el: c.el, t0: performance.now() };
}

// 문제가 있는 요청(오류·느림)과 콘솔 오류만 카드에 바로 드러낸다. 나머지는 버튼으로 연다.
function renderIssues(n) {
  const el = n && stepEls.get(n);
  if (!el) return;
  const reqs = [...requests.values()].filter((r) => r.step === n);
  const items = [
    ...reqs.filter(isBad).map((r) => `<span class="issue bad mono">${r.status} ${r.method} ${esc(r.path.split('?')[0])}</span>`),
    ...reqs.filter((r) => !isBad(r) && isSlow(r)).map((r) => `<span class="issue slow mono">느림 ${r.ms}ms · ${esc(r.path.split('?')[0])}</span>`),
    ...consoles.filter((c) => c.step === n && c.level === 'error').map((c) => `<span class="issue bad">콘솔 · ${esc(c.text.slice(0, 120))}</span>`),
  ];
  el.querySelector('.issues').innerHTML = items.join('');
  const btn = el.querySelector('.req-toggle');
  if (btn) btn.textContent = `요청 ${reqs.length}개 보기`;
}

function finishStep(step, ok, detail, img) {
  const el = step.el;
  el.classList.remove('run');
  el.classList.add(ok ? 'ok' : 'fail');
  if (!ok) el.classList.add('open');
  el.querySelector('.meta').textContent = `${ok ? '' : '실패 · '}${Math.round(performance.now() - step.t0)}ms`;
  const reqCount = [...requests.values()].filter((r) => r.step === step.n).length;
  el.querySelector('.detail').innerHTML = `<div class="res mono">${esc(detail)}</div>${img ? `<img src="${img}">` : ''}
    ${reqCount ? `<button class="btn sm req-toggle">요청 ${reqCount}개 보기</button>` : ''}`;
  renderIssues(step.n);
  if (typeof updateDeriveBtn === 'function') updateDeriveBtn();
}

function stepContext() {
  // AI에게도 같은 정보를 준다: 이 단계에서 일어난 API 요청과 콘솔 오류
  if (!currentStep) return undefined;
  const n = currentStep.n;
  return {
    tab: labelOf(tabId) || undefined, // 어느 관리 탭에서 조작했는지(Claude·기록용)
    requests: [...requests.values()].filter((r) => r.step === n)
      .map((r) => ({ method: r.method, path: r.path, status: r.status ?? 'pending', ms: r.ms })),
    consoleErrors: consoles.filter((c) => c.step === n && c.level === 'error').map((c) => c.text.slice(0, 300)),
    blockedRequests: blockedReqs.filter((b) => b.step === n).map((b) => `${b.method} ${b.path}`),
    injectedFaults: injected.filter((b) => b.step === n).map((b) => `${b.method} ${b.path} → ${b.kind === 'status' ? b.status : b.kind}`),
  };
}

// 계정 값($KOALA_…)은 세트 대상 서버 화면에만 입력한다. 페이지 글에 속은 AI가 다른 사이트 입력란에 넣게 하는 것을 막는다
async function guardSecret(a) {
  const base = setInfo()?.base_url;
  if (!base) throw new Error('세트에 대상 서버 주소가 없어 계정 값을 입력하지 않았습니다');
  const tab = await workTab(); // 계정 값은 작업 탭에만 입력한다
  let ok = false;
  try { ok = new URL(tab?.url || '').origin === new URL(base).origin; } catch {}
  if (!ok) throw new Error(`계정 값은 대상 서버(${new URL(base).origin}) 화면에만 입력합니다. 지금 탭: ${tab?.url || '없음'}`);
}

async function runTool(name, a) {
  if (a.secret && a.value) secrets.add(a.value);
  if (a.secret) await guardSecret(a);
  while (paused) await sleep(200);
  if (cancelled) throw new Error('사용자가 중지했습니다');
  const step = newStep(name, a);
  currentStep = step;
  try {
    const result = await execTool(name, a);
    const ctx = stepContext();
    finishStep(step, true, JSON.stringify(result.forAi ?? result, null, 1).slice(0, 1500), result.image);
    return { ...result, ...ctx };
  } catch (err) {
    finishStep(step, false, String(err.message || err));
    throw err;
  } finally {
    currentStep = null;
  }
}

async function poll(fn, ms = 5000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last.pass) return last;
    await sleep(50);
  }
  return last;
}

async function execTool(name, a) {
  const tab = await ensureAttached();
  await setNetGuard(!!a.guard);
  const s = sp();
  switch (name) {
    case 'goto': {
      await overlay('banner', `이동: ${a.url}`);
      const navAt = Date.now();
      await chrome.tabs.update(tab.id, { url: a.url });
      await waitTabComplete();
      await waitIdle(navAt);
      return { url: (await curTab()).url };
    }
    case 'back': {
      const navAt = Date.now();
      await cdp('Runtime.evaluate', { expression: 'history.back()' });
      await sleep(300); await waitTabComplete(); await waitIdle(navAt);
      return { url: (await curTab()).url };
    }
    case 'tabs': return { tabs: await tabsForAi(), forAi: { tabs: (await tabsForAi()).map((t) => `${t.tab}${t.current ? '(작업 탭)' : ''} ${t.title} ${t.url}`) } };
    case 'use_tab': { const r = await useTabFromAi(a.tab); await ensureAttached(); return { ...r, forAi: { 작업탭: `${r.tab} ${r.title}` } }; }
    case 'snapshot': {
      const snap = await inPage(pageSnapshot);
      return { url: tab.url, title: tab.title, ...snap, forAi: { url: tab.url, elements: snap.elements.length, tables: snap.tables } };
    }
    case 'screenshot': {
      // captureVisibleTab 은 보이는 탭만 찍는다. 작업 탭이 뒤에 있어도 그 탭을 찍도록 CDP로 찍는다
      const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
      return { image: `data:image/jpeg;base64,${shot.data}`, forAi: { captured: true } };
    }
    case 'click':
    case 'hover':
    case 'type':
    case 'select': {
      // 대상이 아직 안 그려졌을 수 있으니 Playwright처럼 나타날 때까지 짧게 반복해서 찾는다
      const found = await poll(async () => {
        const t = await inPage(pageResolve, a.locator, { scroll: true });
        return { pass: t.ok && t.hitOk, t };
      }, 3000);
      const t = found.t;
      if (!t.ok) throw new Error(t.error);
      if (a.guard && name === 'click' && t.buttonLike && !t.inNav && planBlocked(t)) {
        throw new Error(`계획 모드에서는 데이터를 바꿀 수 있는 버튼을 누를 수 없습니다: "${t.buttonText || t.testid}" (둘러보기만 가능, 대화상자는 Escape로 닫기)`);
      }
      const actedAt = Date.now();
      await overlay('show', t.rect, name, `${LABEL[name]}${a.secret ? '' : a.value ? `: ${a.value}` : a.option ? `: ${a.option}` : ''}`);
      await nap(s.pre);
      await mouseTo(t.x, t.y);
      if (!t.hitOk) throw new Error(`다른 요소가 가리고 있음: ${t.hitDesc}`);
      if (name !== 'hover') {
        await mouseClick(t.x, t.y);
        if (name === 'click') await overlay('hide');
      }
      let selected;
      if (name === 'type') {
        if (!(await inPage(pageSelectAll))) throw new Error('클릭 후 입력란에 포커스가 가지 않음');
        if (!a.value) await pressKey('Backspace');
        if (!s.type) await cdp('Input.insertText', { text: a.value }); // 빠르게: 한 번에 넣는다
        else for (const ch of a.value) {
          await cdp('Input.insertText', { text: ch });
          await sleep(s.type);
        }
      }
      if (name === 'select') {
        if (t.nativeSelect) throw new Error('네이티브 select는 아직 지원하지 않음');
        await nap(s.pre);
        const o = await poll(async () => {
          const opt = await inPage((text) => {
            const el = [...document.querySelectorAll('[role=option]')].find((e) => (e.offsetParent || e.getClientRects().length) && e.innerText.trim() === text);
            if (!el) return null;
            el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
          }, a.option);
          return { pass: !!opt, opt };
        }, 3000);
        if (!o.pass) throw new Error(`선택지 없음: ${a.option}`);
        await overlay('show', o.opt.rect, 'select', `선택: ${a.option}`);
        await mouseTo(o.opt.x, o.opt.y);
        await mouseClick(o.opt.x, o.opt.y);
        await overlay('hide');
        selected = a.option;
      }
      await waitIdle(actedAt);
      await nap(s.post);
      await overlay('hide');
      const after = name === 'type' && !a.secret ? await inPage(pageResolve, a.locator, { anyVisibility: true }) : null;
      return { matched: t.matched, url: (await curTab()).url, selected, value: after?.value };
    }
    case 'press': {
      await overlay('banner', `키 입력: ${a.key}`);
      await nap(s.pre);
      const pressedAt = Date.now();
      await pressKey(a.key);
      await waitIdle(pressedAt);
      await nap(s.post);
      await overlay('banner', '');
      return { url: (await curTab()).url };
    }
    case 'expect_visible':
    case 'expect_text':
    case 'expect_value':
    case 'expect_count': {
      const r = await poll(async () => {
        const t = await inPage(pageResolve, a.locator, { scroll: name !== 'expect_count' });
        if (!t) return { pass: false, t: {}, actual: null };
        if (name === 'expect_count') return { pass: t.matched === a.count, t, actual: t.matched };
        if (!t.ok) return { pass: false, t, actual: null };
        if (name === 'expect_visible') return { pass: t.visible, t, actual: 'visible' };
        if (name === 'expect_text') return { pass: t.text.includes(a.text), t, actual: t.text };
        return { pass: t.value === a.value, t, actual: t.value };
      });
      const expected = { expect_text: a.text, expect_value: a.value, expect_count: a.count }[name];
      if (r.t?.rect) {
        await overlay('show', r.t.rect, r.pass ? 'ok' : 'fail',
          `${r.pass ? '✓' : '✗'} ${LABEL[name]}${expected != null ? `: ${r.pass ? expected : `기대 ${expected} / 실제 ${r.actual}`}` : ''}`, 1500);
        await nap(s.post + s.hold);
      }
      if (!r.pass) throw new Error(`검증 실패(${name}): 기대 ${expected ?? '보임'}, 실제 ${JSON.stringify(r.actual)}`);
      return { pass: true, actual: r.actual, matched: r.t.matched };
    }
    case 'fault': {
      faults.push({ method: a.method, path: a.path, kind: a.kind, status: a.status, body: a.body, delay_ms: a.delay_ms, times: a.times ?? 1 });
      await updateFetch();
      return { armed: faults.length, note: '다음에 일치하는 요청에 오류가 주입됩니다' };
    }
    // 역할을 바꾸기 전에 대상 사이트의 로그인 상태(쿠키·저장소)를 지운다. 이 브라우저는 koala 전용이다
    case 'clear_login': {
      const origin = new URL((await curTab()).url).origin;
      await cdp('Network.clearBrowserCookies');
      await cdp('Storage.clearDataForOrigin', { origin, storageTypes: 'cookies,local_storage,session_storage,indexeddb,cache_storage' });
      return { cleared: origin };
    }
    case 'fault_clear': {
      faults = [];
      await updateFetch();
      return { armed: 0 };
    }
    case 'tab_order': {
      if (a.locator && !(await inPage(pageFocus, a.locator))) throw new Error(`시작 요소에 포커스를 둘 수 없음: ${JSON.stringify(a.locator)}`);
      const order = [await inPage(pageFocused)];
      for (let i = 0; i < a.count; i++) {
        await pressKey('Tab');
        await sleep(60);
        const f = await inPage(pageFocused);
        order.push(f);
        if (f.rect) await overlay('show', f.rect, 'read', `Tab ${i + 1}: ${f.label || f.text || f.testid || f.tag}`, s.post + 250);
        await nap(Math.max(120, s.post));
      }
      // 화면 읽기 순서(위→아래, 왼→오)를 거꾸로 가는 이동을 표시해 AI가 바로 볼 수 있게 한다
      order.forEach((f, i) => {
        const p = order[i - 1];
        if (p?.rect && f.rect && (f.rect.y < p.rect.y - 8 || (Math.abs(f.rect.y - p.rect.y) <= 8 && f.rect.x < p.rect.x - 8))) f.backward = true;
        if (p && f.testid && f.testid === p.testid && f.text === p.text) f.repeated = true;
      });
      return { order, forAi: { order: order.map((f, i) => `${i}: ${f.label || f.text || f.testid || f.tag}${f.backward ? ' ↺(역방향)' : ''}${f.repeated ? ' (반복)' : ''}`) } };
    }
    case 'expect_focused': {
      const r = await poll(async () => inPage(pageIsFocused, a.locator), 3000);
      if (!r.pass) throw new Error(`검증 실패(expect_focused): 포커스가 ${r.active}에 있음`);
      return { pass: true, active: r.active };
    }
    case 'expect_url': {
      const re = new RegExp(a.pattern);
      const r = await poll(async () => {
        const url = (await curTab()).url;
        return { pass: re.test(url), url };
      });
      await overlay('banner', `${r.pass ? '✓' : '✗'} URL ${a.pattern}`);
      await nap(s.post + s.hold);
      await overlay('banner', '');
      if (!r.pass) throw new Error(`URL 불일치: ${r.url} !~ ${a.pattern}`);
      return { pass: true, url: r.url };
    }
  }
  throw new Error(`알 수 없는 도구: ${name}`);
}

async function waitTabComplete(max = 15000) {
  const end = Date.now() + max;
  while (Date.now() < end) {
    if ((await curTab()).status === 'complete') return;
    await sleep(100);
  }
}

$('ver').textContent = `v${chrome.runtime.getManifest().version}`;
// 타임라인 복원과 호스트 연결은 세트를 불러온 뒤 sets.js 가 한다(어느 세트의 타임라인인지 알아야 하므로)

// 대상 탭이 세트 도메인이 아니어서 멈췄을 때: 세트 주소로 이동하거나, 승인하고 그대로 진행한다
function onDomainMismatch(m) {
  const d = document.createElement('div');
  d.className = 'err domain-warn';
  d.textContent = `대상 탭이 ${m.actual} 입니다. 이 세트의 도메인은 ${m.expected} 입니다. 그대로 진행하면 ${m.actual} 화면을 조작하고, 기록은 이 세트(${setInfo()?.name || m.expected})에 남습니다. `;
  const btns = [];
  const done = () => btns.forEach((x) => { x.disabled = true; });
  if (m.go) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn sm'; b.textContent = `${m.go} 로 이동`;
    b.onclick = async () => { done(); try { await chrome.tabs.update((await workTab()).id, { url: m.go }); } catch (e) { msg('err', `이동하지 못했습니다: ${e.message}`); } };
    btns.push(b);
  }
  if (m.can_force) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn sm'; b.textContent = '그래도 진행';
    b.title = `${m.actual} 에서 이번 지시를 그대로 실행합니다`;
    b.onclick = () => { if (ws?.readyState !== 1) return msg('err', '호스트와 연결되어 있지 않습니다'); done(); ws.send(JSON.stringify({ type: 'domain_override' })); };
    btns.push(b);
  }
  d.append(...btns);
  append(d);
}

// koa가 마지막으로 로그인한 역할(헤더 밴드). 테스트 기록과 시나리오의 역할이 이것으로 정해진다
function renderActor(a) {
  const el = $('s-actor');
  el.hidden = !a;
  if (!a) return;
  el.textContent = a.label || a.key;
  el.dataset.tip = `지금 로그인한 역할: ${a.label || '-'}${a.account ? ` (${a.account})` : ''}
koa가 $${a.key}_USER 로 로그인했습니다. 이 기록으로 만드는 시나리오는 이 역할로 수행됩니다.
다른 역할로 하려면 "일반 사용자로 로그인해서 …"처럼 말하세요.`;
}
