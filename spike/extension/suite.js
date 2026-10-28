// 수행 이력 → TDD·BDD 초안 → 채택/미채택 고르기 → 반영 → 코드 생성(로컬 실행) → 서버 전송
let suite = null;        // 지금 고르는 초안(또는 반영된 묶음)
let suiteBase = 0;       // 서버에 있던 버전(충돌 확인용)
let suiteApplied = false;
let suiteConflict = null; // 서버에 더 새 버전이 있을 때 그 문서
let suiteTab = 'bdd';
let suiteFilter = 'all'; // all | adopted | rejected
let suiteTagFilter = ''; // 이 태그가 붙은 것만(물려받은 것 포함)
let tagAdding = null;    // 태그를 고르는 중인 항목 id
const shown = (c) => (suiteFilter === 'all' || (suiteFilter === 'adopted' ? c.use : !c.use)) && (!suiteTagFilter || effTags(c).includes(suiteTagFilter));

// ── 태그: 서버가 내려준 태그 문서(suite.tag_doc) 기준 ──
// 역할 축은 서버 태그 문서에 없고 프로필 역할로 덧붙인다(호스트 tags.withRoles 와 같은 모양). 예전 초안에도 붙여 보인다
function tagGroups() {
  const gs = suite?.tag_doc?.groups || [];
  const roles = profileRoles();
  if (!roles.length || gs.some((g) => g.id === 'role')) return gs;
  return [...gs, { id: 'role', name: '실행 역할', inherit: true, auto_only: true,
    tags: roles.map((r) => ({ id: `@role-${r.key.toLowerCase()}`, description: `${r.label}로 로그인해 수행` })) }];
}
const tagIndex = () => {
  const m = new Map();
  for (const g of tagGroups()) for (const t of g.tags) m.set(t.id, { ...t, group: g });
  return m;
};
const scenarioOf = (c) => suite.scenarios.find((x) => x.id === c.scenario);
// 케이스는 시나리오의 물려주는 그룹(inherit) 태그를 물려받는다
const inheritedTags = (c) => (c.scenario ? (scenarioOf(c)?.tags || []).filter((t) => tagIndex().get(t)?.group.inherit) : []);
const effTags = (c) => [...new Set([...inheritedTags(c), ...(c.tags || [])])];
// 항목별 문제: 목록에 없는 태그, 하나만인 축에 둘 이상, 이슈가 필요한데 없음
function tagProblems(c) {
  const idx = tagIndex();
  if (!idx.size) return [];
  const out = [];
  const eff = effTags(c);
  for (const t of c.tags || []) if (!idx.has(t)) out.push(`${t}: 서버 태그 목록에 없음`);
  const seen = {};
  for (const t of eff) { const g = idx.get(t)?.group; if (g?.exclusive) (seen[g.id] ||= []).push(t); }
  for (const [g, xs] of Object.entries(seen)) if (xs.length > 1) out.push(`${idx.get(xs[0]).group.name}은 하나만: ${xs.join(', ')}`);
  for (const t of c.tags || []) if (idx.get(t)?.requires === 'issue' && !c.issue?.trim()) out.push(`${t}: 이슈 번호 필요`);
  return out;
}
const allTagProblems = () => [...suite.scenarios, ...suite.cases].filter((c) => c.use).flatMap((c) => tagProblems(c).map((p) => `${c.id} ${p}`));

function tagRow(c) {
  const idx = tagIndex();
  if (!idx.size) return '';
  const inh = inheritedTags(c);
  const chip = (t, own) => {
    const d = idx.get(t);
    const cls = !d ? 'bad' : d.assign === 'human' ? 'human' : '';
    const tip = d ? `${d.group.name} · ${d.description}${own ? '' : ' (시나리오에서 물려받음)'}` : '서버 태그 목록에 없는 태그';
    return `<span class="tchip ${cls} ${own ? '' : 'inh'}" title="${esc(tip)}">${esc(t)}${t === '@known-defect' && c.issue ? ` <b>${esc(c.issue)}</b>` : ''}${own ? `<button type="button" class="tx" data-tag-rm="${esc(c.id)}|${esc(t)}" aria-label="${esc(t)} 빼기">×</button>` : ''}</span>`;
  };
  const picker = tagAdding === c.id ? `<select class="tpick" data-tag-add="${esc(c.id)}"><option value="">태그 고르기…</option>${
    tagGroups().filter((g) => !g.auto_only).map((g) => `<optgroup label="${esc(g.name)}${g.exclusive ? ' (하나만)' : ''}">${g.tags.filter((t) => !effTags(c).includes(t.id))
      .map((t) => `<option value="${esc(t.id)}">${esc(t.id)} — ${esc(t.description)}</option>`).join('')}</optgroup>`).join('')}</select>` : '';
  const needIssue = (c.tags || []).some((t) => idx.get(t)?.requires === 'issue');
  const probs = tagProblems(c);
  return `<div class="tag-row">${inh.map((t) => chip(t, false)).join('')}${(c.tags || []).filter((t) => !inh.includes(t)).map((t) => chip(t, true)).join('')}
    ${picker || `<button type="button" class="tadd" data-tag-open="${esc(c.id)}">+ 태그</button>`}
    ${needIssue ? `<input class="tissue" data-issue="${esc(c.id)}" value="${esc(c.issue || '')}" placeholder="이슈 번호 (예: FE #1212)">` : ''}
    ${probs.length ? `<span class="tprob" title="${esc(probs.join('\n'))}">⚠ ${esc(probs[0])}${probs.length > 1 ? ` 외 ${probs.length - 1}` : ''}</span>` : ''}</div>`;
}
// 코드는 만들 때의 채택 목록에 묶인다. 채택이 바뀌면 다시 만들어야 서버로 보낼 수 있다
// 태그·이슈가 바뀌어도 코드를 다시 만들어야 한다
const adoptedKey = (x = suite) => [...x.scenarios, ...x.cases].filter((c) => c.use).map((c) => `${c.id}:${(c.tags || []).join('+')}:${c.issue || ''}`).join(',');
// 채택 목록(id)은 같고 태그·이슈만 바뀌었으면 AI 없이 태그만 바꿔 끼운다
const idsKey = (k) => (k || '').split(',').map((x) => x.split(':')[0]).join(',');
const tagsOnly = () => !!suite?.code?.source && !suite.code.running && suite.code.key !== adoptedKey() && idsKey(suite.code.key) === idsKey(adoptedKey());
// 코드는 지금 채택·태그와 맞는데 유효한 실행 결과만 없으면: 다시 만들 필요 없이 실행만 하면 된다
const adopted = () => [...suite.scenarios, ...suite.cases].filter((c) => c.use);
// 채택했는데 실행 결과가 없는 항목(코드는 있음)
const notRun = () => adopted().filter((c) => testFor(c.id, suite.code?.listed) && !testFor(c.id, suite.code?.results)).map((c) => c.id);
const needRun = () => !!suite?.code?.source && !suite.code.running && (suite.code.listed || []).length > 0 && notRun().length > 0 && codeMatches();
// 채택했는데 코드에 없는 항목: 다른 항목의 코드가 맞으면 새 것만 덧붙인다
const missingCode = () => (suite?.code?.listed ? adopted().filter((c) => !testFor(c.id, suite.code.listed)).map((c) => c.id) : []);
const canAppend = () => !!suite?.code?.source && !suite.code.running && missingCode().length > 0 && codeMatches(missingCode());
// 지금 코드가 채택 목록·태그와 맞는가(작성 목록과 태그로 판단, 실행 여부와 무관). except: 아직 코드가 없어도 되는 id
function codeMatches(except = []) {
  const xs = suite.code.listed || [];
  return adopted().filter((c) => !except.includes(c.id)).every((c) => {
    const t = testFor(c.id, xs);
    if (!t) return false;
    const want = c.scenario ? effTags(c) : (c.tags || []);
    return [...want].sort().join(' ') === [...new Set(t.tags || [])].sort().join(' ');
  });
}
// 서버로 보낼 수 있는 상태: 코드가 지금 목록과 맞고, 채택한 항목 모두 실행 결과가 있다
const codeFresh = () => !!suite?.code?.source && !suite.code.running && suite.code.key === adoptedKey() && !missingCode().length && !notRun().length;
let addOpen = false; // 테스트 추가 입력란을 연 상태
let scopeOpen = false; // 범위 설명을 펼친 상태(다시 그려도 유지)
const rejectTag = (c) => (c.use ? '' : '<span class="tag reject">미채택</span>');

