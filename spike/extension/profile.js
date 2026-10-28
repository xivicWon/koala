// 프로필: 대상 서버·사이트 지식(프롬프트)·역할. 동기화 저장소에서 받아 chrome.storage.local 에 둔다.
// 역할과 역할별 기본 계정은 서버의 역할 문서로 받는다. 사용자가 바꾼 계정은 공유하지 않고 이 확장에만 저장한다(키체인은 보류, 평문).
const SYNC = 'http://127.0.0.1:8765/sync';
const KEEP_HISTORY = 3;

let profiles = {};   // id → { data, dirty, conflict, history: [이전 data…], syncedAt }
let activeId = null;
let localAcc = {};   // id → { 계정 key → { user, pass } } (사용자가 바꾼 계정)
let roleDocs = {};   // 역할 문서 id → 문서(역할·기본 계정)
let roleScope = {};  // 프로필 id → 이번에 수행할 역할 key 목록
let remoteVer = {};  // id → 저장소 최신 버전
let syncError = '';

// ── 도메인: 작업 데이터(수행 기록·세션·타임라인·테스트 목록)는 프로필 대상 주소의 호스트 이름별로 따로 둔다 ──
// viewDomain 은 지금 불러온 도메인. 대상 주소를 고치는 도중에는 바뀌지 않고, 입력을 마치거나 프로필을 바꿀 때 바뀐다
let viewDomain = null;
const domainOf = (p) => { try { return new URL(p?.target?.base_url).hostname || 'default'; } catch { return 'default'; } };
const activeDomain = () => domainOf(profiles[activeId]?.data);

// 호스트는 자동 실행(/instruct)에도 같은 프로필을 쓰도록 바뀔 때마다 받아 둔다. 도메인을 정하기 전에는 보내지 않는다
function sendProfileToHost() {
  if (viewDomain && typeof ws !== 'undefined' && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'profile', profile: activeProfilePayload(), domain: viewDomain }));
}

// 지금 도메인의 타임라인과 테스트 목록을 불러온다
async function restoreDomainData() {
  viewDomain ??= activeDomain();
  // 뒤에 오는 스크립트(suite.js)가 모두 실행된 뒤에 부른다
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  await restoreTimeline(viewDomain);
  await restoreSuite(viewDomain);
  renderDomain();
}
// 프로필(대상 주소)이 다른 도메인이면 지금 화면을 저장하고 그 도메인의 데이터로 바꾼다
async function changeDomainIfNeeded() {
  const d = activeDomain();
  if (viewDomain === null || d === viewDomain) return;
  const from = viewDomain;
  saveTimelineNow(from);
  clearTimelineView();
  resetSuiteView();
  viewDomain = d;
  sendProfileToHost(); // 호스트도 그 도메인의 수행 기록·세션으로 바꾼다
  await restoreTimeline(d);
  await restoreSuite(d);
  renderDomain();
  msg('sys', `대상 도메인 ${d}의 작업 데이터를 불러왔습니다 (${from}에서 바꿈)`);
}
function renderDomain() {
  const el = document.querySelector('.url-row');
  if (el) el.dataset.tip = `AI가 조작하고 지켜보는 탭(대상 탭)의 지금 주소입니다.\n작업 데이터 도메인: ${viewDomain || '-'} (프로필 대상 주소 기준). 대상 탭이 이 도메인이 아니면 실행하지 않습니다.`;
}
const saveProfiles = () => {
  sendProfileToHost();
  return chrome.storage.local.set({ profiles, activeProfile: activeId, profileLocal: localAcc, roleDocs, roleScope });
};

async function loadProfiles() {
  const r = await chrome.storage.local.get(['profiles', 'activeProfile', 'profileLocal', 'roleDocs', 'roleScope']);
  profiles = r.profiles || {};
  activeId = r.activeProfile || null;
  localAcc = r.profileLocal || {};
  roleDocs = r.roleDocs || {};
  roleScope = r.roleScope || {};
  renderProfileChip();
  renderRoleScope();
  sendProfileToHost();
}

