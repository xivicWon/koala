// ── 작업 탭 ──
// AI는 화면에 보이는 탭이 아니라 세트마다 정해 둔 작업 탭에서만 조작한다. 처음 지시할 때 그때 보이던 탭을 작업 탭으로 정하고,
// 탭 그룹(koala · 세트 이름)으로 묶어 어느 탭이 AI 작업 중인지 보이게 한다. 작업 탭에서 열린 새 탭도 같은 그룹에 넣고 그 탭으로 이어 간다.
// 작업 탭이 뒤로 가도 ensureAttached 가 포커스를 흉내 내 화면이 계속 그려지므로, 사용자는 그동안 다른 탭을 써도 된다
const WORK_KEY = 'workTabs'; // chrome.storage.session { [세트 id]: { tabId, groupId } }. 브라우저를 다시 켜면 탭 id가 바뀌므로 세션 저장소에 둔다
let workTabs = {};
let workTabId = null; // 지금 조작하는 탭(작업 탭, 또는 거기서 열린 새 탭)
let workFor = null;   // workTabId 를 정한 세트
const wkSet = () => viewSet || activeSet || '-';
const saveWork = () => chrome.storage.session?.set({ [WORK_KEY]: workTabs }).catch(() => {});
const workReady = (chrome.storage.session?.get(WORK_KEY) || Promise.resolve({}))
  .then((r) => { workTabs = r?.[WORK_KEY] || {}; }).catch(() => {});
const liveTab = (id) => (id != null ? chrome.tabs.get(id).catch(() => null) : Promise.resolve(null));
// 도구가 지금 다루는 탭(작업 탭이 정해진 뒤에만 쓴다)
const curTab = () => liveTab(tabId);

// 지금 조작할 탭. 없으면(claim) 지금 보이는 탭을 이 세트의 작업 탭으로 정한다
async function workTab({ claim = true } = {}) {
  await workReady;
  if (workFor !== wkSet()) { workTabId = null; workFor = wkSet(); }
  const cur = await liveTab(workTabId);
  if (cur) return cur;
  const saved = await liveTab(workTabs[wkSet()]?.tabId);
  if (saved) { workTabId = saved.id; return saved; }
  if (!claim) return null;
  const tab = await activeTab();
  if (tab) await setWorkTab(tab);
  return tab;
}

async function setWorkTab(tab, { note = '작업 탭을 정했습니다' } = {}) {
  workFor = wkSet();
  workTabId = tab.id;
  workTabs[wkSet()] = { ...workTabs[wkSet()], tabId: tab.id };
  await groupWork(tab.id);
  assignLabel(tab.id);
  // 작업 중에 브라우저가 메모리 정리로 탭을 버리지 않게 한다
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  saveWork();
  msg('sys', `${note}: ${labelOf(tab.id)} ${tab.title || tab.url} · AI는 이 탭에서만 조작하니 다른 탭을 써도 됩니다`);
  renderWorkTab();
  renderWorkList();
}

// 관리 탭 라벨: 세트마다 #1, #2 …(비어 있는 가장 작은 번호). 사람과 Claude 가 같은 이름으로 탭을 가리킨다
const labelsOf = (set = wkSet()) => (workTabs[set] ||= {}).labels ||= {};
const labelOf = (id) => (id != null && workTabs[wkSet()]?.labels?.[id] ? `#${workTabs[wkSet()].labels[id]}` : null);
function assignLabel(id) {
  const L = labelsOf();
  if (L[id]) return L[id];
  const used = new Set(Object.values(L));
  let n = 1; while (used.has(n)) n++;
  L[id] = n; saveWork();
  return n;
}
function dropLabel(id) { const L = workTabs[wkSet()]?.labels; if (L?.[id]) { delete L[id]; saveWork(); } }
const selfGrouping = new Set();
const setGroup = () => workTabs[wkSet()]?.groupId;
// 이 세트의 관리 탭: 노란 그룹 안의 탭들. 그룹이 없으면(지원 안 함·아직 없음) 작업 탭 하나
async function groupTabs() {
  await mergeTabGroups();
  const gid = setGroup();
  if (gid != null) {
    const ts = await chrome.tabs.query({ groupId: gid }).catch(() => []);
    for (const t of ts) assignLabel(t.id); // 그룹에 있는데 라벨이 없는 탭(이전 판에서 넣은 탭 등)
    if (ts.length) return ts.sort((a, b) => labelsOf()[a.id] - labelsOf()[b.id]);
  }
  const t = await workTab({ claim: false });
  return t ? [t] : [];
}