// 초안은 바뀔 때마다 확장 저장소에 저장한다(패널을 닫거나 확장을 다시 올려도 다시 만들 필요 없게)
function saveSuite() {
  chrome.storage.local.set({ suiteDraft: suite ? { suite, suiteBase, suiteApplied } : null }).catch(() => {});
}
(async () => {
  const { suiteDraft } = await chrome.storage.local.get('suiteDraft').catch(() => ({}));
  if (suiteDraft?.suite) ({ suite, suiteBase, suiteApplied } = suiteDraft);
  else {
    // 확장 저장소가 비었으면 호스트가 남긴 최근 초안 사본을 불러온다
    try {
      const d = await (await fetch('http://127.0.0.1:8765/drafts/latest')).json();
      if (d) { const { base_version, ...rest } = d; suite = rest; suiteBase = base_version ?? 0; suiteApplied = false; saveSuite(); }
    } catch {}
  }
  // 태그 문서가 없으면(이전 초안) 서버에서 받는다
  if (suite && !suite.tag_doc) {
    try {
      const id = profiles?.[activeId]?.data?.tags || 'qa-tags';
      const r = await fetch(`http://127.0.0.1:8765/sync/tags/${id}`);
      if (r.ok) { suite.tag_doc = await r.json(); saveSuite(); }
    } catch {}
  }
  if (suite) $('suite-hint').textContent = `저장된 테스트 초안: ${suite.name} · 테스트 목록에서 이어서 고를 수 있습니다`;
})();

const PRIO = { high: '높음', medium: '중간', low: '낮음' };
const prioTag = (p) => `<span class="prio ${p}">${PRIO[p] || p}</span>`;
const lis = (xs) => (xs || []).map((x) => `<li>${esc(x)}</li>`).join('');

function recordedSteps() {
  return [...stepEls.values()].filter((el) => el.classList.contains('ok') && !el.classList.contains('read')).length;
}
function updateDeriveBtn() {
  const n = recordedSteps();
  $('derive-btn').disabled = aiBusy || !n || !$('env-alert').hidden;
  $('suite-hint').textContent = n ? `이번 수행 ${n}단계 · 이 이력으로 TDD·BDD 테스트를 만들 수 있습니다` : '테스트를 수행한 뒤, 그 이력으로 TDD·BDD 테스트를 만들 수 있습니다';
}
$('derive-btn').onclick = () => {
  if (ws?.readyState !== 1) return;
  msg('me', '이 수행 이력으로 TDD·BDD 테스트를 만들어줘');
  ws.send(JSON.stringify({ type: 'derive' }));
};
$('plan-btn').onclick = () => { requestCodeList(); openSheet('suite'); };

function onSuiteTags(m) {
  if (!suite || suite.id !== m.id) return;
  for (const c of [...suite.scenarios, ...suite.cases]) if (m.tags[c.id]) c.tags = m.tags[c.id];
  suite.tag_doc = m.tag_doc; suite.tag_source = m.tag_source;
  saveSuite();
  msg('sys', `태그를 붙였습니다 (${m.tag_source}) · 테스트 목록에서 확인하고 고치세요`);
  if (sheetMode === 'suite') renderSheet();
}

function onSuiteDraft(draft, base, tagDoc) {
  if (tagDoc) draft.tag_doc = tagDoc;
  for (const c of [...draft.scenarios, ...draft.cases]) if (c.use === undefined) c.use = c.adopted !== false;
  if (suite && suite.id === draft.id) {
    const offS = new Set(suite.scenarios.filter((c) => !c.use).map((c) => c.id));
    const offC = new Set(suite.cases.filter((c) => !c.use).map((c) => c.id));
    draft.scenarios.forEach((c) => { if (offS.has(c.id)) c.use = false; });
    draft.cases.forEach((c) => { if (offC.has(c.id)) c.use = false; });
  }
  if (suite && suite.id === draft.id) {
    // 사람이 붙인 태그·이슈는 새 초안에도 남긴다
    for (const c of [...draft.scenarios, ...draft.cases]) {
      const old = [...suite.scenarios, ...suite.cases].find((x) => x.id === c.id);
      if (!old) continue;
      const human = (old.tags || []).filter((t) => tagIndex().get(t)?.assign === 'human');
      c.tags = [...new Set([...(c.tags || []), ...human])];
      if (old.issue) c.issue = old.issue;
    }
  }
  suite = draft; suiteBase = base; suiteApplied = false; suiteTab = 'coverage';
  saveSuite();
  const card = document.createElement('div');
  card.className = 'plan-card';
  card.innerHTML = `<div><b>테스트 초안</b> ${esc(draft.name)}</div>
    <div class="plan-card-meta">흐름 ${draft.flow?.length || 0}단계 · BDD ${draft.scenarios.length}개 · TDD ${draft.cases.length}개 · 사용할 것을 골라 반영하세요</div>
    <button type="button" class="btn sm open-suite">고르기</button>`;
  append(card);
  openSheet('suite');
}