// 프로필의 역할: 서버 역할 문서(roles: <문서 id>). 예전 프로필은 역할을 직접 담고 있었다
function roleSet(d) {
  if (!d) return { roles: [], default_role: null };
  const doc = typeof d.roles === 'string' ? roleDocs[d.roles] : { roles: d.roles || [], default_role: d.default_role };
  const roles = doc?.roles || [];
  return { roles, default_role: doc?.default_role || roles[0]?.key || null, doc_id: typeof d.roles === 'string' ? d.roles : null, version: doc?.version };
}
const accKey = (role) => `KOALA_${role}`;
// 역할의 계정: 내가 바꾼 계정이 있으면 그것, 없으면 서버 기본 계정
function roleAccount(pid, r) {
  const def = r.account || null;
  const mine = localAcc[pid]?.[accKey(r.key)];
  const own = mine?.user && !(def && mine.user === def.user && (mine.pass || '') === (def.pass || ''));
  const use = own ? mine : def;
  return { key: accKey(r.key), role: r.key, label: `${r.label} 계정`, user: use?.user || '', pass: use?.pass || '', source: own ? 'mine' : def?.user ? 'server' : 'none', def };
}

// 활성 프로필의 역할(관리자·일반 사용자 등)
const profileRoles = () => roleSet(profiles[activeId]?.data).roles;
const defaultRoleKey = () => roleSet(profiles[activeId]?.data).default_role;
const roleLabel = (key) => profileRoles().find((r) => r.key === key)?.label || key || '';
// 로그인할 수 있는 역할(계정 값이 있는 것)
const usableRoles = () => profileRoles().filter((r) => roleAccount(activeId, r).user);
// 이번 지시를 수행할 역할: 고른 것이 없으면 로그인할 수 있는 역할 모두
function scopeRoles() {
  const ok = usableRoles().map((r) => r.key);
  const picked = (roleScope[activeId] || ok).filter((k) => ok.includes(k));
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
    const a = roleAccount(activeId, r);
    return `<button type="button" class="role-chip ${on.has(r.key) ? 'on' : ''}" data-role-scope="${esc(r.key)}" ${a.user ? '' : 'disabled'}
      title="${a.user ? `${esc(r.label)}로 수행 (${a.source === 'mine' ? '내 계정' : '서버 기본 계정'})` : `${esc(r.label)} 계정이 없습니다. 프로필에서 계정을 넣으세요`}">${esc(r.label)}</button>`;
  }).join('');
}
document.getElementById('role-scope')?.addEventListener('click', (e) => {
  const k = e.target.closest('[data-role-scope]')?.dataset.roleScope;
  if (!k) return;
  const cur = new Set(scopeRoles());
  if (cur.has(k)) { if (cur.size > 1) cur.delete(k); } else cur.add(k);
  roleScope[activeId] = profileRoles().map((r) => r.key).filter((x) => cur.has(x));
  chrome.storage.local.set({ roleScope });
  renderRoleScope();
});

async function pullRoleDoc(id) {
  try {
    const r = await fetch(`${SYNC}/roles/${encodeURIComponent(id)}`);
    if (r.ok) roleDocs[id] = await r.json();
  } catch {}
}

// 저장소 목록과 비교해 새 버전이 있으면 받는다. 내가 고친 게 있으면 덮어쓰지 않고 충돌로 표시한다
async function syncProfiles() {
  try {
    const cat = await (await fetch(`${SYNC}/catalog`)).json();
    syncError = '';
    for (const item of cat.filter((c) => c.kind === 'profile')) {
      remoteVer[item.id] = item.version;
      const mine = profiles[item.id];
      if (mine && mine.data.version >= item.version) continue;
      if (mine?.dirty) { mine.conflict = true; continue; }
      await pullProfile(item.id, { quiet: !mine });
    }
    // 역할 문서는 늘 새로 받는다(기본 계정이 바뀔 수 있다)
    for (const id of new Set(Object.values(profiles).map((p) => p.data.roles).filter((x) => typeof x === 'string'))) await pullRoleDoc(id);
    if (!activeId || !profiles[activeId]) activeId = Object.keys(profiles)[0] || null;
    await saveProfiles();
  } catch (e) {
    syncError = '동기화 저장소에 연결할 수 없습니다';
  }
  renderProfileChip();
  renderRoleScope();
  if (sheetMode === 'profile') renderSheet();
  if (!aiBusy) await changeDomainIfNeeded(); // 받은 새 버전의 대상 주소가 바뀌었거나 활성 프로필이 바뀌었을 수 있다
}