// v0.5.0 은 관리 탭마다 그룹(koala #N · 세트)을 따로 만들었다. 번호는 확장에서만 보이도록 세트 그룹 하나로 다시 모은다
async function mergeTabGroups() {
  const w = workTabs[wkSet()];
  if (!w?.groups) return;
  const ids = Object.keys(w.groups).map(Number);
  delete w.groups; saveWork();
  for (const id of ids) if (await liveTab(id)) await groupWork(id);
}

// 세트 이름의 탭 그룹에 넣는다. 탭 그룹을 지원하지 않는 브라우저면 건너뛴다
async function groupWork(id) {
  if (!chrome.tabGroups || !chrome.tabs.group) return;
  const w = workTabs[wkSet()] || {};
  selfGrouping.add(id); // 우리가 넣는 것은 '사용자가 끌어 넣었다'로 보지 않는다(onUpdated)
  setTimeout(() => selfGrouping.delete(id), 1500);
  try {
    const tab = await chrome.tabs.get(id);
    let gid = w.groupId;
    const g = gid != null ? await chrome.tabGroups.get(gid).catch(() => null) : null;
    if (!g || g.windowId !== tab.windowId) gid = null; // 다른 창의 그룹에는 넣을 수 없어 그 창에 새 그룹을 만든다
    // 새 그룹은 '지금 창'(사이드패널 창)이 아니라 탭이 있는 창에 만든다
    gid = await chrome.tabs.group(gid != null ? { tabIds: [id], groupId: gid } : { tabIds: [id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(gid, { title: `koala · ${setInfo(wkSet())?.name || wkSet()}`, color: 'yellow' });
    workTabs[wkSet()] = { ...workTabs[wkSet()], groupId: gid };
  } catch { /* 그룹은 보이기 위한 것이라 실패해도 작업은 계속한다 */ }
}

// 작업 탭에서 열린 새 탭(링크·팝업)은 같은 그룹에 넣고 그 탭으로 이어서 조작한다.
// tabs.onCreated 의 openerTabId 는 작업 탭이 뒤에 있으면 '보이는 탭'으로 잡혀 믿을 수 없어, 실제로 연 탭을 알려 주는 webNavigation 을 쓴다
chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId: id }) => {
  if (workTabId == null || sourceTabId !== workTabId) return;
  await groupWork(id);
  assignLabel(id);
  workTabId = id;
  msg('sys', `작업 탭에서 새 탭이 열려 ${labelOf(id)} 탭으로 이어서 진행합니다`);
  renderWorkTab();
});
// 닫힌 탭: 이어 가던 새 탭이면 작업 탭으로 돌아가고, 작업 탭이면 진행을 멈춘다
chrome.tabs.onRemoved.addListener((id) => {
  const base = workTabs[wkSet()]?.tabId;
  if (id === workTabId && id !== base && base != null) {
    workTabId = base;
    msg('sys', '이어 가던 새 탭이 닫혀 작업 탭으로 돌아갑니다');
  } else if (id === base) {
    workTabId = null;
    if (aiBusy) { msg('err', '작업 탭이 닫혀 진행을 멈췄습니다. 다음 지시 때 그때 보이는 탭을 작업 탭으로 정합니다'); stopRun(); }
  }
  let changed = false;
  for (const k of Object.keys(workTabs)) {
    if (workTabs[k].labels?.[id]) { delete workTabs[k].labels[id]; changed = true; }
    if (workTabs[k].tabId === id) { delete workTabs[k].tabId; changed = true; }
  }
  if (changed) saveWork();
  renderWorkTab();
  renderWorkList();
});
// 사용자가 탭을 노란 그룹으로 끌어 넣거나 빼면: 넣은 탭은 관리 탭이 되고(작업 탭이 없으면 바로 작업 탭),
// 작업 탭을 그룹 밖으로 빼면 그룹의 다른 탭으로 옮기거나(없으면 작업 탭 없음) 진행 중이면 멈춘다
chrome.tabs.onUpdated.addListener(async (id, ch, tab) => {
  if (ch.title || ch.url) renderWorkList();
  if (!('groupId' in ch)) return;
  const gid = setGroup();
  if (gid == null) return;
  if (ch.groupId === gid && selfGrouping.has(id)) return; // koala 가 넣은 것. 빼는 것은 언제나 사용자 동작으로 본다
  const base = workTabs[wkSet()]?.tabId;
  if (ch.groupId === gid) {
    assignLabel(id);
    if (await liveTab(base)) msg('sys', `작업 그룹에 탭을 넣었습니다: ${labelOf(id)} ${tab.title || tab.url} · 위쪽 탭 목록에서 고르거나 "${labelOf(id)} 탭에서 …"라고 지시하세요`);
    else await setWorkTab(tab, { note: '그룹에 넣은 탭을 작업 탭으로 정했습니다' });
  } else if (labelsOf()[id] && id !== base && id !== workTabId) {
    dropLabel(id);
  } else if (id === base || id === workTabId) {
    dropLabel(id);
    if (aiBusy) { msg('err', '작업 탭을 그룹에서 빼서 진행을 멈췄습니다'); stopRun(); }
    const rest = (await chrome.tabs.query({ groupId: gid }).catch(() => [])).filter((t) => t.id !== id);
    if (rest[0]) await setWorkTab(rest[0], { note: '작업 탭을 그룹에서 빼서 그룹의 다른 탭으로 옮겼습니다' });
    else {
      workTabId = null;
      delete workTabs[wkSet()];
      saveWork();
      msg('sys', '작업 탭을 그룹에서 뺐습니다. 다음 지시 때 그때 보이는 탭을 작업 탭으로 정합니다');
    }
  }
  renderWorkTab();
  renderWorkList();
});