function onSuiteCode(m) {
  if (!suite || suite.id !== m.id) return;
  // 실행 결과가 없거나(중단·오류) 읽지 못했으면 서버로 보낼 수 없게 키를 비운다
  const key = m.running ? adoptedKey() : (m.error || !m.results?.length) ? '' : suite.code?.key ?? adoptedKey();
  // 일부만 실행했으면(merge) 지난 결과에 새 결과를 합친다
  const prev = suite.code?.results || [];
  const results = m.merge ? (m.running ? prev : [...prev.filter((r) => !(m.results || []).some((x) => x.title === r.title)), ...(m.results || [])]) : m.results;
  suite.code = { source: m.code, file: m.file, env: m.env, key, running: !!m.running, results, summary: m.summary, error: m.error, ran_at: m.ran_at, tag_mismatch: m.tag_mismatch,
    progress: m.running ? { total: 0, n: 0, done: [], current: null, steps: [] } : undefined,
    listed: suite.code?.listed };
  saveSuite();
  if (sheetMode === 'suite') renderSheet();
}

// 테스트 추가로 온 새 항목을 덧붙인다(기존 항목·채택·태그는 그대로)
function onSuiteAdd(m) {
  if (!suite || suite.id !== m.id) return;
  const have = new Set([...suite.scenarios, ...suite.cases].map((c) => c.id));
  suite.scenarios.push(...m.scenarios.filter((c) => !have.has(c.id)));
  suite.cases.push(...m.cases.filter((c) => !have.has(c.id)));
  if (m.flow?.length) suite.flow = [...(suite.flow || []), ...m.flow];
  suiteApplied = false;
  suiteTab = m.scenarios.length ? 'bdd' : 'tdd';
  saveSuite();
  msg('sys', `새 항목이 추가됐습니다 · 시나리오 ${m.scenarios.length} · 케이스 ${m.cases.length} · 고른 뒤 반영하세요`);
  openSheet('suite');
}

function onSuiteListed(m) {
  if (!suite?.code || suite.id !== m.id) return;
  suite.code.listed = m.tests;
  saveSuite();
  if (sheetMode === 'suite') renderSheet();
}
// 패널을 열 때 작성 목록이 없으면 받아 온다(실행 없음)
function requestCodeList() {
  if (suite?.code?.source && !suite.code.listed && !suite.code.running && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'list_code', id: suite.id }));
}

// 태그만 바꿔 끼운 결과: 통과하면 코드와 태그를 갱신하고 지난 실행 결과는 그대로 둔다
function onSuiteRetag(m) {
  if (!suite?.code || suite.id !== m.id) return;
  if (!m.ok) {
    msg('err', `태그만 반영하지 못했습니다: ${m.error || `빠진 테스트 ${m.missing?.length || 0} · 태그 불일치 ${m.tag_mismatch?.length || 0}`} · 코드를 다시 생성하세요`);
    if (m.code) suite.code.source = m.code;
    suite.code.tag_mismatch = m.tag_mismatch;
    suite.code.key = ''; // 다시 생성해야 서버로 보낼 수 있다
  } else {
    suite.code.listed = m.results;
    const byTitle = new Map(m.results.map((r) => [r.title, r.tags]));
    for (const r of suite.code.results || []) if (byTitle.has(r.title)) r.tags = byTitle.get(r.title);
    suite.code.source = m.code;
    suite.code.tag_mismatch = [];
    suite.code.key = suite.code.results?.length ? adoptedKey() : ''; // 유효한 실행 결과가 있어야 서버로 보낼 수 있다
    suite.code.retagged_at = new Date().toISOString();
    msg('sys', '태그를 코드에 반영했습니다 · 지난 실행 결과를 그대로 씁니다');
  }
  saveSuite();
  if (sheetMode === 'suite') renderSheet();
}

// 호스트와 다시 연결되면 끊기기 전의 "실행 중" 표시를 푼다(호스트가 다시 켜지면 그 실행은 끝난 것)
function clearStaleRun() {
  requestCodeList();
  if (!suite?.code?.running) return;
  suite.code.running = false;
  suite.code.error = '호스트가 다시 켜져 이전 실행이 중단되었습니다. 코드를 다시 생성하세요';
  suite.code.key = '';
  saveSuite();
  if (sheetMode === 'suite') renderSheet();
}

// 로컬 실행 중 테스트별 진행: 끝난 테스트, 지금 도는 테스트와 그 단계
function onSuiteCodeProgress(m) {
  if (!suite?.code || suite.id !== m.id) return;
  const p = suite.code.progress ||= { total: 0, n: 0, done: [], current: null, steps: [] };
  p.total = m.total || p.total;
  if (m.ev === 'test') { p.current = m.title; p.steps = []; }
  if (m.ev === 'step' && m.test === p.current) p.steps.push({ title: m.title, status: m.status });
  if (m.ev === 'done') { p.n = m.n; p.done.push({ title: m.title, status: m.status, ms: m.ms, steps: p.steps.length ? p.steps : undefined }); p.current = null; p.steps = []; }
  if (sheetMode === 'suite' && suiteTab === 'code') renderSheet();
}

function onSuitePublished(m) {
  if (!m.ok) {
    suiteConflict = m.current || null;
    msg('err', `서버 전송 실패: ${m.error}`);
    if (sheetMode === 'suite') renderSheet();
    return;
  }
  suiteConflict = null;
  suiteBase = m.version;
  saveSuite();
  msg('sys', `테스트 묶음을 서버로 보냈습니다 (v${m.version})`);
  if (sheetMode === 'suite') renderSheet();
}

