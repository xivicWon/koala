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

async function setWorkTab(tab) {
  workFor = wkSet();
  workTabId = tab.id;
  workTabs[wkSet()] = { ...workTabs[wkSet()], tabId: tab.id };
  await groupWork(tab.id);
  // 작업 중에 브라우저가 메모리 정리로 탭을 버리지 않게 한다
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  saveWork();
  msg('sys', `작업 탭을 정했습니다: ${tab.title || tab.url} · AI는 이 탭에서만 조작하니 다른 탭을 써도 됩니다`);
  renderWorkTab();
}

// 세트 이름의 탭 그룹에 넣는다. 탭 그룹을 지원하지 않는 브라우저면 건너뛴다
async function groupWork(id) {
  if (!chrome.tabGroups || !chrome.tabs.group) return;
  const w = workTabs[wkSet()] || {};
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
  workTabId = id;
  msg('sys', '작업 탭에서 새 탭이 열려 그 탭으로 이어서 진행합니다');
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
  for (const k of Object.keys(workTabs)) if (workTabs[k].tabId === id) { delete workTabs[k]; changed = true; }
  if (changed) saveWork();
  renderWorkTab();
});
// 미리 불러오기 등으로 탭이 바뀌면(id 교체) 새 id로 이어 간다
chrome.tabs.onReplaced.addListener((added, removed) => {
  if (workTabId === removed) workTabId = added;
  for (const k of Object.keys(workTabs)) if (workTabs[k].tabId === removed) workTabs[k].tabId = added;
  saveWork();
});

// ── 헤더: 작업 탭 표시·보기·지금 탭으로 바꾸기 ──
async function renderWorkTab() {
  const t = await workTab({ claim: false });
  $('s-url-k').textContent = t ? '작업 탭' : '대상 탭';
  $('s-url-k').classList.toggle('work', !!t); // 탭 그룹과 같은 노란 점: 이 주소가 koala 가 관리하는 탭이라는 표시
  $('work-show').hidden = !t;
  $('work-take').disabled = aiBusy;
  $('work-take').dataset.tip = aiBusy ? 'AI 작업 중에는 작업 탭을 바꿀 수 없습니다' : '지금 보고 있는 탭을 이 세트의 작업 탭으로 정합니다(작업 탭 그룹에 넣습니다)';
}
$('work-show').onclick = async () => {
  const t = await workTab({ claim: false });
  if (!t) return;
  await chrome.tabs.update(t.id, { active: true }).catch(() => {});
  await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
};
$('work-take').onclick = async () => {
  if (aiBusy) return;
  const t = await activeTab();
  if (!t) return;
  if (t.id === (await workTab({ claim: false }))?.id) return msg('sys', '이미 작업 탭입니다');
  await setWorkTab(t);
};