// 미리 불러오기 등으로 탭이 바뀌면(id 교체) 새 id로 이어 간다
chrome.tabs.onReplaced.addListener((added, removed) => {
  if (workTabId === removed) workTabId = added;
  for (const k of Object.keys(workTabs)) {
    if (workTabs[k].tabId === removed) workTabs[k].tabId = added;
    const L = workTabs[k].labels; if (L?.[removed]) { L[added] = L[removed]; delete L[removed]; }
  }
  saveWork();
});

// ── 헤더: 작업 탭 표시·보기·지금 탭으로 바꾸기 ──
async function renderWorkTab() {
  const t = await workTab({ claim: false });
  const n = t ? (await groupTabs()).length : 0;
  $('work-list-btn').textContent = `탭 ${n}`;
  $('work-list-btn').hidden = !t;
  if (!t && !$('work-list').hidden) $('work-list').hidden = true;
  $('s-url-k').textContent = t ? `작업 탭 ${labelOf(t.id) || ''}`.trim() : '대상 탭';
  $('s-url-k').classList.toggle('work', !!t); // 탭 그룹과 같은 노란 점: 이 주소가 koala 가 관리하는 탭이라는 표시
  $('work-take').disabled = aiBusy;
  $('work-take').dataset.tip = aiBusy ? 'AI 작업 중에는 작업 탭을 바꿀 수 없습니다' : '지금 보고 있는 탭을 이 세트의 작업 탭으로 정합니다(작업 탭 그룹에 넣습니다)';
}
const showTab = async (t) => {
  await chrome.tabs.update(t.id, { active: true }).catch(() => {});
  await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
};
// 관리 탭 목록: 그룹 안의 탭. 하나를 골라 작업 탭으로 쓰고, 보기로 그 탭에 간다
async function renderWorkList() {
  const box = $('work-list');
  if (box.hidden) return;
  const cur = await workTab({ claim: false });
  const ts = await groupTabs();
  const host = (u) => { try { return new URL(u).host; } catch { return u || ''; } };
  box.innerHTML = `${ts.map((t) => `<div class="wl-row${t.id === cur?.id ? ' on' : ''}">
 <span class="wl-l mono">${labelOf(t.id) || ''}</span><span class="wl-t" title="${esc(t.url || '').replace(/"/g, '&quot;')}">${esc(t.title || t.url || '(제목 없음)')}</span><span class="wl-h mono">${esc(host(t.url))}</span>
      ${t.id === cur?.id ? '<span class="wl-cur">작업 탭</span>' : `<button type="button" class="work-btn" data-wl-use="${t.id}" ${aiBusy ? 'disabled data-tip="AI 작업 중에는 작업 탭을 바꿀 수 없습니다"' : ''}>작업 탭으로</button>`}
      <button type="button" class="work-btn" data-wl-show="${t.id}">보기</button></div>`).join('')}
    <div class="wl-hint">탭을 노란 그룹(koala · ${esc(setInfo(wkSet())?.name || wkSet())})으로 끌어 넣으면 번호(#)가 붙습니다. "#2 탭에서 …"처럼 지시하면 AI가 그 탭으로 바꿔 진행합니다. AI는 한 번에 한 탭에서 조작합니다.</div>`;
}
$('work-list-btn').onclick = () => { $('work-list').hidden = !$('work-list').hidden; renderWorkList(); };
$('work-list').addEventListener('click', async (e) => {
  const use = Number(e.target.closest('[data-wl-use]')?.dataset.wlUse);
  const show = Number(e.target.closest('[data-wl-show]')?.dataset.wlShow);
  if (use && !aiBusy) { const t = await liveTab(use); if (t) await setWorkTab(t, { note: '작업 탭을 바꿨습니다' }); }
  if (show) { const t = await liveTab(show); if (t) await showTab(t); }
});
$('work-take').onclick = async () => {
  if (aiBusy) return;
  const t = await activeTab();
  if (!t) return;
  if (t.id === (await workTab({ claim: false }))?.id) return msg('sys', '이미 작업 탭입니다');
  await setWorkTab(t);
};