function renderSuiteSheet(body) {
  $('sheet-title').textContent = '테스트 목록';
  if (!suite) {
    body.innerHTML = `<div class="none">아직 만든 테스트가 없습니다.<br>테스트를 수행한 뒤 <b>이 수행으로 테스트 생성</b>을 누르세요.</div>`;
    return;
  }
  const useS = suite.scenarios.filter((c) => c.use).length;
  const useC = suite.cases.filter((c) => c.use).length;
  const cov = suite.coverage || [];
  const todo = cov.filter((c) => c.status === '미수행').length;
  // 탭: [키, 이름, 배지, 배지 색, 설명]. 배지는 그 탭의 핵심 숫자 하나
  const code = codeTabInfo();
  const tabs = [
    ['coverage', '예외 점검표', todo ? `미수행 ${todo}` : `${cov.length}`, todo ? 'warn' : '', '예외·오류 항목별로 수행했는지'],
    ['flow', '흐름', `${suite.flow?.length || 0}`, '', '수행한 업무 흐름(화면·입력·메시지)'],
    ['bdd', 'BDD', `${useS}/${suite.scenarios.length}`, '', `시나리오 · 채택 ${useS} / 전체 ${suite.scenarios.length}`],
    ['tdd', 'TDD', `${useC}/${suite.cases.length}`, '', `케이스 · 채택 ${useC} / 전체 ${suite.cases.length}`],
    ['code', '테스트 코드', code.badge, code.tone, code.tip],
  ];
  body.innerHTML = `<div class="plan">
    <div class="pf-row"><b>${esc(suite.name)}</b><span class="grow"></span>
      <button type="button" class="btn sm" data-suite="add-open" ${aiBusy ? 'disabled' : ''} title="생각한 시나리오나 누락된 테스트를 이 묶음에 덧붙입니다(기존 항목은 그대로)">+ 테스트 추가</button>
      <span class="tag ${suiteApplied ? '' : 'warn'}">${suiteApplied ? '반영됨' : '고르는 중'}</span>
      ${suiteBase ? `<span class="tag">서버 v${suiteBase}</span>` : ''}</div>
    ${addOpen ? `<div class="add-box"><textarea id="add-req" rows="3" placeholder="추가할 시나리오나 누락된 테스트를 적으세요. 예: 주문 목록에서 상품명으로 검색해 찾는다"></textarea>
      <div class="add-act"><span class="pf-hint">AI가 브라우저에서 직접 해 본 뒤 새 항목만 덧붙입니다. 안 쓸 기존 항목은 미채택하세요.</span><span class="grow"></span>
        <button type="button" class="btn sm" data-suite="add-cancel">취소</button><button type="button" class="primary sm" data-suite="add-send">추가 요청</button></div></div>` : ''}
    <details class="scope-d" ${scopeOpen ? 'open' : ''}><summary><span class="scope-k">범위</span><span class="scope-peek">${esc(suite.scope || '-')}</span></summary>
      <div class="scope-full">${esc(suite.scope || '-')}</div></details>
    <div class="st-tabs" role="tablist">${tabs.map(([k, name, badge, tone, tip]) => `<button type="button" role="tab" aria-selected="${k === suiteTab}" class="st-tab ${k === suiteTab ? 'on' : ''}" data-stab="${k}" title="${esc(tip)}">
      <span class="st-name">${esc(name)}</span>${badge ? `<span class="st-badge ${tone}">${esc(badge)}</span>` : ''}</button>`).join('')}</div>
    ${suiteTab === 'coverage' ? coverageView() : suiteTab === 'flow' ? flowView() : suiteTab === 'bdd' ? bddView() : suiteTab === 'tdd' ? tddView() : codeView()}
    <div class="suite-actions">
    ${suiteConflict ? `<div class="pf-alert suite-conflict">서버에 이 테스트 묶음의 v${suiteConflict.version}이 이미 있습니다(지금 초안의 기준: v${suiteBase || '없음'}).
      <span class="grow"></span>
      <button type="button" class="btn sm" data-suite="take-server">서버 v${suiteConflict.version} 불러오기</button>
      <button type="button" class="btn sm" data-suite="overwrite">덮어써서 v${suiteConflict.version + 1}로 올리기</button></div>` : ''}
      ${allTagProblems().length ? `<div class="pf-alert suite-conflict">태그 문제 ${allTagProblems().length}건 — 고쳐야 코드를 만들 수 있습니다: ${esc(allTagProblems().slice(0, 3).join(' / '))}${allTagProblems().length > 3 ? ' …' : ''}</div>` : ''}
      <span class="pf-hint">채택 BDD ${useS}/${suite.scenarios.length} · TDD ${useC}/${suite.cases.length}${suite.tag_source ? ` · 태그 ${esc(suite.tag_source)}` : ''}
        · ${!suiteApplied ? '<b class="next-step">고른 뒤 반영 → 코드 생성 → 서버 전송</b>'
          : suite.code?.running ? '코드를 로컬에서 실행하는 중…'
          : canAppend() ? `<b class="next-step">코드가 없는 새 항목 ${missingCode().length}개 · 새 테스트 코드만 추가하세요</b>`
          : needRun() ? `<b class="next-step">실행 결과가 없는 테스트 ${notRun().length}개 · 실행해야 서버로 보낼 수 있습니다</b>`
          : tagsOnly() ? '<b class="next-step">태그·이슈만 바뀌었습니다 · 태그만 코드에 반영하세요(실행 없음)</b>'
          : !codeFresh() ? `<b class="next-step">${suite.code?.source ? '채택이 바뀌었습니다 · 코드를 다시 생성하세요' : '반영됨 · 코드를 생성하세요'}</b>`
          : `로컬 실행 통과 ${suite.code.summary?.passed ?? 0}/${suite.code.results?.length ?? 0}${suite.code.summary?.failed ? ` · 실패 ${suite.code.summary.failed}` : ''}${suiteBase ? ` · 서버 v${suiteBase}` : ''}`}</span>
      <span class="grow"></span>
      <button type="button" class="btn" data-suite="reinforce" ${todo ? '' : 'disabled'} title="미수행 예외·오류를 실제로 수행하고(필요하면 오류 주입) 초안을 갱신합니다">예외·오류 보강 수행</button>
      <button type="button" class="btn" data-suite="apply" ${suiteApplied ? 'disabled' : ''}>반영</button>
      <button type="button" class="btn" data-suite="tags" title="서버 태그 목록 기준으로 자동 태그와 AI 판단 태그를 붙입니다(사람이 붙인 태그는 유지)">태그 붙이기</button>
      ${tagsOnly() ? `<button type="button" class="primary" data-suite="retag" ${suiteApplied && !allTagProblems().length ? '' : 'disabled'} title="태그·이슈만 바뀌었습니다. AI 없이 코드의 태그만 바꾸고 목록 검사만 합니다(테스트 실행 없음, 지난 실행 결과 유지)">태그만 코드에 반영</button>` : ''}
      ${canAppend() ? `<button type="button" class="primary" data-suite="append" ${suiteApplied && !aiBusy && !allTagProblems().length ? '' : 'disabled'} title="코드가 없는 새 항목만 AI가 써서 기존 파일 끝에 덧붙이고, 새 테스트만 실행합니다">새 테스트 코드 추가 (${missingCode().length})</button>` : ''}
      ${needRun() ? `<button type="button" class="primary" data-suite="run" ${aiBusy ? 'disabled' : ''} title="코드는 그대로 두고, 실행 결과가 없는 테스트만 실행합니다(AI 없음)">테스트 실행 (${notRun().length})</button>` : ''}
      <button type="button" class="${suiteApplied && !codeFresh() && !tagsOnly() && !needRun() && !canAppend() ? 'primary' : 'btn'}" data-suite="code" ${suiteApplied && !suite.code?.running && !allTagProblems().length ? '' : 'disabled'} title="채택한 테스트로 Playwright 코드를 만들고 로컬에서 실행해 확인합니다">${suite.code?.source ? '코드 다시 생성' : '코드 생성'}</button>
      <button type="button" class="${codeFresh() ? 'primary' : 'btn'}" data-suite="publish" ${suiteApplied && codeFresh() ? '' : 'disabled'} title="${codeFresh() ? '코드와 실행에 필요한 환경변수 목록을 함께 보냅니다' : '먼저 코드를 생성하세요'}">서버 전송</button>
    </div>
  </div>`;
}

