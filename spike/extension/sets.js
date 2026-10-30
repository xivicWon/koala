// 세트 칩·세트 시트: 세트 목록(서버 세트 / 이 PC 전용 세트), 받기, 세트 바꾸기, 받은 정의(읽기 전용), 내 설정.
// 상태와 내 설정은 profile.js. 세트 정의를 받고 만드는 일은 호스트가 한다(set_receive · set_create_local · set_update_local · set_delete)
let setStep = null;      // 시트 안의 작은 단계: null | 'new' | 'edit' | 'delete'
let setFormError = '';
let setFormVals = {};    // 새 세트·고치기 입력값(검사에 걸려 다시 그려도 남게)
let setWipSync = false;  // 받기를 눌렀으면 임시 저장소에서 받는다는 공사 표지판을 보여 준다
let setSentOnOpen = false; // 이번 연결에서 호스트에 지금 세트를 알렸는지

// 세트를 바꾸거나 받을 수 없는 이유(없으면 '')
function setBlockReason() {
  if (migrationNeeded) return '기존 데이터를 세트로 옮긴 뒤 쓸 수 있습니다';
  if (!hostUp) return '호스트가 꺼져 있습니다. 호스트에 연결되면 할 수 있습니다';
  if (aiBusy || (typeof jobNow !== 'undefined' && jobNow && !jobNow.done) || suite?.code?.running) return 'AI 작업이나 테스트 실행 중에는 세트를 바꾸거나 받을 수 없습니다. 끝난 뒤 다시 누르세요';
  return '';
}
const testCount = (s) => (s.tests ? s.tests.scenarios + s.tests.cases : null);

function renderSetChip() {
  const chip = document.getElementById('set-chip');
  if (!chip) return;
  const s = setInfo();
  const upd = setList.filter((x) => x.received && x.update);
  const st = !s ? 'off' : !s.received ? 'warn' : 'ok';
  chip.innerHTML = `<span class="pdot ${st}"></span><span class="set-chip-name">${s ? esc(s.name) : '세트 없음'}</span>${upd.length ? '<span class="set-upd" aria-label="새 판 있음"></span>' : ''}`;
  const tip = [s ? `${s.name} · ${s.source === 'local' ? '이 PC 전용' : `서버 v${s.version}`}${s.received ? '' : ' · 받지 않음'}` : '세트를 고르세요',
    upd.length ? `새 판 있음 · ${upd.map((x) => x.name).join(', ')}` : '', !hostUp && setList.length ? '호스트가 꺼져 있어 마지막으로 받은 목록입니다' : ''].filter(Boolean).join('\n');
  chip.title = tip;
  if (chip.dataset.tip !== undefined) chip.dataset.tip = tip; // 빠른 툴팁이 title 을 옮겨 둔 뒤에도 갱신
}

function setRow(s, why) {
  const on = s.id === activeSet;
  const n = testCount(s);
  const recv = (!s.received || s.update) && s.source !== 'local';
  const pickTip = !s.received ? '먼저 받기를 누르세요' : why || (on ? '지금 세트' : '이 세트로 바꿉니다. 타임라인·테스트 목록·세션이 이 세트 것으로 바뀝니다');
  return `<div class="set-row ${on ? 'on' : ''}" data-set-row="${esc(s.id)}">
    <button type="button" class="set-pick" data-set-act="pick" data-set-id="${esc(s.id)}" ${!s.received || (why && !on) ? 'disabled' : ''} title="${esc(pickTip)}">
      <span class="set-row-name">${esc(s.name)}</span>
      <span class="set-row-meta mono">${esc(s.domain || '-')} · v${esc(s.version)}${n === null ? '' : ` · 테스트 ${n}`}</span>
    </button>
    <span class="set-row-st">${on ? '<span class="tag ok">지금</span>' : ''}${!s.received ? '<span class="tag">받지 않음</span>' : s.update ? `<span class="tag warn" title="${esc(s.update.changed.join('\n'))}">새 판 v${esc(s.update.to)}</span>` : ''}
      ${recv ? `<button type="button" class="btn sm" data-set-act="receive" data-set-id="${esc(s.id)}" ${why ? 'disabled' : ''} title="${esc(why || (s.received ? '새 판으로 받습니다. Claude 작업 폴더를 다시 만듭니다' : '서버(지금은 이 PC의 임시 저장소)에서 받습니다'))}">받기</button>` : ''}</span>
  </div>`;
}

