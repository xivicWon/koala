// ── 작업 탭 ──
// AI는 화면에 보이는 탭이 아니라 세트마다 정해 둔 작업 탭에서만 조작한다. 처음 지시할 때 그때 보이던 탭을 작업 탭으로 정하고,
// 탭마다 번호(#1, #2 …)와 탭 그룹(koala #N · 세트 이름)을 붙여 어느 탭이 koala 관리 탭인지 보이게 한다. 작업 탭에서 열린 새 탭도 관리 탭이 되고 그 탭으로 이어 간다.
// 작업 탭이 뒤로 가도 ensureAttached 가 포커스를 흉내 내 화면이 계속 그려지므로, 사용자는 그동안 다른 탭을 써도 된다
const WORK_KEY = 'workTabs'; // chrome.storage.session { [세트 id]: { tabId, labels: {탭: 번호}, groups: {탭: 그룹} } }. 브라우저를 다시 켜면 탭 id가 바뀌므로 세션 저장소에 둔다
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
  refreshGroupTitles();
  // 작업 중에 브라우저가 메모리 정리로 탭을 버리지 않게 한다
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  saveWork();
  msg('sys', `${note}: ${labelOf(tab.id)} ${tab.title || tab.url} · AI는 이 탭에서만 조작하니 다른 탭을 써도 됩니다`);
  renderWorkTab();
  renderWorkList();
}

// 관리 탭 라벨: 세트마다 #1, #2 …(비어 있는 가장 작은 번호). 사람과 Claude 가 같은 이름으로 탭을 가리킨다.
// 탭마다 자기 그룹(koala #N · 세트 이름)을 따로 두어 탭 줄에서도 번호가 보이게 한다. 작업 탭 그룹 이름 앞에는 ●
const labelsOf = (set = wkSet()) => (workTabs[set] ||= {}).labels ||= {};
const groupsOf = (set = wkSet()) => (workTabs[set] ||= {}).groups ||= {};
const labelOf = (id) => (id != null && workTabs[wkSet()]?.labels?.[id] ? `#${workTabs[wkSet()].labels[id]}` : null);
function assignLabel(id) {
  const L = labelsOf();
  if (L[id]) return L[id];
  const used = new Set(Object.values(L));
  let n = 1; while (used.has(n)) n++;
  L[id] = n; saveWork();
  return n;
}
function dropLabel(id) { const w = workTabs[wkSet()]; if (w?.labels?.[id] || w?.groups?.[id]) { delete w.labels?.[id]; delete w.groups?.[id]; saveWork(); } }
const selfGrouping = new Set(); // koala 가 옮기는 탭(그룹 변화를 사용자 동작으로 보지 않는다)
const groupTitle = (id) => `${id === workTabs[wkSet()]?.tabId ? '● ' : ''}koala ${labelOf(id)} · ${setInfo(wkSet())?.name || wkSet()}`;

// 이 세트의 관리 탭(번호 순). 아무것도 없으면 작업 탭 하나
async function groupTabs() {
  await upgradeSharedGroup();
  const L = labelsOf();
  const ts = (await Promise.all(Object.keys(L).map((id) => liveTab(Number(id))))).filter(Boolean);
  if (ts.length) return ts.sort((a, b) => L[a.id] - L[b.id]);
  const t = await workTab({ claim: false });
  return t ? [t] : [];
}
// 이전 판(세트 하나 = 그룹 하나)에서 넣은 탭: 번호를 주고 탭마다 그룹으로 나눈다
async function upgradeSharedGroup() {
  const w = workTabs[wkSet()];
  if (w?.groupId == null || !chrome.tabs?.query) return;
  const gid = w.groupId; delete w.groupId; saveWork();
  for (const t of await chrome.tabs.query({ groupId: gid }).catch(() => [])) { assignLabel(t.id); await groupWork(t.id); }
}

// 탭을 자기 그룹(koala #N · 세트)에 넣는다. 탭 그룹을 지원하지 않는 브라우저면 번호만 쓴다
async function groupWork(id) {
  assignLabel(id);
  if (!chrome.tabGroups || !chrome.tabs.group) return;
  selfGrouping.add(id);
  setTimeout(() => selfGrouping.delete(id), 1500);
  try {
    const tab = await chrome.tabs.get(id);
    const G = groupsOf();
    let gid = G[id];
    const g = gid != null ? await chrome.tabGroups.get(gid).catch(() => null) : null;
    if (!g || tab.groupId !== gid) {
      // 새 그룹은 '지금 창'(사이드패널 창)이 아니라 탭이 있는 창에 만든다
      gid = await chrome.tabs.group({ tabIds: [id], createProperties: { windowId: tab.windowId } });
      G[id] = gid;
      saveWork();
    }
    await chrome.tabGroups.update(gid, { title: groupTitle(id), color: 'yellow' });
  } catch { /* 그룹은 보이기 위한 것이라 실패해도 작업은 계속한다 */ }
}
// 작업 탭이 바뀌면 그룹 이름의 ● 를 옮긴다
async function refreshGroupTitles() {
  if (!chrome.tabGroups) return;
  for (const [id, gid] of Object.entries(groupsOf())) await chrome.tabGroups.update(gid, { title: groupTitle(Number(id)) }).catch(() => {});
}