// "작성됨"(코드에 있음, --list로 확인)과 "실행 결과"를 따로 센다
const codeTests = () => suite.code?.listed || suite.code?.results || [];
// 역할마다 나눈 테스트('<id> [ADMIN] …')는 여럿이다. 결과는 실패한 것을 먼저, 태그는 모두 합쳐 본다
const testsFor = (id, xs) => (xs || []).filter((t) => t.title === id || t.title.startsWith(`${id} `));
const testFor = (id, xs) => {
  const ms = testsFor(id, xs);
  if (ms.length < 2) return ms[0];
  const pick = ms.find((t) => t.status === 'failed') || ms.find((t) => t.status && t.status !== 'passed') || ms[0];
  return { ...pick, tags: [...new Set(ms.flatMap((t) => t.tags || []))], roles: ms.length };
};
// 테스트 코드 탭의 배지: 작성 수, 실패가 있으면 실패 수(빨강), 미실행이 있으면 미실행(주황), 모두 통과면 초록
function codeTabInfo() {
  const c = suite.code;
  if (!c?.source) return { badge: '없음', tone: '', tip: '아직 테스트 코드를 만들지 않았습니다' };
  const n = codeTests().length;
  if (c.running) return { badge: '실행 중', tone: 'run', tip: codeTabLabel() };
  const res = codeTests().map((t) => testFor(t.title, c.results));
  const fail = res.filter((r) => r?.status === 'failed').length;
  const none = res.filter((r) => !r).length;
  return fail ? { badge: `실패 ${fail}`, tone: 'fail', tip: codeTabLabel() }
    : none ? { badge: `${n} · 미실행 ${none}`, tone: 'warn', tip: codeTabLabel() }
    : { badge: `${n} 통과`, tone: 'ok', tip: codeTabLabel() };
}
function codeTabLabel() {
  const c = suite.code;
  if (!c?.source) return '테스트 코드';
  const n = codeTests().length;
  if (c.running) return `테스트 코드 ${n} · 실행 중`;
  // 작성된 테스트 기준으로 통과·실패·미실행을 센다(일부만 실행했을 때 '6/6'처럼 보이지 않게)
  const res = codeTests().map((t) => testFor(t.title, c.results));
  const pass = res.filter((r) => r?.status === 'passed').length;
  const fail = res.filter((r) => r?.status === 'failed').length;
  const none = res.filter((r) => !r).length;
  return `테스트 코드 ${n} · ${[pass && `통과 ${pass}`, fail && `실패 ${fail}`, none && `미실행 ${none}`].filter(Boolean).join(' · ') || '미실행'}`;
}
// BDD·TDD 카드에 붙이는 코드 상태: 코드 없음 / 미실행 / 통과·실패·보류
function codeBadge(item) {
  const c = suite.code;
  if (!c?.source || !item.use) return '';
  if (!testFor(item.id, codeTests())) return '<span class="tag warn" title="채택했지만 테스트 코드에 없습니다">코드 없음</span>';
  const r = testFor(item.id, c.results);
  const st = !r ? ['', '코드 · 미실행'] : r.status === 'passed' ? ['ok', '코드 · 통과'] : r.status === 'failed' ? ['err', '코드 · 실패'] : ['', '코드 · 보류'];
  return `<span class="tag ${st[0]}" title="테스트 코드에 작성됨${r ? ` · 마지막 실행 ${esc(r.status)}` : ' · 아직 실행하지 않음'}">${st[1]}</span>`;
}

function codeView() {
  const c = suite.code;
  const ref = `<details class="case-d"><summary>녹화 기반 참고 코드(수행 전체)</summary><pre class="cs-pre mono">${esc(suite.spec || '(없음)')}</pre></details>`;
  if (!c?.source) return `<div class="none">아직 코드가 없습니다. 반영한 뒤 <b>코드 생성</b>을 누르면 채택한 테스트만 코드로 만들고 로컬에서 돌려 봅니다.</div>${ref}`;
  const icon = { passed: ['ok', '통과'], failed: ['err', '실패'], skipped: ['', '보류'], notrun: ['', '미실행'] };
  const row = (r) => `<div class="case run-row">
    <div class="case-h"><span class="tag ${icon[r.status][0]}">${icon[r.status][1]}</span><b class="case-title">${esc(r.title)}</b>
      <span class="grow"></span>${(r.tags || []).map((t) => `<span class="tchip mini">${esc(t)}</span>`).join('')}<span class="pf-hint">${r.ms ? `${(r.ms / 1000).toFixed(1)}초` : ''}</span></div>
    ${r.steps ? `<div class="gwt run-steps">${r.steps.map((x) => `<div class="${x.status}"><span class="kw">${esc(x.title.split(' ')[0])}</span>${esc(x.title.slice(x.title.indexOf(' ') + 1))}</div>`).join('')}</div>` : ''}
    ${r.error ? `<pre class="cs-pre mono run-err">${esc(r.error)}</pre>` : ''}</div>`;
  // BDD 시나리오 테스트와 TDD 케이스 테스트를 나눠 보여 준다
  // 작성된 테스트 목록을 기준으로, 실행 결과가 있으면 붙인다(없으면 미실행)
  const part = (kind, label) => {
    const xs = codeTests().filter((t) => (t.kind || 'tdd') === kind).map((t) => ({ ...t, ...(testFor(t.title, c.results) || { status: 'notrun' }) }));
    if (!xs.length) return '';
    const ran = xs.filter((r) => r.status !== 'notrun');
    return `<div class="run-part"><b>${label}</b> <span class="pf-hint">작성 ${xs.length}${ran.length ? ` · 통과 ${ran.filter((r) => r.status === 'passed').length}/${ran.length}` : ' · 미실행'}</span></div>${xs.map(row).join('')}`;
  };
  const mis = c.tag_mismatch?.length ? `<div class="pf-alert">코드의 태그가 목록과 다른 테스트 ${c.tag_mismatch.length}개: ${c.tag_mismatch.map((x) => `${esc(x.id)}(목록 ${esc(x.want)} / 코드 ${esc(x.got)})`).join(', ')}</div>` : '';
  const rows = mis + part('bdd', 'BDD 시나리오') + part('tdd', 'TDD 케이스');
  const why = c.running ? '' : needRun() ? ' · <b class="next-step">실행 결과 없음 · 테스트 실행 필요</b>' : tagsOnly() ? ' · <b class="next-step">태그만 바뀜 · 태그만 코드에 반영</b>' : c.key !== adoptedKey() ? ' · <b class="next-step">채택이 바뀌어 다시 생성해야 합니다</b>' : '';
  return `<div class="pf-hint" style="margin:0 0 6px">${esc(c.file)}${why}
      <br>실행 환경이 채울 값: <span class="mono">${(c.env || []).map(esc).join(', ')}</span></div>
    ${c.running ? progressView(c.progress, row) : rows || (c.error ? `<pre class="cs-pre mono run-err">${esc(c.error)}</pre>` : '')}
    <details class="case-d" open><summary>코드</summary><pre class="cs-pre mono">${esc(c.source)}</pre></details>${ref}`;
}

