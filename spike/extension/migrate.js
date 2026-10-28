// 업데이트 뒤 첫 연결의 옮기기(패널 쪽). 세트 화면은 sets.js, 디스크 데이터 옮기기는 호스트(migrate-sets.mjs)
// ── 업데이트 뒤 첫 연결: 예전(프로필·도메인 단위) 확장 데이터를 세트로 옮긴다 ──
// 호스트가 디스크의 도메인 데이터를 세트로 옮기고(migrate → migrated) 프로필 → 세트, 도메인 → 세트 대응을 알려 주면
// 내 설정(시작 URL·계정·역할 범위)과 타임라인을 그 세트로 옮긴다. 예전 키는 호스트가 옮기기에 성공하고
// 새 키를 저장한 뒤에만 지운다. 실패하면 모두 그대로 두고, 패널을 다시 열 때 한 번 더 시도한다(저절로 되풀이하지 않는다).
// 계정 비밀번호는 호스트로 보내지 않는다(계정은 확장 안에서 profileLocal → setPrefs 로 옮긴다)
const LEGACY_KEYS = ['profiles', 'activeProfile', 'profileLocal', 'profilePrefs', 'roleScope', 'roleDocs', 'timelineState', 'suiteDraft'];
const SECRET_FIELDS = ['account', 'accounts', 'pass', 'password'];
let legacy = null;           // 옮길 예전 확장 데이터(없으면 null)
let hostNeedsMigration = false; // 호스트에 옮기지 않은 예전 데이터가 있다(확장에 예전 키가 없어도 옮기기를 보낸다)
let migrateState = null;     // null | 'sent' | 'failed' | 'done' — 패널을 열 때마다 한 번만 보낸다

const migrationText = () => (migrateState === 'failed'
  ? '기존 작업 데이터를 세트로 옮기지 못했습니다 · 원래 데이터는 그대로 두었습니다. 패널을 다시 열면 다시 시도합니다'
  : '기존 작업 데이터를 세트로 옮기는 중입니다 · 끝나면 세트를 쓸 수 있습니다');
const legacyDomain = (p) => { try { return new URL(p?.target?.base_url).hostname || 'default'; } catch { return 'default'; } };
// 계정·비밀번호는 어느 깊이에 있든 뺀다(이 PC 전용 프로필의 인라인 역할 account 등)
const noSecrets = (v) => (Array.isArray(v) ? v.map(noSecrets)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET_FIELDS.includes(k)).map(([k, x]) => [k, noSecrets(x)]))
  : v);
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// 예전 timeline@<도메인> 인지: 도메인처럼 생겼고(점이 있거나 default·localhost) 알려진 세트 id 가 아닌 것.
// 세트 id 는 점이 없는 것이 보통이라, 고른 적만 있고 내 설정이 없는 세트의 타임라인을 예전 키로 잘못 보지 않는다
const looksLikeDomain = (x) => x.includes('.') || x === 'default' || x === 'localhost';