function renderSetSheet(body) {
  $('sheet-title').textContent = '세트';
  if ((setStep === 'new' || setStep === 'edit') && body.querySelector('[data-new]')) captureSetForm(body); // 작업 상태가 바뀌어 다시 그려도 입력값을 잃지 않게
  const why = setBlockReason();
  const server = setList.filter((s) => s.source !== 'local');
  const local = setList.filter((s) => s.source === 'local');
  const s = setInfo();
  body.innerHTML = `<div class="pf set-sheet">
    ${migrationNeeded ? `<div class="pf-alert">${esc(migrationText())}</div>` : ''}
    ${!hostUp ? `<div class="pf-alert">호스트가 꺼져 있습니다. ${setList.length ? '마지막으로 받은 목록을 보여 줍니다. ' : ''}받기·바꾸기는 호스트에 연결되면 할 수 있습니다</div>` : ''}
    ${setWipSync ? wipSign('sync', { compact: true }) : ''}
    <div class="set-group-h"><b>서버 세트</b><span class="pf-hint">서버에서 받아 씁니다</span></div>
    ${server.map((x) => setRow(x, why)).join('') || '<div class="pf-hint set-none">서버 세트가 없습니다</div>'}
    <div class="set-group-h"><b>이 PC 전용 세트</b><span class="pf-hint">서버에 없는 사이트를 시험할 때</span><span class="grow"></span>
      <button type="button" class="btn sm" data-set-act="new-open" ${migrationNeeded || !hostUp ? 'disabled' : ''}>+ 새 세트</button></div>
    ${local.map((x) => setRow(x, why)).join('') || (setStep === 'new' ? '' : '<div class="pf-hint set-none">없습니다</div>')}
    ${setStep === 'new' ? setForm('new') : ''}
    ${s ? setDetail(s, why) : `<div class="none">${setList.length ? '세트를 고르세요' : hostUp ? '받을 수 있는 세트가 없습니다' : '호스트에 연결되면 세트 목록을 불러옵니다'}</div>`}
  </div>`;
}

const roBox = (v, empty = '없음') => `<div class="pf-ro mono">${v ? esc(v) : `<span class="pf-hint">${empty}</span>`}</div>`;
const refList = (refs, ids) => (refs?.length ? refs : ids || []);