function progressView(p, row) {
  if (!p?.total) return '<div class="none">로컬 실행을 준비하는 중…</div>';
  const pct = Math.round((p.n / p.total) * 100);
  return `<div class="run-prog"><div class="run-bar"><i style="width:${pct}%"></i></div>
      <span class="pf-hint">${p.n}/${p.total} · 통과 ${p.done.filter((r) => r.status === 'passed').length} · 실패 ${p.done.filter((r) => r.status === 'failed').length}</span></div>
    ${p.current ? `<div class="case run-row running"><div class="case-h"><span class="tag run">실행 중</span><b class="case-title">${esc(p.current)}</b></div>
      ${p.steps.length ? `<div class="gwt run-steps">${p.steps.map((x) => `<div class="${x.status}"><span class="kw">${esc(x.title.split(' ')[0])}</span>${esc(x.title.slice(x.title.indexOf(' ') + 1))}</div>`).join('')}</div>` : ''}</div>` : ''}
    ${[...p.done].reverse().map(row).join('')}`;
}

function coverageView() {
  const cov = suite.coverage || [];
  if (!cov.length) return '<div class="none">점검표가 없습니다(이전 형식 초안). 테스트를 다시 생성하세요.</div>';
  return cov.map((c) => `<div class="case cov-row">
    <div class="case-h"><span class="tag ${c.status === '수행' ? 'ok' : c.status === '미수행' ? 'warn' : ''}">${esc(c.status)}</span>
      <b class="case-title">${esc(c.category)}</b></div>
    <div class="cov-note">${esc(c.note)}</div>
  </div>`).join('') + `<div class="pf-hint" style="margin:8px 0 0">미수행 항목은 <b>예외·오류 보강 수행</b>으로 실제로 확인합니다. 서버 오류·지연·네트워크 끊김은 브라우저에서 오류를 주입해 확인하며, 실제 서버에는 요청이 가지 않습니다.</div>`;
}

function flowView() {
  return (suite.flow || []).map((f) => `<div class="case">
    <div class="case-h"><b class="case-title">${esc(f.step)}</b><span class="grow"></span><span class="mono case-id">${esc(f.screen)}</span></div>
    ${f.inputs?.length ? `<div class="case-sec"><b>입력</b><ul>${f.inputs.map((x) => `<li>${esc(x.name)}${x.required ? ' <span class="tag warn">필수</span>' : ''}${x.options?.length ? ` — ${esc(x.options.join(' / '))}` : ''}${x.note ? ` <span class="pf-hint">${esc(x.note)}</span>` : ''}</li>`).join('')}</ul></div>` : ''}
    ${f.tab_order?.length ? `<div class="case-sec"><b>탭 순서</b> <span class="mono">${esc(f.tab_order.join(' → '))}</span></div>` : ''}
    ${f.messages?.length ? `<div class="case-sec"><b>메시지</b><ul>${lis(f.messages)}</ul></div>` : ''}
    ${f.request ? `<div class="case-sec ev"><b>요청</b> <span class="mono">${esc(f.request)}</span></div>` : ''}
  </div>`).join('');
}

function filterBar() {
  const n = (xs, f) => xs.filter(f).length;
  const list = suiteTab === 'tdd' ? suite.cases : suite.scenarios;
  return `<div class="filter-row"><div class="seg filter-seg">${[['all', `전체 ${list.length}`], ['adopted', `채택 ${n(list, (c) => c.use)}`], ['rejected', `미채택 ${n(list, (c) => !c.use)}`]]
    .map(([k, label]) => `<button type="button" data-filter="${k}" class="${suiteFilter === k ? 'on' : ''}">${label}</button>`).join('')}</div>
    ${tagIndex().size ? `<select class="tfilter" data-tag-filter><option value="">모든 태그</option>${[...tagIndex().keys()].map((t) => {
      const n = list.filter((c) => effTags(c).includes(t)).length;
      return n ? `<option value="${esc(t)}" ${suiteTagFilter === t ? 'selected' : ''}>${esc(t)} (${n})</option>` : '';
    }).join('')}</select>` : ''}</div>`;
}

function bddView() {
  return filterBar() + suite.scenarios.filter(shown).map((c) => {
    const tdd = suite.cases.filter((x) => x.scenario === c.id);
    return `<div class="case ${c.use ? '' : 'off'}">
      <div class="case-h"><input type="checkbox" data-use-s="${esc(c.id)}" ${c.use ? 'checked' : ''} title="${c.use ? '채택됨 · 해제하면 미채택(보관)' : '미채택 · 체크하면 다시 채택'}">
        ${prioTag(c.priority)}<span class="mono case-id">${esc(c.id)}</span>${roleTag(c)}<b class="case-title">${esc(c.title)}</b>
        <span class="grow"></span>${c.added ? '<span class="tag new">새로</span>' : ''}${rejectTag(c)}${codeBadge(c)}${c.changes_data ? '<span class="tag warn">데이터 변경</span>' : ''}</div>
      ${tagRow(c)}
      <div class="gwt">
        ${c.given.map((x, i) => `<div><span class="kw">${i ? 'And' : 'Given'}</span>${esc(x)}</div>`).join('')}
        ${c.when.map((x, i) => `<div><span class="kw">${i ? 'And' : 'When'}</span>${esc(x)}</div>`).join('')}
        ${c.then.map((x, i) => `<div><span class="kw">${i ? 'And' : 'Then'}</span>${esc(x)}</div>`).join('')}
      </div>
      <details class="case-d"><summary>TDD 케이스 ${tdd.length} · 근거</summary>
        ${tdd.length ? `<div class="case-sec"><ul>${tdd.map((x) => `<li><span class="mono case-id">${esc(x.id)}</span> [${esc(x.technique)}] ${esc(x.title)}</li>`).join('')}</ul></div>` : ''}
        <div class="case-sec ev"><b>근거</b> <span class="mono">${(c.screens || []).map(esc).join(', ')}</span><div>${esc(c.evidence)}</div></div>
      </details></div>`;
  }).join('');
}

