// 프로필: 대상 서비스·버전·목적 하나(대상 사이트 하나). 프로필 정의(대상 주소·역할·지식·태그)는 호스트가 서버
// (지금은 이 PC의 임시 저장소)에서 받아 프로필 폴더에 둔다. 받은 정의는 패널에서 고치지 않는다(이 PC 전용 프로필은 예외).
// 이 확장에는 사람마다 다른 값(시작 URL·내 계정·역할 범위)만 '내 설정'으로 프로필별로 둔다(setPrefs).
// 계정 비밀번호는 평문으로 저장하고(키체인은 보류) 호스트(이 PC)로 프로필을 고를 때만 보낸다.
// 화면(프로필 칩·프로필 시트)은 sets.js
let setList = [];      // 호스트의 프로필 목록(sets 메시지). 호스트가 꺼져 있으면 마지막으로 받은 목록(setsCache)
let activeSet = null;  // 고른 프로필 id
let setPrefs = {};     // 프로필 id → { start_url?, accounts: { KOALA_<역할>: { user, pass } }, roles?: [역할 key] }
let viewSet = null;    // 지금 화면(타임라인·테스트 목록)이 보여 주는 프로필. 프로필을 바꿀 때 바뀐다
let migrationNeeded = false; // 호스트에 옮기지 않은 예전 데이터가 있다(옮기기 전에는 프로필 작업을 하지 않는다)

const setInfo = (id = activeSet) => setList.find((s) => s.id === id) || null;
const domainOf = (s) => s?.domain || (() => { try { return new URL(s?.base_url).hostname || 'default'; } catch { return 'default'; } })();
const activeDomain = () => domainOf(setInfo());
const prefOf = (id) => setPrefs[id] || {};
// 시작 URL: 내 설정이 있으면 그것, 없으면 프로필 정의의 값
const startUrlOf = (id) => prefOf(id).start_url || setInfo(id)?.start_url || '';
const saveSetPrefs = () => chrome.storage.local.set({ setPrefs }).catch(() => {});

// 프로필의 역할(받은 역할 문서). 기본 계정은 호스트에만 있고 패널은 있는지만 안다
const profileRoles = () => setInfo()?.roles || [];
const defaultRoleKey = () => setInfo()?.default_role || profileRoles()[0]?.key || null;
const roleLabel = (key) => profileRoles().find((r) => r.key === key)?.label || key || '';
const accKey = (role) => `KOALA_${role}`;
// 역할의 계정: 내가 넣은 계정이 있으면 그것, 없으면 서버 기본 계정
function roleAccount(id, r) {
  const mine = prefOf(id).accounts?.[accKey(r.key)];
  const own = !!mine?.user;
  return { key: accKey(r.key), role: r.key, label: `${r.label} 계정`, user: own ? mine.user : '', source: own ? 'mine' : r.has_default ? 'server' : 'none', usable: own || !!r.has_default };
}
// 로그인할 수 있는 역할(내 계정이나 서버 기본 계정이 있는 것)
const usableRoles = () => profileRoles().filter((r) => roleAccount(activeSet, r).usable);
// 이번 지시를 수행할 역할: 고른 것이 없으면 로그인할 수 있는 역할 모두
function scopeRoles() {
  const ok = usableRoles().map((r) => r.key);
  const picked = (prefOf(activeSet).roles || ok).filter((k) => ok.includes(k));
  return picked.length ? picked : ok.slice(0, 1);
}