async function pullProfile(id, { quiet } = {}) {
  const doc = await (await fetch(`${SYNC}/profiles/${encodeURIComponent(id)}`)).json();
  const mine = profiles[id];
  const history = mine ? [mine.data, ...(mine.history || [])].slice(0, KEEP_HISTORY) : [];
  profiles[id] = { data: doc, dirty: false, conflict: false, history, syncedAt: Date.now() };
  remoteVer[id] = doc.version;
  if (mine && !quiet) msg('sys', `프로필 "${doc.name}" v${mine.data.version} → v${doc.version} 업데이트를 받았습니다`);
}

async function pushProfile(id) {
  const p = profiles[id];
  const res = await fetch(`${SYNC}/profiles/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_version: p.data.version, data: p.data }),
  });
  const body = await res.json();
  if (res.status === 409) {
    p.conflict = true;
    remoteVer[id] = body.current.version;
    return { conflict: true, current: body.current };
  }
  profiles[id] = { ...p, data: body, dirty: false, conflict: false, history: [p.data, ...(p.history || [])].slice(0, KEEP_HISTORY) };
  remoteVer[id] = body.version;
  await saveProfiles();
  return { ok: true, version: body.version };
}

function rollbackProfile(id) {
  const p = profiles[id];
  if (!p?.history?.length) return;
  const [prev, ...rest] = p.history;
  // 되돌린 내용은 로컬 수정으로 본다. 올리면 저장소에 새 버전으로 기록된다
  profiles[id] = { ...p, data: { ...prev, version: p.data.version }, dirty: true, history: rest };
  saveProfiles();
}

// 지시와 함께 호스트로 보내는 활성 프로필(계정 값은 로컬 값을 합친다)
function activeProfilePayload() {
  const p = profiles[activeId]?.data;
  if (!p) return null;
  return {
    id: p.id, version: p.version, name: p.name, target: p.target, deploy: p.deploy, prompt: p.prompt, knowledge: p.knowledge, claude: p.claude,
    tags: p.tags, ...(() => {
      const rs = roleSet(p);
      return {
        roles: rs.roles.map(({ account, ...r }) => r), default_role: rs.default_role, role_doc: rs.doc_id && `${rs.doc_id}@v${rs.version}`,
        accounts: rs.roles.map((r) => { const { def, ...a } = roleAccount(p.id, r); return a; }),
      };
    })(),
  };
}

function profileStatus(id) {
  const p = profiles[id];
  if (!p) return { text: '없음', cls: 'off' };
  if (p.conflict) return { text: `충돌 · 저장소 v${remoteVer[id]}`, cls: 'bad' };
  if (p.dirty) return { text: `v${p.data.version} · 내 수정 있음`, cls: 'warn' };
  if (remoteVer[id] > p.data.version) return { text: `v${p.data.version} · 새 버전 v${remoteVer[id]}`, cls: 'warn' };
  return { text: `v${p.data.version} · 최신`, cls: 'ok' };
}

function renderProfileChip() {
  const chip = document.getElementById('profile-chip');
  if (!chip) return;
  const p = profiles[activeId]?.data;
  const st = activeId ? profileStatus(activeId) : { cls: 'off' };
  chip.innerHTML = `<span class="pdot ${st.cls}"></span>${p ? esc(p.name) : '프로필 없음'}`;
  chip.title = p ? `${p.name} · ${st.text}${syncError ? ` · ${syncError}` : ''}` : syncError || '프로필 없음';
}

// 시트 안의 작은 단계: null | 'new'(새 프로필 만들기) | 'rollback'(되돌리기 확인)
let pfStep = null;
let pfNewError = '';
let pfNewVals = {}; // 새 프로필 입력값(검사에 걸려 다시 그려도 남게)

// 새 프로필: 서버(동기화 저장소)에 v1로 만든다. id는 대상 주소의 호스트 이름에서 만든다(겹치면 -2, -3…)
function newProfileForm() {
  const cur = profiles[activeId]?.data;
  return `<div class="pf-new">
    <div class="pf-new-h"><b>새 프로필</b><span class="pf-hint">이 PC의 임시 저장소에 v1로 만듭니다</span></div>
    <label class="pf-label">이름</label>
    <input class="pf-input" data-new="name" placeholder="예: 주문 관리 (스테이징)" autocomplete="off" value="${esc(pfNewVals.name || '')}">
    <label class="pf-label">대상 주소</label>
    <input class="pf-input mono" data-new="base_url" placeholder="https://staging.example.com" autocomplete="off" value="${esc(pfNewVals.base_url || '')}">
    <label class="pf-label">시작 URL <span class="pf-hint">선택. 대상 주소와 같은 도메인</span></label>
    <input class="pf-input mono" data-new="start_url" placeholder="https://staging.example.com/login" autocomplete="off" value="${esc(pfNewVals.start_url || '')}">
    ${cur ? `<label class="pf-check"><input type="checkbox" data-new="copy" ${pfNewVals.copy === false ? '' : 'checked'}> 지금 프로필(${esc(cur.name)})의 설정으로 시작 <span class="pf-hint">지식·태그·역할 문서·사이트 지식·정리 규칙을 복사합니다</span></label>` : ''}
    ${pfNewError ? `<div class="pf-alert">${esc(pfNewError)}</div>` : ''}
    <div class="pf-actions">
      <button type="button" class="btn sm primary" data-pf="new-create">만들기</button>
      <button type="button" class="btn sm" data-pf="new-cancel">취소</button>
    </div>
  </div>`;
}
async function createProfile(body) {
  const v = (k) => body.querySelector(`[data-new="${k}"]`)?.value.trim() || '';
  const name = v('name'), base = v('base_url'), start = v('start_url');
  const copy = body.querySelector('[data-new="copy"]')?.checked;
  pfNewVals = { name, base_url: base, start_url: start, copy };
  let host = '';
  try { host = new URL(base).hostname; } catch {}
  if (!name) pfNewError = '이름을 적어 주세요';
  else if (!host) pfNewError = '대상 주소를 http:// 또는 https://로 시작하는 주소로 적어 주세요';
  else if (start && (() => { try { return new URL(start).hostname !== host; } catch { return true; } })()) pfNewError = '시작 URL은 대상 주소와 같은 도메인이어야 합니다';
  else pfNewError = '';
  if (pfNewError) return renderSheet();
  const base0 = host.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
  let id = base0, n = 2;
  while (profiles[id] || remoteVer[id]) id = `${base0}-${n++}`;
  const src = copy ? profiles[activeId]?.data || {} : {};
  const { id: _i, version: _v, updated_at: _u, hash: _h, name: _n, target: srcTarget = {}, ...rest } = src;
  const data = {
    ...rest, name,
    knowledge: rest.knowledge || ['qa-common'], tags: rest.tags || 'qa-tags',
    target: { ...(copy ? { login_path: srcTarget.login_path } : {}), base_url: base, ...(start ? { start_url: start } : {}) },
  };
  try {
    const res = await fetch(`${SYNC}/profiles/${encodeURIComponent(id)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ base_version: 0, data }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) { pfNewError = `만들지 못했습니다: ${e.message}`; return renderSheet(); }
  await pullProfile(id, { quiet: true });
  activeId = id;
  pfStep = null;
  pfNewVals = {};
  await saveProfiles();
  renderProfileChip();
  renderSheet();
  msg('sys', `새 프로필 "${name}"을 만들었습니다(v1). 대상 도메인 ${host}`);
  changeDomainIfNeeded();
}