// 시나리오를 수행하는 역할. 적혀 있지 않은 옛 시나리오는 기본 역할로 돈다
function roleTag(c) {
  if (c.roles) return Object.entries(c.roles).map(([k, v]) => {
    const deny = !/^허용/.test(v);
    return `<span class="role-tag${deny ? ' deny' : ''}" title="${esc(roleLabel(k))}: ${esc(v)}">${esc(roleLabel(k))} ${deny ? '✕' : '✓'}</span>`;
  }).join('');
  const key = c.as || defaultRoleKey();
  if (!key) return '';
  return `<span class="role-tag${c.as ? '' : ' dim'}" title="${c.as ? '이 역할 계정으로 로그인해 수행' : '역할이 적혀 있지 않아 기본 역할로 수행'}">${esc(roleLabel(key))}${c.as ? '' : ' · 기본'}</span>`;
}

// TDD 카드의 연관 BDD 시나리오 배지(참조 아이콘). 누르면 BDD 탭의 그 시나리오로 간다
function scRef(id) {
  const sc = suite.scenarios.find((c) => c.id === id);
  return `<button type="button" class="sc-ref" data-goto-s="${esc(id)}" title="연관 BDD 시나리오${sc ? `: ${esc(sc.title)}` : ''}\n누르면 BDD 탭에서 봅니다">${esc(id)}</button>`;
}

// TDD 케이스: BDD처럼 한 장의 카드로. 머리줄(체크·우선순위·ID·기법·제목) + 입력/기대/검증 세 줄
function tddView() {
  return filterBar() + suite.cases.filter(shown).map((x) => `<div class="case tc ${x.use ? '' : 'off'}">
    <div class="case-h">
      <input type="checkbox" data-use-c="${esc(x.id)}" ${x.use ? 'checked' : ''} title="${x.use ? '채택됨 · 해제하면 미채택(보관)' : '미채택 · 체크하면 다시 채택'}">
      ${prioTag(x.priority)}<span class="mono case-id">${esc(x.id)}</span><span class="tag">${esc(x.technique)}</span>
      <b class="case-title">${esc(x.title)}</b>
      <span class="grow"></span>${x.added ? '<span class="tag new">새로</span>' : ''}${rejectTag(x)}${codeBadge(x)}${scRef(x.scenario)}
    </div>
    ${tagRow(x)}
    <div class="tc-rows">
      <div><span class="tc-k" title="입력값·조건">Input</span><span>${esc(x.input)}</span></div>
      <div><span class="tc-k" title="기대 결과">Expected</span><span>${esc(x.expected)}</span></div>
      <div><span class="tc-k" title="검증 방법">Assert</span><span class="mono">${esc(x.check)}</span></div>
    </div>
  </div>`).join('');
}

const act0 = (e) => e.target.closest('[data-suite]')?.dataset.suite;
// 태그 고르기·태그 필터·이슈 번호 입력
// 범위 설명 접기·펼치기 상태를 기억한다(목록은 자주 다시 그려진다)
document.getElementById('sheet-body').addEventListener('toggle', (e) => {
  if (sheetMode === 'suite' && e.target.classList?.contains('scope-d')) scopeOpen = e.target.open;
}, true);

document.getElementById('sheet-body').addEventListener('change', (e) => {
  if (sheetMode !== 'suite' || !suite) return;
  const add = e.target.dataset.tagAdd;
  if (add !== undefined) {
    const t = e.target.value;
    const c = [...suite.scenarios, ...suite.cases].find((x) => x.id === add);
    tagAdding = null;
    if (t) {
      const idx = tagIndex();
      const g = idx.get(t).group;
      // 하나만인 축은 바꿔 끼운다
      c.tags = [...(c.tags || []).filter((x) => !(g.exclusive && idx.get(x)?.group.id === g.id)), t];
      saveSuite();
    }
    renderSheet();
    if (t && idx0(t)?.requires === 'issue') document.querySelector(`[data-issue="${CSS.escape(add)}"]`)?.focus();
    return;
  }
  if (e.target.matches('[data-tag-filter]')) { suiteTagFilter = e.target.value; return renderSheet(); }
  const iss = e.target.dataset.issue;
  if (iss) { [...suite.scenarios, ...suite.cases].find((x) => x.id === iss).issue = e.target.value.trim(); saveSuite(); renderSheet(); }
});
const idx0 = (t) => tagIndex().get(t);