async function loadLegacy() {
  // 저장소를 읽지 못하면 아무것도 적지 않는다(setsMigrated 를 쓰면 예전 데이터를 다시 옮기지 않는다). 다음에 열 때 다시 본다
  const all = await chrome.storage.local.get(null).catch(() => null);
  if (!all || all.setsMigrated) return;
  const profiles = all.profiles || {};
  const known = new Set([all.activeSet, ...Object.keys(all.setPrefs || {}), ...(Array.isArray(all.setsCache) ? all.setsCache.map((s) => s?.id) : [])].filter(Boolean));
  const keys = LEGACY_KEYS.filter((k) => k in all);
  const suites = {};
  const timelines = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('suite@')) { keys.push(k); if (v) suites[k.slice(6)] = v; }
    const x = k.startsWith('timeline@') && k.slice(9);
    if (x && looksLikeDomain(x) && !known.has(x)) { keys.push(k); timelines[x] = v; }
  }
  // 옮길 것이 없으면 이 확장은 끝난 것으로 적어 둔다(다음에 열 때 세트 타임라인을 예전 키로 보지 않게).
  // 호스트 쪽 옮기기는 따로다: migration_needed 가 오면 빈 프로필로 보낸다
  if (!keys.length) { chrome.storage.local.set({ setsMigrated: localDay() }).catch(() => {}); return; }
  // 도메인 구분 전의 타임라인·초안은 활성 프로필(초안은 그 초안의 프로필) 도메인 것으로 본다.
  // 그 도메인 것이 이미 있으면 쓰지 않고 확장 보관본(setsMigratedArchive)에 둔다
  const activeDom = legacyDomain(profiles[all.activeProfile]?.data);
  const discarded = {};
  if (all.timelineState) {
    if (!timelines[activeDom]) timelines[activeDom] = all.timelineState;
    else discarded.timelineState = all.timelineState;
  }
  const draft = all.suiteDraft;
  if (draft) {
    const d = profiles[draft.suite?.profile] ? legacyDomain(profiles[draft.suite.profile].data) : activeDom;
    if (draft.suite && !suites[d]) suites[d] = draft;
    else discarded.suiteDraft = draft;
  }
  legacy = { profiles, activeProfile: all.activeProfile || null, profileLocal: all.profileLocal || {}, profilePrefs: all.profilePrefs || {}, roleScope: all.roleScope || {}, suites, timelines, keys, discarded };
  migrationNeeded = true;
}

// 호스트로 보내는 것: 프로필(계정 값은 뺀 것)·활성 프로필·suite@<도메인>·타임라인이 있는 도메인 목록
function migratePayload() {
  const L = legacy || { profiles: {}, activeProfile: null, suites: {}, timelines: {} };
  const profiles = Object.fromEntries(Object.entries(L.profiles).map(([id, p]) => [id, { data: noSecrets(p?.data || {}), ...(p?.local ? { local: true } : {}) }]));
  return { type: 'migrate', profiles, activeId: L.activeProfile, extSuites: L.suites, extTimelines: Object.keys(L.timelines) };
}
function maybeMigrate() {
  if (migrateState || (!legacy && !hostNeedsMigration) || ws?.readyState !== 1) return;
  migrateState = 'sent';
  ws.send(JSON.stringify(migratePayload()));
}
function onMigrationNeeded() {
  hostNeedsMigration = true;
  migrationNeeded = true;
  maybeMigrate();
  renderSetChip();
  if (sheetMode === 'set') renderSheet();
}
// 답을 받기 전에 끊기면 다시 연결될 때 보낸다(답을 받았으면 패널을 다시 열 때까지 보내지 않는다)
function onMigrateSocketClosed() { if (migrateState === 'sent') migrateState = null; }

