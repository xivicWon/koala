// 프로필 칩·프로필 시트: 프로필 목록(서버 프로필 / 이 PC 전용 프로필), 받기, 프로필 바꾸기, 받은 정의(읽기 전용), 내 설정.
// 상태와 내 설정은 profile.js. 프로필 정의를 받고 만드는 일은 호스트가 한다(set_receive · set_create_local · set_update_local · set_delete)
let setStep = null;      // 시트 안의 작은 단계: null | 'new' | 'edit' | 'delete'
let setFormError = '';
let setFormVals = {};    // 새 프로필·고치기 입력값(검사에 걸려 다시 그려도 남게)
let setSentOnOpen = false; // 이번 연결에서 호스트에 지금 프로필을 알렸는지
let setAi = { open: false, set: null, text: '' }; // 'AI에게 전달되는 내용' 펼침 상태와 호스트가 준 내용

// 펼칠 때마다 호스트에서 지금 내용을 받는다(내 설정을 고쳤으면 바로 반영된 것을 본다)
document.getElementById('sheet-body').addEventListener('toggle', async (e) => {
  // 펼친 채로 다시 그려도 toggle 이 오므로, 닫힘 → 펼침으로 바뀔 때만 받는다
  if (sheetMode !== 'set' || !e.target.matches?.('details.set-ai') || setAi.open === e.target.open) return;
  setAi.open = e.target.open;
  if (!setAi.open) return;
  try {
    const r = await fetch('http://127.0.0.1:8765/profile/context');
    const j = await r.json();
    setAi = { open: true, set: j.set, text: j.text };
  } catch { setAi = { open: true, set: activeSet, text: '호스트와 연결되어 있지 않아 불러오지 못했습니다' }; }
  if (sheetMode === 'set') renderSheet();
}, true);

// '프로필 폴더' 카드의 'AI 에게 전달하는 파일': 펼칠 때 호스트에서 층별 목록을 받는다
let setFiles = { open: false, data: null };
function filesList() {
  const d = setFiles.data;
  if (!d) return '<div class="pf-hint">불러오는 중…</div>';
  if (d.error) return `<div class="pf-alert">${esc(d.error)}</div>`;
  const group = (title, list, empty) => `<div class="set-files-g"><b>${title}</b>${list.length ? list.map((f) => `<code class="cs-code mono">${esc(f)}</code>`).join('') : `<span class="pf-hint">${empty}</span>`}</div>`;
  return group('koala 기본(업데이트로 바뀜, 고치지 않음)', d.layers.koala, '없음')
    + group(`사용자 레벨 · ${esc(shortPath(d.user))}`, d.layers.user, '없음 · 이 폴더에 .md 파일을 두면 모든 프로필에 쓰입니다')
    + group(`이 프로필 · ${esc(shortPath(d.folder))}`, d.layers.project, '없음');
}
document.getElementById('sheet-body').addEventListener('toggle', async (e) => {
  if (sheetMode !== 'set' || !e.target.matches?.('details.set-files') || setFiles.open === e.target.open) return;
  setFiles.open = e.target.open;
  if (!setFiles.open) return;
  try { setFiles.data = await (await fetch('http://127.0.0.1:8765/profile/files')).json(); } catch { setFiles.data = { error: '호스트와 연결되어 있지 않아 불러오지 못했습니다' }; }
  if (sheetMode === 'set') renderSheet();
}, true);