document.getElementById('sheet-body').addEventListener('click', (e) => {
  if (sheetMode !== 'suite' || !suite) return;
  const open = e.target.closest('[data-tag-open]')?.dataset.tagOpen;
  if (open) { tagAdding = open; renderSheet(); document.querySelector(`[data-tag-add="${CSS.escape(open)}"]`)?.focus(); return; }
  const rm = e.target.closest('[data-tag-rm]')?.dataset.tagRm;
  if (rm) {
    const [id, t] = rm.split('|');
    const c = [...suite.scenarios, ...suite.cases].find((x) => x.id === id);
    c.tags = (c.tags || []).filter((x) => x !== t);
    if (!c.tags.some((x) => tagIndex().get(x)?.requires === 'issue')) delete c.issue;
    saveSuite(); return renderSheet();
  }
  if (act0(e) === 'tags' && ws?.readyState === 1 && !aiBusy) {
    msg('me', '서버 태그 목록으로 테스트에 태그를 붙여줘');
    ws.send(JSON.stringify({ type: 'suggest_tags', suite: { id: suite.id, scenarios: suite.scenarios.map(({ use, ...c }) => c), cases: suite.cases.map(({ use, ...c }) => c) } }));
    closeSheet();
    return;
  }
  const goto = e.target.closest('[data-goto-s]')?.dataset.gotoS;
  if (goto) {
    suiteTab = 'bdd'; suiteFilter = 'all'; suiteTagFilter = '';
    renderSheet();
    const card = document.querySelector(`[data-use-s="${CSS.escape(goto)}"]`)?.closest('.case');
    card?.scrollIntoView({ block: 'center' });
    card?.classList.add('flash');
    setTimeout(() => card?.classList.remove('flash'), 1200);
    return;
  }
  const filter = e.target.closest('[data-filter]')?.dataset.filter;
  if (filter) { suiteFilter = filter; return renderSheet(); }
  const tab = e.target.closest('[data-stab]')?.dataset.stab;
  if (tab) { suiteTab = tab; return renderSheet(); }
  const s = e.target.dataset.useS;
  if (s) {
    const c = suite.scenarios.find((x) => x.id === s);
    c.use = e.target.checked;
    for (const t of suite.cases.filter((x) => x.scenario === s)) t.use = c.use; // 시나리오를 미채택하면 딸린 TDD도 미채택, 다시 채택하면 함께 채택
    suiteApplied = false;
    saveSuite();
    return renderSheet();
  }
  const cid = e.target.dataset.useC;
  if (cid) { suite.cases.find((x) => x.id === cid).use = e.target.checked; suiteApplied = false; saveSuite(); return renderSheet(); }
  const act = e.target.closest('[data-suite]')?.dataset.suite;
  if (act === 'apply') {
    // 지우지 않는다. 미채택 항목도 그대로 두어 언제든 다시 채택할 수 있다
    const n = (xs) => `${xs.filter((c) => c.use).length}/${xs.length}`;
    suiteApplied = true;
    saveSuite();
    msg('sys', `테스트 묶음 반영: 채택 BDD ${n(suite.scenarios)} · TDD ${n(suite.cases)} (미채택 항목은 보관)`);
    return renderSheet();
  }
  if (act === 'add-open') { addOpen = true; renderSheet(); return $('add-req')?.focus(); }
  if (act === 'add-cancel') { addOpen = false; return renderSheet(); }
  if (act === 'add-send' && ws?.readyState === 1 && !aiBusy) {
    const request = $('add-req').value.trim();
    if (!request) return $('add-req').focus();
    msg('me', `테스트 추가: ${request}`);
    ws.send(JSON.stringify({ type: 'add_tests', request, suite: { id: suite.id, name: suite.name, scope: suite.scope, scenarios: suite.scenarios, cases: suite.cases } }));
    addOpen = false;
    closeSheet();
    return;
  }
  if (act === 'append' && canAppend() && ws?.readyState === 1 && !aiBusy) {
    const scenarios = suite.scenarios.filter((c) => c.use).map(({ use, ...c }) => c);
    const cases = suite.cases.filter((c) => c.use).map(({ use, ...c }) => c);
    msg('me', `새 항목 ${missingCode().length}개의 테스트 코드만 추가하고 실행해줘`);
    ws.send(JSON.stringify({ type: 'write_code', suite: { id: suite.id, name: suite.name, scenarios, cases, append: missingCode() } }));
    suiteTab = 'code';
    closeSheet();
    return;
  }
  if (act === 'run' && needRun() && ws?.readyState === 1 && !aiBusy) {
    const scenarios = suite.scenarios.filter((c) => c.use).map(({ use, ...c }) => c);
    const cases = suite.cases.filter((c) => c.use).map(({ use, ...c }) => c);
    ws.send(JSON.stringify({ type: 'run_code', suite: { id: suite.id, scenarios, cases }, ids: notRun() }));
    suiteTab = 'code';
    return renderSheet();
  }
  if (act === 'retag' && tagsOnly() && ws?.readyState === 1) {
    const scenarios = suite.scenarios.filter((c) => c.use).map(({ use, ...c }) => c);
    const cases = suite.cases.filter((c) => c.use).map(({ use, ...c }) => c);
    ws.send(JSON.stringify({ type: 'retag_code', suite: { id: suite.id, scenarios, cases } }));
    msg('sys', '태그만 코드에 반영합니다(테스트 실행 없음)');
    return;
  }
  if (act === 'code' && suiteApplied && ws?.readyState === 1 && !aiBusy) {
    // 채택된 것만 보낸다. 녹화 기반 코드는 로케이터 참고용
    const scenarios = suite.scenarios.filter((c) => c.use).map(({ use, ...c }) => c);
    const cases = suite.cases.filter((c) => c.use).map(({ use, ...c }) => c);
    msg('me', `채택한 테스트(BDD ${scenarios.length} · TDD ${cases.length})로 코드를 만들고 로컬에서 돌려줘`);
    ws.send(JSON.stringify({ type: 'write_code', suite: { id: suite.id, name: suite.name, scenarios, cases, spec: suite.spec } }));
    suiteTab = 'code';
    closeSheet();
    return;
  }
  if (act === 'reinforce' && ws?.readyState === 1 && !aiBusy) {
    // 현재 초안을 짧게 요약해 같은 대화로 보낸다
    const summary = [
      `제목: ${suite.name}`,
      `시나리오: ${suite.scenarios.map((c) => `${c.id} ${c.title}`).join(' / ')}`,
      `미수행 예외: ${(suite.coverage || []).filter((c) => c.status === '미수행').map((c) => `${c.category}(${c.note})`).join(' / ')}`,
    ].join('\n');
    msg('me', '미수행 예외·오류를 실제로 수행해서 테스트를 보강해줘');
    ws.send(JSON.stringify({ type: 'reinforce', summary }));
    closeSheet();
    return;
  }
  if (act === 'take-server' && suiteConflict) {
    // 서버 문서를 불러온다(adopted → 채택 상태). 지금 초안은 덮인다
    const d = suiteConflict;
    for (const c of [...d.scenarios, ...d.cases]) c.use = c.adopted !== false;
    suite = { ...d, spec: d.spec ?? suite.spec, tag_doc: suite.tag_doc };
    if (d.code) suite.code = { ...d.code, key: adoptedKey() };
    suiteBase = d.version; suiteApplied = true; suiteConflict = null;
    saveSuite();
    msg('sys', `서버 v${d.version}을 불러왔습니다`);
    return renderSheet();
  }
  if (act === 'overwrite' && suiteConflict) {
    suiteBase = suiteConflict.version; // 서버 버전을 기준으로 다시 보낸다 → 다음 버전으로 저장
    suiteConflict = null;
    saveSuite();
  }
  if ((act === 'publish' || act === 'overwrite') && suiteApplied && codeFresh() && !allTagProblems().length && ws?.readyState === 1) {
    const { flow, scenarios, cases, spec, code, tag_doc, ...rest } = suite;
    // 미채택도 함께 보낸다(adopted=false). 서버는 code를 받아 env 값만 자기 환경에 맞게 넣고 돌린다
    const clean = { ...rest, flow, scenarios: scenarios.map(({ use, ...c }) => ({ ...c, adopted: !!use })), cases: cases.map(({ use, ...c }) => ({ ...c, adopted: !!use })),
      code: { runner: 'playwright', file: code.file, source: code.source, env: code.env, local_run: { ...code.summary, ran_at: code.ran_at, results: code.results.map(({ title, status }) => ({ title, status })) } } };
    ws.send(JSON.stringify({ type: 'publish', suite: clean, base_version: suiteBase }));
  }
});