// 입력창 옆 역할 칩: 이번 지시를 어느 역할로 수행할지 고른다
function renderRoleScope() {
  const el = document.getElementById('role-scope');
  if (!el) return;
  const roles = profileRoles();
  el.hidden = roles.length < 2;
  const on = new Set(scopeRoles());
  el.innerHTML = roles.map((r) => {
    const a = roleAccount(activeSet, r);
    return `<button type="button" class="role-chip ${on.has(r.key) ? 'on' : ''}" data-role-scope="${esc(r.key)}" ${a.usable ? '' : 'disabled'}
      title="${a.usable ? `${esc(r.label)}로 수행 (${a.source === 'mine' ? '내 계정' : '서버 기본 계정'})` : `${esc(r.label)} 계정이 없습니다. 프로필의 내 설정에서 계정을 넣으세요`}">${esc(r.label)}</button>`;
  }).join('');
}
document.getElementById('role-scope')?.addEventListener('click', (e) => {
  const k = e.target.closest('[data-role-scope]')?.dataset.roleScope;
  if (!k || !activeSet) return;
  const cur = new Set(scopeRoles());
  if (cur.has(k)) { if (cur.size > 1) cur.delete(k); } else cur.add(k);
  setPrefs[activeSet] = { ...prefOf(activeSet), roles: profileRoles().map((r) => r.key).filter((x) => cur.has(x)) };
  saveSetPrefs();
  renderRoleScope();
});

// 서버 전송에 쓸 배포 서버(프로필 정의의 값, 형식이 맞을 때만)
function deployServer() {
  const u = setInfo()?.deploy_url?.trim();
  try { return u && /^https?:$/.test(new URL(u).protocol) ? u : null; } catch { return null; }
}

// 호스트로 보내는 내 설정. 호스트는 이것과 프로필 정의로 프로필(대상·역할·계정)을 만든다
function prefsPayload(id) {
  const p = prefOf(id);
  return {
    start_url: p.start_url || undefined,
    accounts: Object.entries(p.accounts || {}).filter(([, a]) => a?.user).map(([key, a]) => ({ key, user: a.user, pass: a.pass || '' })),
    roles: p.roles,
  };
}
// 호스트에 지금 프로필(와 내 설정)를 알린다. 호스트는 set_active·tests 로 답한다
function sendSetToHost() {
  if (!activeSet || migrationNeeded || typeof ws === 'undefined' || ws?.readyState !== 1 || !setInfo()?.received) return false;
  ws.send(JSON.stringify({ type: 'set', id: activeSet, prefs: prefsPayload(activeSet) }));
  return true;
}

async function loadSetState() {
  const r = await chrome.storage.local.get(['activeSet', 'setPrefs', 'setsCache']).catch(() => ({}));
  activeSet = r.activeSet || null;
  setPrefs = r.setPrefs || {};
  setList = Array.isArray(r.setsCache) ? r.setsCache : [];
  renderSetChip();
  renderRoleScope();
}

// 지금 프로필의 타임라인을 불러온다. 테스트 목록은 호스트가 보내 준다(tests)
async function restoreSetData() {
  viewSet ??= activeSet;
  // 뒤에 오는 스크립트(suite.js·sets.js)가 모두 실행된 뒤에 부른다
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  if (viewSet) await restoreTimeline(viewSet, setInfo(viewSet)?.name);
  renderSetTip();
}
// 다른 프로필로 바꾸면 지금 화면을 저장하고 그 프로필의 타임라인으로 바꾼다. 테스트 목록은 호스트가 새로 보낸다
async function changeSetView(id) {
  if (id === viewSet) return;
  const from = viewSet;
  if (from && setInfo(from)) saveTimelineNow(from); // 지운 프로필의 타임라인은 다시 저장하지 않는다
  clearTimelineView();
  resetSuiteView();
  viewSet = id;
  if (id) await restoreTimeline(id, setInfo(id)?.name);
  renderSetTip();
  if (from && id) msg('sys', `프로필 "${setInfo(id)?.name || id}"의 작업 데이터로 바꿨습니다 (${setInfo(from)?.name || from}에서 바꿈)`);
}
function renderSetTip() {
  const el = document.querySelector('.url-row');
  const s = setInfo(viewSet);
  if (el) el.dataset.tip = `AI가 조작하고 지켜보는 탭(대상 탭)의 지금 주소입니다.\n프로필: ${s?.name || '-'} · 대상 도메인 ${s ? domainOf(s) : '-'}. 대상 탭이 이 도메인이 아니면 실행하기 전에 멈추고 묻습니다.`;
}