// '프로필 규칙' 카드: 프로필 화면을 열거나 AI가 규칙을 저장하면 호스트에서 목록을 다시 받는다
let setRules = { set: null, dir: '', files: null, open: {} }; // open: 펼친 파일 이름
async function loadSetRules() {
  try {
    const j = await (await fetch('http://127.0.0.1:8765/rules')).json();
    setRules = { ...setRules, set: j.set, dir: j.dir || '', files: j.files || [] };
  } catch { setRules = { ...setRules, set: activeSet, files: [], error: '호스트와 연결되어 있지 않아 불러오지 못했습니다' }; }
  if (sheetMode === 'set') renderSheet();
}
// 파일 내용 펼침 상태는 다시 그려도 유지한다(닫힘 ↔ 펼침이 바뀔 때만 기록)
document.getElementById('sheet-body').addEventListener('toggle', (e) => {
  const f = sheetMode === 'set' && e.target.matches?.('details.set-rule') && e.target.dataset.rule;
  if (f && !!setRules.open[f] !== e.target.open) setRules.open[f] = e.target.open;
}, true);
function rulesCardBody() {
  if (setRules.set !== activeSet || setRules.files === null) return '<div class="pf-hint">불러오는 중…</div>';
  const files = setRules.files;
  return `${setRules.error ? `<div class="pf-alert">${esc(setRules.error)}</div>` : ''}
    <code class="cs-code mono set-rules-dir">${esc(setRules.dir)}</code>
    <div class="pf-actions set-map"><button type="button" class="btn sm" data-set-act="rules-open">폴더 열기</button><button type="button" class="btn sm" data-set-act="rules-reload">새로고침</button></div>
    ${files.length ? files.map((f) => `<details class="set-rule" data-rule="${esc(f.name)}" ${setRules.open[f.name] ? 'open' : ''}><summary><span class="mono">${esc(f.name)}</span> <span class="pf-hint">${esc(f.title)}</span></summary>
      <pre class="pf-ro pf-prompt-ro mono">${esc(f.text)}</pre></details>`).join('')
    : '<div class="pf-hint set-map-d">아직 규칙이 없습니다. 채팅으로 "이건 규칙으로 남겨"라고 하거나, 테스트를 고치다 사이트 고유 동작이 확인되면 AI가 남깁니다. 폴더에 .md 파일을 직접 넣어도 됩니다.</div>'}`;
}

// 프로필을 바꾸거나 받을 수 없는 이유(없으면 '')
function setBlockReason() {
  if (migrationNeeded) return '기존 데이터를 프로필로 옮긴 뒤 쓸 수 있습니다';
  if (!hostUp) return '호스트가 꺼져 있습니다. 호스트에 연결되면 할 수 있습니다';
  if (aiBusy || (typeof jobNow !== 'undefined' && jobNow && !jobNow.done) || suite?.code?.running) return 'AI 작업이나 테스트 실행 중에는 프로필을 바꾸거나 받을 수 없습니다. 끝난 뒤 다시 누르세요';
  return '';
}
const testCount = (s) => (s.tests ? s.tests.scenarios + s.tests.cases : null);

function renderSetChip() {
  const chip = document.getElementById('set-chip');
  if (!chip) return;
  const s = setInfo();
  const upd = setList.filter((x) => x.received && x.update);
  const st = !s ? 'off' : !s.received ? 'warn' : 'ok';
  chip.innerHTML = `<span class="pdot ${st}"></span><span class="set-chip-name">${s ? esc(s.name) : '프로필 없음'}</span>${upd.length ? '<span class="set-upd" aria-label="새 판 있음"></span>' : ''}`;
  const tip = [s ? `${s.name} · ${s.path || ''}` : '프로필을 고르세요',
    upd.length ? `새 판 있음 · ${upd.map((x) => x.name).join(', ')}` : '', !hostUp && setList.length ? '호스트가 꺼져 있어 마지막으로 받은 목록입니다' : ''].filter(Boolean).join('\n');
  chip.title = tip;
  if (chip.dataset.tip !== undefined) chip.dataset.tip = tip; // 빠른 툴팁이 title 을 옮겨 둔 뒤에도 갱신
}

// 보내는 서버(out: 테스트 묶음을 보내는 곳)가 있는지. 받는 서버(in)는 아직 없다(공사 중)
const serverTags = (s) => `<span class="io ${s.deploy_url ? 'on' : 'off'}" title="${s.deploy_url ? esc(s.deploy_url) : '보내는 서버 없음(.koala/settings.json 의 deploy_url)'}">보내는 서버 ${s.deploy_url ? '있음' : '없음'}</span>`
  + (s.receive_url ? `<span class="io on" title="${esc(s.receive_url)}">받는 서버 있음</span>` : '');