// 시트: 프로필 보기·수정
function renderProfileSheet(body) {
  $('sheet-title').textContent = '프로필';
  const p = profiles[activeId];
  if (!p || pfStep === 'new') {
    body.innerHTML = `<div class="pf">
      ${pfStep === 'new' ? newProfileForm() : `<div class="none">${syncError || '받은 프로필이 없습니다'}</div>`}
      ${pfStep === 'new' ? '' : `<div class="pf-actions" style="justify-content:center"><button type="button" class="btn sm" data-pf="sync">동기화</button><button type="button" class="btn sm" data-pf="new-open">+ 새 프로필</button></div>`}
    </div>`;
    return;
  }
  const d = p.data;
  const st = profileStatus(activeId);
  const acc = localAcc[d.id] || {};
  const rs = roleSet(d);
  body.innerHTML = `<div class="pf">
    <div class="pf-row">
      <select class="pf-select" data-pf="select">${Object.values(profiles).map((x) =>
        `<option value="${esc(x.data.id)}" ${x.data.id === activeId ? 'selected' : ''}>${esc(x.data.name)}</option>`).join('')}</select>
      <span class="pf-status ${st.cls}">${st.text}</span>
      <span class="grow"></span>
      <button type="button" class="btn sm" data-pf="new-open" title="새 대상 사이트의 프로필을 만듭니다">+ 새 프로필</button>
    </div>
    <div class="pf-actions">
      <button type="button" class="btn sm" data-pf="sync" title="이 PC의 임시 저장소에 새 버전이 있으면 받습니다">동기화</button>
      <button type="button" class="btn sm ${p.dirty ? 'primary' : ''}" data-pf="push" ${p.dirty ? '' : 'disabled'} title="고친 내용을 이 PC의 임시 저장소(spike/.koa/store)에 새 버전으로 저장합니다. 공유 서버가 없어 다른 PC로는 가지 않습니다">저장소에 저장${p.dirty ? ` (v${d.version} → v${d.version + 1})` : ''}</button>
      ${p.history?.length ? `<button type="button" class="btn sm" data-pf="rollback" title="받아 둔 이전 버전의 내용으로 되돌립니다">v${p.history[0].version}로 되돌리기</button>` : ''}
    </div>
    <div class="pf-hint pf-explain">${p.dirty
      ? `고친 내용은 이 확장에만 있습니다. <b>저장소에 저장</b>하면 이 PC의 임시 저장소에 v${d.version + 1}로 저장됩니다. 아직 공유 서버가 없어 다른 PC로는 가지 않습니다.`
      : '고친 내용은 바로 이 확장에 저장됩니다. <b>저장소에 저장</b>하면 이 PC의 임시 저장소에 새 버전으로 남습니다. 아직 공유 서버가 없어 다른 PC로는 가지 않습니다.'}</div>
    ${pfStep === 'rollback' && p.history?.length ? `<div class="pf-confirm">
      v${p.history[0].version}의 내용으로 되돌릴까요? 되돌린 내용은 '고친 내용'이 되어 이 확장에만 반영되고, 저장소에는 <b>저장소에 저장</b>을 눌러야 새 버전(v${d.version + 1})으로 저장됩니다.
      <div class="pf-actions"><button type="button" class="btn sm primary" data-pf="rollback-yes">되돌리기</button><button type="button" class="btn sm" data-pf="rollback-no">취소</button></div>
    </div>` : ''}
    ${p.conflict ? `<div class="pf-alert">저장소에 이 확장이 받은 것보다 새 버전(v${remoteVer[activeId]})이 있습니다.
      <button type="button" class="btn sm" data-pf="take-remote">저장소 버전 받기 (내 수정 버림)</button></div>` : ''}
    ${syncError ? `<div class="pf-alert">${syncError}</div>` : ''}

    <label class="pf-label">대상 주소 <span class="pf-hint">작업 데이터는 이 주소의 도메인(${esc(domainOf(d))})별로 저장됩니다</span></label>
    <input class="pf-input mono" data-field="target.base_url" value="${esc(d.target?.base_url ?? '')}">
    <label class="pf-label">시작 URL <span class="pf-hint">새 수행 기록은 이 주소에서 출발하고, 생성 코드도 여기서 시작합니다. 비우면 지금 탭 주소</span></label>
    <input class="pf-input mono" data-field="target.start_url" placeholder="${esc((d.target?.base_url || 'http://example.com').replace(/\/$/, '') + (d.target?.login_path || '/'))}" value="${esc(d.target?.start_url ?? '')}">
    ${startUrlWarning(d)}
    <label class="pf-label">배포 서버 <span class="pf-hint">테스트 목록의 <b>서버 전송</b>이 테스트 묶음을 보내는 곳. 비우면 서버 전송을 쓸 수 없습니다</span></label>
    <input class="pf-input mono" data-field="deploy.url" placeholder="https://qa-server.example.com  (이 PC의 임시 서버: http://127.0.0.1:8765)" value="${esc(d.deploy?.url ?? '')}">
    ${deployWarning(d)}

    <label class="pf-label">역할과 계정 <span class="pf-hint">${rs.doc_id ? `서버 역할 문서 ${esc(rs.doc_id)} v${rs.version ?? '?'}` : ''} · 바꾼 계정은 이 확장에만 저장됩니다</span></label>
    ${rs.roles.length ? '' : '<div class="pf-hint">역할 정보가 없습니다. 동기화하세요</div>'}
    ${rs.roles.map((r) => {
      const a = roleAccount(d.id, r);
      const mine = acc[a.key] || {};
      const src = { mine: '<span class="tag ok">내 계정</span>', server: '<span class="tag">서버 기본 계정</span>', none: '<span class="tag warn">계정 없음</span>' }[a.source];
      return `<div class="pf-acc">
      <div class="pf-acc-h"><span class="role-tag">${esc(r.label)}</span>${r.key === rs.default_role ? '<span class="tag">기본 역할</span>' : ''}${src}
        <span class="grow"></span>${a.source === 'mine' ? `<button type="button" class="btn sm ghost" data-pf="acc-reset" data-acc-key="${esc(a.key)}" ${a.def?.user ? '' : 'disabled'}>기본 계정으로</button>` : ''}</div>
      <div class="pf-hint pf-role-d">${esc(r.desc || '')} <span class="mono">$${esc(a.key)}_USER · _PASS</span></div>
      <div class="pf-acc-f">
        <input class="pf-input" placeholder="${a.def?.user ? `기본: ${esc(a.def.user)}` : '아이디'}" data-acc="${esc(a.key)}" data-k="user" value="${esc(a.source === 'mine' ? mine.user ?? '' : '')}" autocomplete="off">
        <input class="pf-input" placeholder="${a.def?.user ? '기본 비밀번호' : '비밀번호'}" type="password" data-acc="${esc(a.key)}" data-k="pass" value="${esc(a.source === 'mine' ? mine.pass ?? '' : '')}" autocomplete="new-password">
      </div></div>`;
    }).join('')}

    <label class="pf-label">사이트 지식 (AI에게 함께 전달)</label>
    <textarea class="pf-input pf-prompt mono" data-field="prompt" rows="12">${esc(d.prompt ?? '')}</textarea>
    <div class="pf-hint">저장소 v${remoteVer[activeId] ?? '?'} · 받은 시각 ${p.syncedAt ? new Date(p.syncedAt).toLocaleString() : '-'} · 보관된 이전 버전 ${p.history?.length || 0}개</div>
  </div>`;
}