// 작업 탭에서 열린 새 탭(링크·팝업)은 번호를 받아 관리 탭이 되고, 그 탭으로 이어서 조작한다.
// tabs.onCreated 의 openerTabId 는 작업 탭이 뒤에 있으면 '보이는 탭'으로 잡혀 믿을 수 없어, 실제로 연 탭을 알려 주는 webNavigation 을 쓴다
chrome.webNavigation.onCreatedNavigationTarget.addListener(async ({ sourceTabId, tabId: id }) => {
  if (workTabId == null || sourceTabId !== workTabId) return;
  await groupWork(id);
  workTabId = id;
  msg('sys', `작업 탭에서 새 탭이 열려 ${labelOf(id)} 탭으로 이어서 진행합니다`);
  renderWorkTab();
});
// 닫힌 탭: 이어 가던 새 탭이면 작업 탭으로 돌아가고, 작업 탭이면 진행을 멈춘다. 번호는 돌려준다
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
    if (workTabs[k].groups?.[id]) { delete workTabs[k].groups[id]; changed = true; }
    if (workTabs[k].tabId === id) { delete workTabs[k].tabId; changed = true; }
  }
  if (changed) saveWork();
  renderWorkTab();
  renderWorkList();
});
// 사용자가 탭을 koala 그룹으로 끌어 넣으면: 새 번호와 자기 그룹을 받아 관리 탭이 된다(작업 탭이 없으면 바로 작업 탭).
// 관리 탭을 그룹 밖으로 빼면 번호를 돌려주고, 그게 작업 탭이면 다른 관리 탭으로 옮기거나(없으면 작업 탭 없음) 진행 중이면 멈춘다
chrome.tabs.onUpdated.addListener(async (id, ch, tab) => {
  if (ch.title || ch.url) renderWorkList();
  if (!('groupId' in ch) || selfGrouping.has(id)) return;
  const L = labelsOf(), G = groupsOf();
  const base = workTabs[wkSet()]?.tabId;
  if (L[id] && ch.groupId !== G[id]) {
    const wasWork = id === base || id === workTabId;
    const label = labelOf(id);
    dropLabel(id);
    if (!wasWork) msg('sys', `${label} 탭을 koala 관리에서 뺐습니다`);
    else {
      if (aiBusy) { msg('err', '작업 탭을 그룹에서 빼서 진행을 멈췄습니다'); stopRun(); }
      const rest = (await groupTabs()).filter((t) => t.id !== id && labelsOf()[t.id]);
      if (rest[0]) await setWorkTab(rest[0], { note: '작업 탭을 그룹에서 빼서 다른 관리 탭으로 옮겼습니다' });
      else { workTabId = null; delete workTabs[wkSet()].tabId; saveWork(); msg('sys', '작업 탭을 그룹에서 뺐습니다. 다음 지시 때 그때 보이는 탭을 작업 탭으로 정합니다'); }
    }
  } else if (!L[id] && ch.groupId > -1 && Object.values(G).includes(ch.groupId)) {
    await groupWork(id); // 끌어 넣은 그룹에서 꺼내 자기 그룹으로
    if (await liveTab(base)) msg('sys', `관리 탭을 더했습니다: ${labelOf(id)} ${tab.title || tab.url} · 위쪽 탭 목록에서 고르거나 "${labelOf(id)} 탭에서 …"라고 지시하세요`);
    else await setWorkTab(tab, { note: '끌어 넣은 탭을 작업 탭으로 정했습니다' });
  }
  renderWorkTab();
  renderWorkList();
});

// 미리 불러오기 등으로 탭이 바뀌면(id 교체) 새 id로 이어 간다
chrome.tabs.onReplaced.addListener((added, removed) => {
  if (workTabId === removed) workTabId = added;
  for (const k of Object.keys(workTabs)) {
    const w = workTabs[k];
    if (w.tabId === removed) w.tabId = added;
    for (const m of [w.labels, w.groups]) if (m?.[removed] != null) { m[added] = m[removed]; delete m[removed]; }
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
    <div class="wl-hint">탭을 아무 koala 그룹으로 끌어 넣으면 새 번호(#)와 그룹이 붙습니다(탭 줄의 ● 는 작업 탭). "#2 탭에서 …"처럼 지시하면 AI가 그 탭으로 바꿔 진행합니다. AI는 한 번에 한 탭에서 조작합니다.</div>`;
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