const shortPath = (p) => String(p || '').replace(/^(\/(Users|home)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, '~');
function setRow(s, why) {
  const on = s.id === activeSet;
  const n = testCount(s);
  const pickTip = why && !on ? why : on ? '지금 프로필' : '이 프로필로 바꿉니다. 타임라인·테스트 목록·세션이 이 프로필 것으로 바뀝니다';
  return `<div class="set-row ${on ? 'on' : ''}" data-set-row="${esc(s.id)}">
    <button type="button" class="set-pick" data-set-act="pick" data-set-id="${esc(s.id)}" ${why && !on ? 'disabled' : ''} title="${esc(pickTip)}">
      <span class="set-row-name">${esc(s.name)}</span>
      <span class="set-row-meta mono">${esc(s.domain === 'default' ? '대상 주소 없음' : s.domain || '-')}${n === null ? '' : ` · 테스트 ${n}`} · ${esc(shortPath(s.path))}</span>
      <span class="set-io">${serverTags(s)}</span>
    </button>
    <span class="set-row-st">${on ? '<span class="tag ok">지금</span>' : ''}</span>
  </div>`;
}

function renderSetSheet(body) {
  $('sheet-title').textContent = '프로필';
  if (setStep === 'new' && body.querySelector('[data-new]')) captureSetForm(body); // 작업 상태가 바뀌어 다시 그려도 입력값을 잃지 않게
  const why = setBlockReason();
  const s = setInfo();
  body.innerHTML = `<div class="pf set-sheet">
    ${migrationNeeded ? `<div class="pf-alert">${esc(migrationText())}</div>` : ''}
    ${!hostUp ? `<div class="pf-alert">호스트가 꺼져 있습니다. ${setList.length ? '마지막 목록을 보여 줍니다. ' : ''}만들기·바꾸기는 호스트에 연결되면 할 수 있습니다</div>` : ''}
    <section class="set-list" aria-label="프로필 목록">
      <div class="set-zone-h"><b>프로필 목록</b><span class="pf-hint">~/koala-profiles/ 의 폴더 하나가 프로필 하나입니다</span></div>
      ${setList.map((x) => setRow(x, why)).join('') || '<div class="pf-hint set-none">프로필이 없습니다</div>'}
      <div class="set-list-act"><button type="button" class="btn sm" data-set-act="new-open" ${migrationNeeded || !hostUp ? 'disabled' : ''}>+ 새 프로필</button></div>
      ${setStep === 'new' ? setForm('new') : ''}
    </section>
    ${s ? setDetail(s, why) : `<div class="none">${setList.length ? '프로필을 고르세요' : hostUp ? '프로필이 없습니다. + 새 프로필로 만드세요' : '호스트에 연결되면 프로필 목록을 불러옵니다'}</div>`}
  </div>`;
}

const roBox = (v, empty = '없음') => `<div class="pf-ro mono">${v ? esc(v) : `<span class="pf-hint">${empty}</span>`}</div>`;

// 카드 하나: 제목 + 이 정보가 어디서 오고 어디에 저장되는지(경계)
const setCard = (title, scope, body) => `<section class="set-card"><header class="set-card-h"><b>${title}</b><span class="set-scope">${scope}</span></header><div class="set-card-b">${body}</div></section>`;

// 고른 프로필: 머리(이름·폴더 열기·지우기) → 카드 — 프로필 폴더(파일에서 읽은 값·읽는 파일) · 내 설정(이 확장) · 규칙 · 메뉴 경로 지도
function setDetail(s, why) {
  const pref = prefOf(s.id);
  const roles = s.roles || [];
  const active = s.id === activeSet;
  return `<div class="set-detail">
    <div class="set-detail-k">${active ? '지금 프로필' : '고른 프로필'}</div>
    <div class="set-detail-h"><b>${esc(s.name)}</b><span class="grow"></span>
      <button type="button" class="btn sm" data-set-act="folder-open" ${hostUp ? '' : 'disabled'} title="프로필 폴더를 엽니다. 정의는 이 폴더의 파일을 고칩니다">폴더 열기</button>
      <button type="button" class="btn sm danger-text" data-set-act="delete" ${hostUp && !why ? '' : 'disabled'} title="${esc(why || '프로필 폴더와 작업 데이터를 함께 ~/koala-profiles/.deleted/ 로 옮깁니다')}">지우기</button></div>
    ${setStep === 'delete' ? `<div class="pf-confirm">프로필 "${esc(s.name)}"를 지울까요? 프로필 폴더(KOALA.md·설정·규칙)와 작업 데이터(테스트·수행 기록·메뉴 지도)를 함께 ~/koala-profiles/.deleted/ 로 옮깁니다. 되살리려면 그 폴더를 다시 ~/koala-profiles/ 로 옮기면 됩니다.
      <div class="pf-actions"><button type="button" class="danger sm" data-set-act="delete-yes">지우기</button><button type="button" class="btn sm" data-set-act="delete-no">취소</button></div></div>` : ''}
    ${setCard('프로필 폴더', '정의는 이 폴더의 파일 · 고치려면 폴더 열기', `
    <code class="cs-code mono set-rules-dir">${esc(s.path || '')}</code>
    <label class="pf-label">대상 주소 <span class="pf-hint">.koala/settings.json 의 base_url · 대상 탭이 이 도메인(${esc(domainOf(s))})이 아니면 실행 전에 묻습니다</span></label>
    ${roBox(s.base_url, '없음 · .koala/settings.json 의 base_url 에 넣으세요')}
    <label class="pf-label">시작 <span class="pf-hint">.koala/settings.json 의 start_path</span></label>
    ${roBox(s.start_url || s.login_path, '/')}
    <label class="pf-label">보내는 서버 <span class="pf-hint">.koala/settings.json 의 deploy_url</span></label>
    ${roBox(s.deploy_url, '없음')}
    <label class="pf-label">역할 <span class="pf-hint">.koala/settings.json 의 roles</span></label>
    <div class="set-chips">${roles.map((r) => `<span class="role-tag" title="${esc(r.desc)}">${esc(r.label)}${r.key === s.default_role ? ' · 기본' : ''}</span>`).join('') || '<span class="pf-hint">역할이 없습니다</span>'}</div>
    ${active ? `<details class="set-files" ${setFiles.open ? 'open' : ''}><summary>AI 에게 전달하는 파일 <span class="pf-hint">koala 기본 · 사용자 레벨 · 이 프로필 폴더</span></summary>${filesList()}</details>` : ''}
    <div class="pf-hint set-when">테스트 BDD ${s.tests?.scenarios ?? 0} · TDD ${s.tests?.cases ?? 0}</div>`)}

    ${setCard('내 설정', '이 확장에만 저장 · 고를 때 이 PC 호스트로만 보냄', `
    <label class="pf-label">시작 URL ${pref.start_url ? '<span class="tag ok">내 설정</span>' : '<span class="tag">프로필 값</span>'}
      <span class="pf-hint">새 수행 기록은 이 주소에서 출발합니다. 비우면 ${s.start_url ? '프로필 값' : '지금 탭 주소'}</span></label>
    <div class="pf-pref"><input class="pf-input mono" data-pref="start_url" placeholder="${esc(s.start_url || (s.base_url || '').replace(/\/$/, '') + (s.login_path || '/'))}" value="${esc(pref.start_url ?? '')}">
      ${pref.start_url ? '<button type="button" class="btn sm" data-set-act="pref-reset">프로필 값으로</button>' : ''}</div>
    ${startUrlWarning(startUrlOf(s.id), s)}
    <label class="pf-label">역할과 계정 <span class="pf-hint">비우면 서버 기본 계정</span></label>
    ${roles.length ? '' : '<div class="pf-hint">역할이 없어 계정을 넣을 수 없습니다</div>'}
    ${roles.map((r) => {
      const a = roleAccount(s.id, r);
      const mine = pref.accounts?.[a.key] || {};
      const src = { mine: '<span class="tag ok">내 계정</span>', server: '<span class="tag">서버 기본 계정</span>', none: '<span class="tag warn">계정 없음</span>' }[a.source];
      return `<div class="pf-acc">
      <div class="pf-acc-h"><span class="role-tag">${esc(r.label)}</span>${r.key === s.default_role ? '<span class="tag">기본 역할</span>' : ''}${src}
        <span class="grow"></span>${a.source === 'mine' && r.has_default ? `<button type="button" class="btn sm ghost" data-set-act="acc-reset" data-acc-key="${esc(a.key)}">기본 계정으로</button>` : ''}</div>
      <div class="pf-hint pf-role-d">${esc(r.desc || '')} <span class="mono">$${esc(a.key)}_USER · _PASS</span></div>
      <div class="pf-acc-f">
        <input class="pf-input" placeholder="${r.has_default ? '서버 기본 계정 사용' : '아이디'}" data-acc="${esc(a.key)}" data-k="user" value="${esc(mine.user ?? '')}" autocomplete="off">
        <input class="pf-input" placeholder="비밀번호" type="password" data-acc="${esc(a.key)}" data-k="pass" value="${esc(mine.pass ?? '')}" autocomplete="new-password">
      </div></div>`;
    }).join('')}`)}

    ${s.id === activeSet ? setCard('프로필 규칙', '프로필 폴더 .koala/rules/ · AI 가 새 파일로 남기고 지시마다 읽음', rulesCardBody()) : ''}

    ${s.id === activeSet ? setCard('지시마다 붙는 내용', '프로필 폴더의 값 + 내 설정으로 만듦', `
    <details class="set-ai" ${setAi.open ? 'open' : ''}><summary>펼쳐서 보기 <span class="pf-hint">대상 서비스 · 역할과 계정(값은 이름으로만)</span></summary>
      <pre class="pf-ro pf-prompt-ro mono">${esc(setAi.set === s.id ? setAi.text || '(없음)' : '불러오는 중…')}</pre></details>`) : ''}

    ${s.id === activeSet ? setCard('메뉴 경로 지도', '작업 데이터 · 프로필 폴더 .koala-work/map/', `
    <div class="pf-actions set-map"><button type="button" class="btn sm" data-set-act="map-open">지도 보기</button>
      <button type="button" class="btn sm" data-set-act="crawl" ${why ? 'disabled' : ''} title="${esc(why || 'AI 없이 작업 탭에서 보이는 메뉴를 모두 눌러 지도를 채웁니다')}">메뉴 전체 돌기</button>
      <button type="button" class="btn sm" data-set-act="crawl-rows" ${why ? 'disabled' : ''} title="${esc(why || '메뉴마다 목록의 첫 행을 눌러 상세 화면이 어떻게 열리는지도 봅니다')}">목록 상세까지 돌기</button></div>
    <div class="pf-hint set-map-d">지나간 메뉴와 화면을 쌓습니다. 돌기는 AI 없이 로그인한 작업 탭에서 돌고, 데이터를 바꾸는 버튼·로그아웃은 누르지 않습니다.</div>`) : ''}
  </div>`;
}

// 시작 URL은 대상 주소와 같은 도메인이어야 한다(다른 도메인이면 호스트가 쓰지 않는다)
function startUrlWarning(u, s) {
  if (!u) return '';
  let h = '';
  try { h = new URL(u).hostname; } catch { return '<div class="pf-alert">시작 URL 형식이 올바르지 않습니다(http:// 또는 https://로 시작)</div>'; }
  return h === domainOf(s) ? '' : `<div class="pf-alert">시작 URL의 도메인(${esc(h)})이 대상 주소 도메인(${esc(domainOf(s))})과 달라 쓰지 않습니다</div>`;
}

// 새 프로필·고치기 입력(이 PC 전용 프로필)
function setForm(kind, s = null, why = '') {
  const v = (k, d = '') => esc(setFormVals[k] ?? d);
  return `<div class="pf-new">
    <div class="pf-new-h"><b>새 프로필</b><span class="pf-hint">~/koala-profiles/ 에 폴더와 기본 파일을 만듭니다</span></div>
    <label class="pf-label">이름</label>
    <input class="pf-input" data-new="name" placeholder="예: shop-staging" autocomplete="off" value="${v('name')}">
    <label class="pf-label">대상 주소 <span class="pf-hint">선택 · 나중에 .koala/settings.json 에서 고쳐도 됩니다</span></label>
    <input class="pf-input mono" data-new="base_url" placeholder="https://svc-a.example" autocomplete="off" value="${v('base_url')}">
    ${setFormError ? `<div class="pf-alert">${esc(setFormError)}</div>` : ''}
    <div class="pf-actions">
      <button type="button" class="primary sm" data-set-act="new-save" ${why ? 'disabled' : ''} title="${esc(why)}">만들기</button>
      <button type="button" class="btn sm" data-set-act="new-cancel">취소</button>
    </div>
  </div>`;
}
function captureSetForm(body) {
  const v = (k) => body.querySelector(`[data-new="${k}"]`)?.value.trim();
  setFormVals = { name: v('name') || '', base_url: v('base_url') || '' };
  return setFormVals;
}
function readSetForm(body) {
  const vals = captureSetForm(body);
  setFormError = !vals.name ? '이름을 적어 주세요'
    : vals.base_url && (() => { try { return !/^https?:$/.test(new URL(vals.base_url).protocol); } catch { return true; } })() ? '대상 주소는 http:// 또는 https://로 시작해야 합니다'
    : '';
  return setFormError ? null : vals;
}

// 프로필 바꾸기: 지금 화면을 저장하고 그 프로필의 타임라인으로 바꾼 뒤 호스트에 알린다(호스트가 테스트 목록·세션을 바꿔 보낸다)
async function switchSet(id) {
  if (id === activeSet && id === viewSet) return;
  activeSet = id;
  setStep = null;
  chrome.storage.local.set({ activeSet: id }).catch(() => {});
  renderSetChip();
  renderRoleScope();
  await changeSetView(id);
  sendSetToHost();
  if (sheetMode === 'set') renderSheet();
}

// 호스트의 프로필 목록: 연결할 때·받기/만들기/지우기 뒤·1분마다 온다
async function onSets(m) {
  setList = Array.isArray(m.sets) ? m.sets : [];
  chrome.storage.local.set({ setsCache: setList }).catch(() => {});
  if (m.created) { setStep = null; setFormVals = {}; await switchSet(m.created); }
  // 지금 프로필이 없어졌거나(지움) 받지 않은 상태가 됐거나(받은 서버 프로필을 이 PC에서 지움) 아직 고르지 않았으면 받은 프로필 중 첫 번째로
  // 예전 데이터를 옮기기 전에는 고르지 않는다(옮긴 뒤 예전 활성 프로필의 프로필로 바꾼다)
  if (!migrationNeeded && (!activeSet || !setInfo() || !setInfo().received)) {
    const next = setList.find((s) => s.received)?.id || null;
    if (next !== activeSet) await switchSet(next);
  }
  if (!setSentOnOpen) setSentOnOpen = sendSetToHost();
  renderSetChip();
  renderRoleScope();
  renderSetTip();
  if (sheetMode === 'set' && !document.activeElement?.closest?.('#sheet-body input, #sheet-body textarea')) renderSheet();
}
function onSetActive(m) {
  if (m.id !== activeSet) return;
  renderSetTip();
}

// 시트 안의 입력·버튼 처리
let setPrefTimer;
document.getElementById('sheet-body').addEventListener('input', (e) => {
  if (sheetMode !== 'set' || !activeSet) return;
  const t = e.target;
  if (t.dataset.pref) {
    const next = { ...prefOf(activeSet), [t.dataset.pref]: t.value.trim() };
    if (!next[t.dataset.pref]) delete next[t.dataset.pref];
    setPrefs[activeSet] = next;
  }
  if (t.dataset.acc) {
    const p = prefOf(activeSet);
    const accounts = { ...p.accounts, [t.dataset.acc]: { ...p.accounts?.[t.dataset.acc], [t.dataset.k]: t.value } };
    if (!accounts[t.dataset.acc].user && !accounts[t.dataset.acc].pass) delete accounts[t.dataset.acc];
    setPrefs[activeSet] = { ...p, accounts };
  }
  if (!t.dataset.pref && !t.dataset.acc) return;
  clearTimeout(setPrefTimer);
  setPrefTimer = setTimeout(() => { saveSetPrefs(); renderSetChip(); renderRoleScope(); }, 300);
});
// 입력을 마치면(포커스가 빠지면) 저장하고 호스트에도 알린다(호스트는 내 설정으로 계정·시작 URL을 바꾼다)
document.getElementById('sheet-body').addEventListener('change', (e) => {
  if (sheetMode !== 'set' || !(e.target.dataset.pref || e.target.dataset.acc)) return;
  clearTimeout(setPrefTimer);
  saveSetPrefs();
  renderRoleScope();
  sendSetToHost();
  if (e.target.dataset.pref) renderSheet();
});
document.getElementById('sheet-body').addEventListener('click', async (e) => {
  if (sheetMode !== 'set') return;
  const btn = e.target.closest('[data-set-act]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.setAct;
  const id = btn.dataset.setId;
  const body = document.getElementById('sheet-body');
  const why = setBlockReason();
  if (act === 'pick') {
    if (id === activeSet) return;
    if (why) return msg('err', why);
    return switchSet(id);
  }
  if (act === 'map-open') return openMenuMap();
  if (act === 'rules-open') return ws.send(JSON.stringify({ type: 'open_rules' }));
  if (act === 'rules-reload') { setRules.files = null; renderSheet(); return loadSetRules(); }
  if (act === 'crawl' || act === 'crawl-rows') {
    if (why) return msg('err', why);
    closeSheet();
    return ws.send(JSON.stringify({ type: 'crawl', rows: act === 'crawl-rows' }));
  }
  if (act === 'new-open') { setStep = 'new'; setFormError = ''; setFormVals = {}; return renderSheet(); }
  if (act === 'new-cancel' || act === 'delete-no') { setStep = null; setFormError = ''; setFormVals = {}; return renderSheet(); }
  if (act === 'new-save') {
    const vals = readSetForm(body);
    if (!vals) return renderSheet();
    if (ws?.readyState !== 1) return msg('err', '호스트와 연결되어 있지 않습니다');
    ws.send(JSON.stringify({ type: 'set_create_local', def: { name: vals.name, base_url: vals.base_url } }));
    return; // 호스트가 sets{created} 로 답하면 그 프로필로 바꾼다
  }
  if (act === 'folder-open') return ws.send(JSON.stringify({ type: 'open_profile', id: setInfo()?.id }));
  if (act === 'delete') { setStep = 'delete'; return renderSheet(); }
  if (act === 'delete-yes') {
    const s = setInfo();
    if (!s) return;
    if (why) return msg('err', why);
    ws.send(JSON.stringify({ type: 'set_delete', id: s.id }));
    delete setPrefs[s.id];
    saveSetPrefs();
    chrome.storage.local.remove(timelineKey(s.id)).catch(() => {});
    setStep = null;
    return; // 호스트가 sets 로 답하면 다른 프로필로 바꾼다
  }
  if (act === 'pref-reset') { const next = { ...prefOf(activeSet) }; delete next.start_url; setPrefs[activeSet] = next; }
  if (act === 'acc-reset') { const p = prefOf(activeSet); const accounts = { ...p.accounts }; delete accounts[btn.dataset.accKey]; setPrefs[activeSet] = { ...p, accounts }; }
  if (act === 'pref-reset' || act === 'acc-reset') { saveSetPrefs(); sendSetToHost(); renderRoleScope(); renderSheet(); }
});
document.getElementById('set-chip').onclick = () => { setStep = null; setFormError = ''; openSheet('set'); loadSetRules(); };