// 지금 세트의 상세: 받은 정의(읽기 전용) · 새 판 · 내 설정
function setDetail(s, why) {
  const local = s.source === 'local';
  const pref = prefOf(s.id);
  if (local && setStep === 'edit') return `<div class="set-detail">${setForm('edit', s, why)}</div>`;
  const roles = s.roles || [];
  return `<div class="set-detail">
    <div class="set-detail-h"><b>${esc(s.name)}</b><span class="pf-status ${s.update ? 'warn' : 'ok'}">${local ? '이 PC 전용' : `서버 v${esc(s.version)}`}</span><span class="grow"></span>
      ${local ? `<button type="button" class="btn sm" data-set-act="edit-open" ${why ? 'disabled' : ''} title="${esc(why)}">고치기</button><button type="button" class="btn sm danger-text" data-set-act="delete" ${hostUp && !why ? '' : 'disabled'} title="${esc(why)}">지우기</button>` : ''}</div>
    ${s.update ? `<div class="set-update"><div><b>새 판 v${esc(s.update.to)}</b> <span class="pf-hint">지금 v${esc(s.update.from)} · 받기를 눌러야 바뀝니다</span></div>
      <ul>${s.update.changed.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <div class="pf-actions"><button type="button" class="primary sm" data-set-act="receive" data-set-id="${esc(s.id)}" ${why ? 'disabled' : ''} title="${esc(why || '새 판으로 받습니다. 테스트·작업 데이터는 그대로 두고, Claude 작업 폴더를 다시 만듭니다')}">받기</button></div></div>` : ''}
    ${setStep === 'delete' && local ? `<div class="pf-confirm">이 PC 전용 세트 "${esc(s.name)}"를 지울까요? 이 세트의 테스트 목록·코드·수행 기록·로그가 모두 지워집니다.
      <div class="pf-actions"><button type="button" class="danger sm" data-set-act="delete-yes">지우기</button><button type="button" class="btn sm" data-set-act="delete-no">취소</button></div></div>` : ''}
    ${!s.received ? `<div class="pf-alert">아직 받지 않은 세트입니다. 목록에서 받기를 누르면 정의를 받아 쓸 수 있습니다</div></div>` : `
    <div class="set-sub"><b>${local ? '세트 정의' : '받은 정의'}</b><span class="pf-hint">${local ? '이 PC에서만 씁니다 · 고치기로 바꿉니다' : '읽기 전용 · 서버에서 바꿉니다'}</span></div>
    <label class="pf-label">대상 주소 <span class="pf-hint">대상 탭이 이 도메인(${esc(domainOf(s))})이 아니면 실행 전에 묻습니다</span></label>
    ${roBox(s.base_url)}
    <label class="pf-label">배포 서버 <span class="pf-hint">테스트 목록의 서버 전송이 보내는 곳</span></label>
    ${roBox(s.deploy_url, local ? '없음 · 고치기에서 넣습니다' : '없음 · 서버에서 설정합니다')}
    <label class="pf-label">역할 ${s.refs?.roles ? `<span class="pf-hint mono">${esc(s.refs.roles)}</span>` : ''}</label>
    <div class="set-chips">${roles.map((r) => `<span class="role-tag" title="${esc(r.desc)}">${esc(r.label)}${r.key === s.default_role ? ' · 기본' : ''}</span>`).join('') || '<span class="pf-hint">역할 정보가 없습니다</span>'}</div>
    <label class="pf-label">지식</label>
    <div class="set-chips">${refList(s.refs?.knowledge, s.knowledge).map((x) => `<span class="tag mono">${esc(x)}</span>`).join('') || '<span class="pf-hint">없음</span>'}</div>
    <label class="pf-label">태그와 버전</label>
    <div class="set-chips">${refList(s.refs?.tags, s.tags).map((x) => `<span class="tag mono">${esc(x)}</span>`).join('') || '<span class="pf-hint">없음</span>'}</div>
    ${s.prompt ? `<details class="case-d set-prompt"><summary>사이트 지식 (AI에게 함께 전달)</summary><pre class="pf-ro pf-prompt-ro mono">${esc(s.prompt)}</pre></details>` : ''}
    <div class="pf-hint set-when">${local ? '만든' : '받은'} 시각 ${s.received_at ? esc(new Date(s.received_at).toLocaleString()) : '-'}${s.tests ? ` · 테스트 BDD ${s.tests.scenarios} · TDD ${s.tests.cases}` : ''}</div>

    ${s.id === activeSet ? `<div class="set-sub"><b>메뉴 경로 지도</b><span class="pf-hint">이 PC에서 이 세트로 지나간 메뉴와 화면 · 세트 폴더(map/)에 남습니다</span></div>
    <div class="pf-actions set-map"><button type="button" class="btn sm" data-set-act="map-open">지도 보기</button>
      <button type="button" class="btn sm" data-set-act="crawl" ${why ? 'disabled' : ''} title="${esc(why || 'AI 없이 작업 탭에서 보이는 메뉴를 모두 눌러 지도를 채웁니다')}">메뉴 전체 돌기</button>
      <button type="button" class="btn sm" data-set-act="crawl-rows" ${why ? 'disabled' : ''} title="${esc(why || '메뉴마다 목록의 첫 행을 눌러 상세 화면이 어떻게 열리는지도 봅니다')}">목록 상세까지 돌기</button></div>
    <div class="pf-hint">로그인한 작업 탭에서 시작합니다. AI를 쓰지 않고, 데이터를 바꾸는 버튼·로그아웃은 누르지 않습니다. 멈추면 다시 눌러 이어갑니다.</div>` : ''}

    <div class="set-sub"><b>내 설정</b><span class="pf-hint">이 확장에만 저장되고, 세트를 고를 때 이 PC의 호스트로만 보냅니다</span></div>
    <label class="pf-label">시작 URL ${pref.start_url ? '<span class="tag ok">내 설정</span>' : '<span class="tag">세트 값</span>'}
      <span class="pf-hint">새 수행 기록은 이 주소에서 출발합니다. 비우면 ${s.start_url ? '세트 값' : '지금 탭 주소'}</span></label>
    <div class="pf-pref"><input class="pf-input mono" data-pref="start_url" placeholder="${esc(s.start_url || (s.base_url || '').replace(/\/$/, '') + (s.login_path || '/'))}" value="${esc(pref.start_url ?? '')}">
      ${pref.start_url ? '<button type="button" class="btn sm" data-set-act="pref-reset">세트 값으로</button>' : ''}</div>
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
    }).join('')}
  </div>`}`;
}