// ── Claude 가 쓰는 관리 탭 정보(tabs·use_tab 도구, 지시에 붙는 목록) ──
async function tabsForAi() {
  const cur = await workTab({ claim: false });
  return (await groupTabs()).map((t) => ({ tab: labelOf(t.id), title: t.title || '', url: t.url || '', current: t.id === cur?.id }));
}
// '#2' · '2' · 2 를 받아 그 라벨의 관리 탭을 작업 탭으로 바꾼다(AI 작업 중에도 AI 는 바꿀 수 있다)
async function useTabFromAi(ref) {
  const n = Number(String(ref ?? '').replace(/^#/, ''));
  const tabs = await groupTabs();
  const t = tabs.find((x) => labelsOf()[x.id] === n);
  if (!t) throw new Error(`관리 탭 #${n || ref}이(가) 없습니다. 지금 관리 탭: ${tabs.map((x) => `${labelOf(x.id)} ${x.title || x.url}`).join(', ') || '없음'}`);
  if (t.id !== (await workTab({ claim: false }))?.id) await setWorkTab(t, { note: 'AI가 작업 탭을 바꿨습니다' });
  return { tab: labelOf(t.id), title: t.title, url: t.url };
}

// 패널을 처음 열 때: 세트가 골라져 있고 작업 탭이 없으면 지금 보던 탭을 작업 탭으로 정한다.
// 세트의 사이트가 아닌 탭(메일 등)은 koala 그룹에 넣지 않고 안내만 한다
async function autoClaimOnOpen() {
  if (!viewSet || !setInfo(viewSet)) return;
  if (await workTab({ claim: false })) return;
  const t = await activeTab();
  if (!t || !/^(https?|file):/.test(t.url || '')) return;
  const dom = domainOf(setInfo(viewSet));
  let host = '';
  try { host = new URL(t.url).hostname; } catch {}
  if (dom && dom !== 'default' && host && host !== dom) {
    msg('sys', `지금 탭(${host})은 이 세트의 사이트(${dom})가 아니라 작업 탭으로 정하지 않았습니다. 세트 사이트 탭에서 위쪽 '지금 탭으로'를 누르세요`);
    return;
  }
  await setWorkTab(t, { note: '패널을 열 때 보던 탭을 작업 탭으로 정했습니다' });
}