// 호스트가 옮긴 뒤: 새 키를 저장 → 예전 키를 지움 → setsMigrated. 옮기지 못한 확장 데이터는 setsMigratedArchive 에 둔다
async function finishMigration(m) {
  const L = legacy || { profiles: {}, activeProfile: null, profileLocal: {}, profilePrefs: {}, roleScope: {}, suites: {}, timelines: {}, keys: [] };
  const map = m.setByProfile || {};
  const now = await chrome.storage.local.get(null);
  const put = {};
  const archive = { ...(L.discarded || {}) };
  // 같은 세트로 가는 타임라인이 여럿이면 제 도메인 것을 먼저(default 는 마지막). 이미 있는 세트 타임라인은 덮어쓰지 않는다
  for (const d of Object.keys(L.timelines).sort((a, b) => Number(a === 'default') - Number(b === 'default'))) {
    const key = m.timelineKeys?.[d] && timelineKey(m.timelineKeys[d]);
    if (!key || key in now || key in put) archive[`timeline@${d}`] = L.timelines[d];
    else put[key] = L.timelines[d];
  }
  for (const d of Object.keys(L.suites)) if ((m.skipped || []).includes(`suite@${d}`)) archive[`suite@${d}`] = L.suites[d];
  const prefs = { ...(now.setPrefs || {}) };
  for (const [pid, p] of Object.entries(L.profiles)) {
    const sid = map[pid];
    // 보관본에는 계정 비밀번호를 남기지 않는다(프로필의 인라인 역할 계정, 내 계정의 pass)
    if (!sid) { archive[`profile@${pid}`] = { profile: noSecrets(p), profileLocal: noSecrets(L.profileLocal[pid]), profilePrefs: L.profilePrefs[pid], roleScope: L.roleScope[pid] }; continue; }
    const cur = prefs[sid] || {};
    // 이 PC 전용 프로필의 인라인 역할 계정은 세트 정의에 넣지 않았으므로 내 계정으로 옮긴다. 내가 바꾼 계정이 그 위에
    const inline = p?.local && Array.isArray(p.data?.roles) ? p.data.roles.filter((r) => r?.key && r.account?.user).map((r) => [accKey(r.key), { user: r.account.user, pass: r.account.pass || '' }]) : [];
    const mine = Object.entries(L.profileLocal[pid] || {}).filter(([, a]) => a?.user).map(([k, a]) => [k, { user: a.user, pass: a.pass || '' }]);
    const start = cur.start_url || L.profilePrefs[pid]?.start_url;
    const roles = cur.roles || L.roleScope[pid];
    prefs[sid] = { ...cur, ...(start ? { start_url: start } : {}), accounts: { ...Object.fromEntries([...inline, ...mine]), ...(cur.accounts || {}) }, ...(roles?.length ? { roles } : {}) };
  }
  const next = map[L.activeProfile] || now.activeSet || null;
  await chrome.storage.local.set({ ...put, setPrefs: prefs, activeSet: next,
    ...(Object.keys(archive).length ? { setsMigratedArchive: { ...(now.setsMigratedArchive || {}), ...archive } } : {}) });
  if (L.keys.length) await chrome.storage.local.remove(L.keys);
  await chrome.storage.local.set({ setsMigrated: localDay() });
  setPrefs = prefs;
  return { next, archived: Object.keys(archive) };
}

async function onMigrated(m) {
  if (migrateState !== 'sent') return;
  if (m.ok) {
    try {
      const { next, archived } = await finishMigration(m);
      migrateState = 'done';
      migrationNeeded = false;
      hostNeedsMigration = false;
      legacy = null;
      activeSet = null; // 아래에서 옮긴 세트로 바꾼다(타임라인을 불러오고 호스트에 set 을 보낸다)
      await switchSet(setList.find((s) => s.id === next && s.received)?.id || setList.find((s) => s.received)?.id || null);
      setSentOnOpen = !!activeSet;
      msg('sys', `작업 데이터를 세트로 옮겼습니다 · 세트 ${new Set(Object.values(m.setByProfile || {})).size}개 · 첫 대화는 새 세션으로 시작합니다`);
      for (const s of m.skipped || []) msg('sys', `옮기지 않고 보관만 했습니다: ${s}`);
      if (m.skipped?.length || archived.length) {
        if (m.skipped?.length && m.archive) msg('sys', `보관 위치: ${m.archive}`);
        if (archived.length) msg('sys', `확장 안에 보관만 한 것: ${archived.join(', ')} (setsMigratedArchive)`);
        const d = document.createElement('div');
        d.className = 'sys';
        d.innerHTML = wipSign('archive', { compact: true }); // 보관본을 보는 화면은 아직 없다
        append(d);
      }
      for (const e of m.errors || []) msg('err', e);
    } catch (e) {
      migrateState = 'failed';
      msg('err', `작업 데이터를 세트로 옮기지 못했습니다(확장 저장소: ${e.message || e}) · 원래 데이터는 그대로 두었습니다. 패널을 다시 열면 다시 시도합니다`);
    }
  } else {
    migrateState = 'failed';
    msg('err', `작업 데이터를 세트로 옮기지 못했습니다: ${(m.errors || []).join(' · ') || '알 수 없는 오류'} · 원래 데이터는 그대로 두었습니다. 패널을 다시 열면 다시 시도합니다`);
  }
  renderSetChip();
  renderRoleScope();
  if (sheetMode === 'set') renderSheet();
}

// 처음: 세트·내 설정 → 옮길 예전 데이터 → 그 세트의 타임라인 → 호스트 연결(연결되면 세트 목록과 테스트 목록이 온다)
loadSetState().then(loadLegacy).then(restoreSetData).finally(connect);