// 배포 서버 주소 형식 확인
function deployWarning(d) {
  const u = d.deploy?.url;
  if (!u) return '';
  try { if (!/^https?:$/.test(new URL(u).protocol)) throw 0; return ''; } catch { return '<div class="pf-alert">배포 서버 주소는 http:// 또는 https://로 시작해야 합니다</div>'; }
}
// 서버 전송에 쓸 배포 서버(형식이 맞을 때만)
function deployServer() {
  const u = profiles[activeId]?.data?.deploy?.url?.trim();
  try { return u && /^https?:$/.test(new URL(u).protocol) ? u : null; } catch { return null; }
}

// 시작 URL은 대상 주소와 같은 도메인이어야 한다(다른 도메인이면 쓰지 않는다)
function startUrlWarning(d) {
  const u = d.target?.start_url;
  if (!u) return '';
  let h = '';
  try { h = new URL(u).hostname; } catch { return '<div class="pf-alert">시작 URL 형식이 올바르지 않습니다(http:// 또는 https://로 시작)</div>'; }
  return h === domainOf(d) ? '' : `<div class="pf-alert">시작 URL의 도메인(${esc(h)})이 대상 주소 도메인(${esc(domainOf(d))})과 달라 쓰지 않습니다</div>`;
}

// 시트 안의 입력·버튼 처리
let pfSaveTimer;
document.getElementById('sheet-body').addEventListener('input', (e) => {
  if (sheetMode !== 'profile') return;
  const p = profiles[activeId];
  if (!p) return;
  if (e.target.dataset.field) {
    const path = e.target.dataset.field.split('.');
    let o = p.data;
    for (const k of path.slice(0, -1)) o = o[k] ??= {};
    o[path.at(-1)] = e.target.value;
    p.dirty = true;
  }
  if (e.target.dataset.acc) {
    const id = p.data.id;
    localAcc[id] ??= {};
    localAcc[id][e.target.dataset.acc] = { ...localAcc[id][e.target.dataset.acc], [e.target.dataset.k]: e.target.value };
  }
  clearTimeout(pfSaveTimer);
  pfSaveTimer = setTimeout(() => {
    saveProfiles();
    renderProfileChip();
    renderRoleScope();
    const st = profileStatus(activeId);
    const el = document.querySelector('.pf-status');
    if (el) { el.textContent = st.text; el.className = `pf-status ${st.cls}`; }
    const push = document.querySelector('[data-pf=push]');
    if (push) push.disabled = !p.dirty;
  }, 300);
});
document.getElementById('sheet-body').addEventListener('change', (e) => {
  if (sheetMode === 'profile' && e.target.dataset.pf === 'select') {
    // 작업 중에 다른 도메인으로 바꾸면 기록이 섞이므로 막는다
    if (aiBusy && domainOf(profiles[e.target.value]?.data) !== viewDomain) {
      e.target.value = activeId;
      return msg('err', 'AI 작업 중에는 다른 도메인의 프로필로 바꿀 수 없습니다. 끝난 뒤 바꾸세요');
    }
    activeId = e.target.value;
    pfStep = null;
    saveProfiles();
    renderProfileChip();
    renderSheet();
    changeDomainIfNeeded();
  }
  // 대상 주소·시작 URL 입력을 마치면(포커스가 빠지면) 도메인을 다시 보고 경고를 갱신한다
  if (sheetMode === 'profile' && e.target.dataset.field === 'deploy.url') renderSheet();
  if (sheetMode === 'profile' && /^target\.(base_url|start_url)$/.test(e.target.dataset.field || '')) {
    if (aiBusy && activeDomain() !== viewDomain) msg('err', 'AI 작업이 끝나면 새 대상 주소의 도메인으로 바뀝니다. 끝난 뒤 다시 입력을 마치세요');
    else changeDomainIfNeeded();
    renderSheet();
  }
});
document.getElementById('sheet-body').addEventListener('click', async (e) => {
  if (sheetMode !== 'profile') return;
  const act = e.target.closest('[data-pf]')?.dataset.pf;
  if (!act || act === 'select') return;
  if (act === 'new-open') { pfStep = 'new'; pfNewError = ''; pfNewVals = {}; return renderSheet(); }
  if (act === 'new-cancel') { pfStep = null; pfNewError = ''; pfNewVals = {}; return renderSheet(); }
  if (act === 'new-create') return createProfile(document.getElementById('sheet-body'));
  if (act === 'rollback') { pfStep = 'rollback'; return renderSheet(); }
  if (act === 'rollback-no') { pfStep = null; return renderSheet(); }
  if (act === 'sync') await syncProfiles();
  if (act === 'push') {
    const r = await pushProfile(activeId);
    if (r.ok) msg('sys', `프로필을 이 PC의 임시 저장소에 저장했습니다(v${r.version})`);
  }
  if (act === 'take-remote') { profiles[activeId].dirty = false; await pullProfile(activeId); await saveProfiles(); }
  if (act === 'rollback-yes') { pfStep = null; rollbackProfile(activeId); msg('sys', '프로필을 이전 버전의 내용으로 되돌렸습니다. 저장소에 저장해야 저장소에도 반영됩니다'); }
  if (act === 'acc-reset') { delete localAcc[activeId]?.[e.target.closest('[data-acc-key]').dataset.accKey]; await saveProfiles(); }
  renderProfileChip();
  renderSheet();
  if (!aiBusy) changeDomainIfNeeded(); // 동기화·이전 버전·저장소 버전 받기로 대상 주소가 바뀌었을 수 있다
});
document.getElementById('profile-chip').onclick = () => { pfStep = null; pfNewError = ''; openSheet('profile'); };

// 처음: 프로필 → 그 도메인의 타임라인·테스트 목록 → 호스트 연결(연결되면 동기화)
loadProfiles().then(restoreDomainData).finally(connect);