// 시작 URL은 대상 주소와 같은 도메인이어야 한다(다른 도메인이면 호스트가 쓰지 않는다)
function startUrlWarning(u, s) {
  if (!u) return '';
  let h = '';
  try { h = new URL(u).hostname; } catch { return '<div class="pf-alert">시작 URL 형식이 올바르지 않습니다(http:// 또는 https://로 시작)</div>'; }
  return h === domainOf(s) ? '' : `<div class="pf-alert">시작 URL의 도메인(${esc(h)})이 대상 주소 도메인(${esc(domainOf(s))})과 달라 쓰지 않습니다</div>`;
}

// 새 세트·고치기 입력(이 PC 전용 세트)
function setForm(kind, s = null, why = '') {
  const v = (k, d = '') => esc(setFormVals[k] ?? d);
  const cur = setInfo();
  return `<div class="pf-new">
    <div class="pf-new-h"><b>${kind === 'new' ? '새 세트' : '세트 고치기'}</b><span class="pf-hint">이 PC에서만 쓰는 세트입니다</span></div>
    <label class="pf-label">이름</label>
    <input class="pf-input" data-new="name" placeholder="예: 서비스A 2.0 poc-1" autocomplete="off" value="${v('name', s?.name)}">
    <label class="pf-label">대상 주소</label>
    <input class="pf-input mono" data-new="base_url" placeholder="https://svc-a.example" autocomplete="off" value="${v('base_url', s?.base_url)}">
    <label class="pf-label">시작 URL <span class="pf-hint">선택. 대상 주소와 같은 도메인</span></label>
    <input class="pf-input mono" data-new="start_url" placeholder="https://svc-a.example/login" autocomplete="off" value="${v('start_url', s?.start_url)}">
    ${kind === 'edit' ? `<label class="pf-label">배포 서버 <span class="pf-hint">선택. 이 PC의 임시 서버: http://127.0.0.1:8765</span></label>
    <input class="pf-input mono" data-new="deploy_url" placeholder="https://qa-server.example" autocomplete="off" value="${v('deploy_url', s?.deploy_url)}">
    <label class="pf-label">사이트 지식 <span class="pf-hint">AI에게 함께 전달</span></label>
    <textarea class="pf-input pf-prompt mono" data-new="prompt" rows="8">${v('prompt', s?.prompt)}</textarea>` : ''}
    ${kind === 'new' && cur?.received ? `<label class="pf-check"><input type="checkbox" data-new="copy" ${setFormVals.copy === false ? '' : 'checked'}> 지금 세트(${esc(cur.name)})의 설정으로 시작 <span class="pf-hint">역할·지식·태그·배포 서버·사이트 지식을 복사합니다(계정은 복사하지 않음)</span></label>` : ''}
    <div class="pf-hint">팀과 함께 쓰려면 서버 관리자에게 세트 등록을 요청하세요. 서버 세트는 받아서 쓰기만 합니다.</div>
    ${setFormError ? `<div class="pf-alert">${esc(setFormError)}</div>` : ''}
    <div class="pf-actions">
      <button type="button" class="primary sm" data-set-act="${kind}-save" ${why ? 'disabled' : ''} title="${esc(why)}">${kind === 'new' ? '만들기' : '저장'}</button>
      <button type="button" class="btn sm" data-set-act="${kind}-cancel">취소</button>
    </div>
  </div>`;
}
// 새 세트의 정의(호스트 createLocalSet 이 받는 모양). 역할은 정의 안에 직접 둔다(이 PC 전용 세트는 역할 문서를 받지 않는다)
function localDef(vals, from) {
  const roles = (from?.roles || []).map(({ key, label, desc }) => ({ key, label, desc }));
  return {
    name: vals.name,
    profile: {
      target: { base_url: vals.base_url, ...(vals.start_url ? { start_url: vals.start_url } : {}), ...(from?.login_path ? { login_path: from.login_path } : {}) },
      deploy: { url: vals.deploy_url ?? from?.deploy_url ?? '' },
      prompt: vals.prompt ?? from?.prompt ?? '',
    },
    ...(roles.length ? { roles, default_role: from.default_role } : {}),
    knowledge: from?.knowledge?.length ? from.knowledge : ['qa-common'],
    tags: from?.tags?.length ? from.tags : ['qa-tags'],
  };
}
// 입력 중인 값을 setFormVals 에 담는다(다시 그려도 남게)
function captureSetForm(body) {
  const v = (k) => body.querySelector(`[data-new="${k}"]`)?.value.trim();
  const vals = { name: v('name') || '', base_url: v('base_url') || '', start_url: v('start_url') || '' };
  if (body.querySelector('[data-new="deploy_url"]')) vals.deploy_url = v('deploy_url') || '';
  if (body.querySelector('[data-new="prompt"]')) vals.prompt = body.querySelector('[data-new="prompt"]').value;
  const copy = body.querySelector('[data-new="copy"]');
  if (copy) vals.copy = copy.checked;
  setFormVals = vals;
  return vals;
}
function readSetForm(body) {
  const vals = captureSetForm(body);
  let host = '';
  try { host = new URL(vals.base_url).hostname; } catch {}
  setFormError = !vals.name ? '이름을 적어 주세요'
    : !host ? '대상 주소를 http:// 또는 https://로 시작하는 주소로 적어 주세요'
    : vals.start_url && (() => { try { return new URL(vals.start_url).hostname !== host; } catch { return true; } })() ? '시작 URL은 대상 주소와 같은 도메인이어야 합니다'
    : vals.deploy_url && (() => { try { return !/^https?:$/.test(new URL(vals.deploy_url).protocol); } catch { return true; } })() ? '배포 서버 주소는 http:// 또는 https://로 시작해야 합니다'
    : '';
  return setFormError ? null : vals;
}

// 세트 바꾸기: 지금 화면을 저장하고 그 세트의 타임라인으로 바꾼 뒤 호스트에 알린다(호스트가 테스트 목록·세션을 바꿔 보낸다)
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

// 호스트의 세트 목록: 연결할 때·받기/만들기/지우기 뒤·1분마다 온다
async function onSets(m) {
  setList = Array.isArray(m.sets) ? m.sets : [];
  chrome.storage.local.set({ setsCache: setList }).catch(() => {});
  if (m.created) { setStep = null; setFormVals = {}; await switchSet(m.created); }
  // 지금 세트가 없어졌거나(지움) 아직 고르지 않았으면 받은 세트 중 첫 번째로
  // 예전 데이터를 옮기기 전에는 고르지 않는다(옮긴 뒤 예전 활성 프로필의 세트로 바꾼다)
  if (!migrationNeeded && (!activeSet || !setInfo())) {
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
  if (act === 'receive') {
    if (why) return msg('err', why);
    setWipSync = true;
    ws.send(JSON.stringify({ type: 'set_receive', id }));
    msg('sys', `세트 "${setInfo(id)?.name || id}"를 받습니다`);
    return renderSheet();
  }
  if (act === 'map-open') return openMenuMap();
  if (act === 'crawl' || act === 'crawl-rows') {
    if (why) return msg('err', why);
    closeSheet();
    return ws.send(JSON.stringify({ type: 'crawl', rows: act === 'crawl-rows' }));
  }
  if (act === 'new-open') { setStep = 'new'; setFormError = ''; setFormVals = {}; return renderSheet(); }
  if (act === 'edit-open') { setStep = 'edit'; setFormError = ''; setFormVals = {}; return renderSheet(); }
  if (act === 'new-cancel' || act === 'edit-cancel' || act === 'delete-no') { setStep = null; setFormError = ''; setFormVals = {}; return renderSheet(); }
  if (act === 'new-save') {
    const vals = readSetForm(body);
    if (!vals) return renderSheet();
    if (ws?.readyState !== 1) return msg('err', '호스트와 연결되어 있지 않습니다');
    ws.send(JSON.stringify({ type: 'set_create_local', def: localDef(vals, vals.copy === false ? null : setInfo()?.received ? setInfo() : null) }));
    return; // 호스트가 sets{created} 로 답하면 그 세트로 바꾼다
  }
  if (act === 'edit-save') {
    const s = setInfo();
    const vals = readSetForm(body);
    if (!vals || !s) return renderSheet();
    if (ws?.readyState !== 1) return msg('err', '호스트와 연결되어 있지 않습니다');
    if (why) return msg('err', why);
    // 고친 칸만 보낸다. 호스트는 나머지 정의(역할 참조·지식·태그·claude·cleanup·모르는 키)를 그대로 둔다
    const patch = { name: vals.name, profile: { target: { base_url: vals.base_url, start_url: vals.start_url }, deploy: { url: vals.deploy_url ?? '' }, prompt: vals.prompt ?? '' } };
    ws.send(JSON.stringify({ type: 'set_update_local', id: s.id, patch }));
    setStep = null; setFormVals = {};
    return renderSheet();
  }
  if (act === 'delete') { setStep = 'delete'; return renderSheet(); }
  if (act === 'delete-yes') {
    const s = setInfo();
    if (!s || s.source !== 'local') return;
    if (why) return msg('err', why);
    ws.send(JSON.stringify({ type: 'set_delete', id: s.id }));
    delete setPrefs[s.id];
    saveSetPrefs();
    chrome.storage.local.remove(timelineKey(s.id)).catch(() => {});
    setStep = null;
    return; // 호스트가 sets 로 답하면 다른 세트로 바꾼다
  }
  if (act === 'pref-reset') { const next = { ...prefOf(activeSet) }; delete next.start_url; setPrefs[activeSet] = next; }
  if (act === 'acc-reset') { const p = prefOf(activeSet); const accounts = { ...p.accounts }; delete accounts[btn.dataset.accKey]; setPrefs[activeSet] = { ...p, accounts }; }
  if (act === 'pref-reset' || act === 'acc-reset') { saveSetPrefs(); sendSetToHost(); renderRoleScope(); renderSheet(); }
});
document.getElementById('set-chip').onclick = () => { setStep = null; setFormError = ''; openSheet('set'); };
