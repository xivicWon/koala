// "Claude 설정" 시트: koa가 Claude를 실행하는 작업 폴더(지식 문서 사본)와 실제로 전달되는 내용을 보여 준다
let claudeView = null;
// 내가 고른 모델·effort(이 확장에 저장, 세트 설정보다 우선). 빈 값은 '기본'(세트 → Claude Code 설정)
// billing: sub = Claude Code 구독, api = Console API 키(Agent SDK, API 크레딧에서 차감)
let claudePrefs = { model: '', effort: '', billing: 'sub' };
const BILLING = [['sub', 'Claude Code 구독'], ['api', 'API 키 (크레딧)']];
const MODELS = [['', '기본(세트·Claude Code)'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
const EFFORT_OPTS = [['', '기본'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']];
const claudePrefsReady = chrome.storage.local.get('claudePrefs').then((r) => { if (r?.claudePrefs) claudePrefs = { ...claudePrefs, ...r.claudePrefs }; }).catch(() => {});
// 호스트에 알린다(연결될 때마다, 바꿀 때). 저장된 값을 읽은 뒤에 보낸다. 호스트는 바뀌었으면 대화를 이어 가며 Claude 를 다시 띄운다
function sendClaudePrefs() { claudePrefsReady.then(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'claude_prefs', ...claudePrefs })); }); }

async function loadClaudeView() {
  try {
    const r = await fetch('http://127.0.0.1:8765/claude/effective');
    claudeView = await r.json();
  } catch {
    claudeView = { error: '호스트에 연결할 수 없습니다' };
  }
  if (sheetMode === 'claude') renderSheet();
}

function renderClaudeSheet(body) {
  $('sheet-title').textContent = 'Claude 설정';
  const v = claudeView;
  if (!v) { body.innerHTML = '<div class="none">불러오는 중…</div>'; return; }
  if (v.error) { body.innerHTML = `<div class="none">${esc(v.error)}</div>`; return; }
  // 블록 안의 이름 + 값(코드 블록)
  const field = (label, codes) => `<div class="cs-field"><span class="cs-label">${esc(label)}</span>${codes.map((c) => `<code class="cs-code mono">${esc(c)}</code>`).join('')}</div>`;
  const busy = aiBusy;
  const ver = v.claude?.version ? String(v.claude.version).replace(/\s*\(Claude Code\)/, '') : '사용 불가';
  body.innerHTML = `<div class="cs">
    ${billingHtml(v, busy)}
    <section class="cs-block">
      <div class="cs-block-h"><b>실행 설정</b><span class="pf-hint">${busy ? 'AI 작업 중에는 바꿀 수 없습니다' : '바꾸면 대화를 이어서 새 설정으로 다시 연결합니다'}</span></div>
      <div class="cs-pick">
        <label><span class="cs-label">모델</span><select data-cp="model" ${busy ? 'disabled' : ''}>${MODELS.map(([v, t]) => `<option value="${v}" ${claudePrefs.model === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label><span class="cs-label">effort</span><select data-cp="effort" ${busy ? 'disabled' : ''}>${EFFORT_OPTS.map(([v, t]) => `<option value="${v}" ${claudePrefs.effort === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <dl class="cs-kv">
        <div><dt>지금 모델</dt><dd>${esc(claudeRun.model || '아직 실행 전')}</dd></div>
        <div><dt>effort</dt><dd>${esc(claudeRun.effort || '-')}</dd></div>
        <div><dt>Claude Code</dt><dd>${esc(ver)}</dd></div>
        <div><dt>실행</dt><dd>${claudeUsage?.billing === 'api' ? 'Agent SDK' : 'claude -p'}</dd></div>
      </dl>
    </section>
    ${usageHtml()}
    <section class="cs-block">
      <div class="cs-block-h"><b>세션</b><code class="cs-tag mono">${esc(sessionAlias || '없음')}</code></div>
      <div class="cs-actions">
        <button type="button" class="btn" data-cs="compact" ${sessionAlias && !busy ? '' : 'disabled'} title="지금까지 대화를 요약해 토큰을 줄입니다(같은 세션 유지)">압축</button>
        <button type="button" class="btn" data-cs="clear" ${sessionAlias && !busy ? '' : 'disabled'} title="대화 맥락만 지우고 새 세션으로 시작합니다(수행 기록은 유지)">세션 비우기</button>
        <button type="button" class="btn danger-line" data-cs="reset" ${(sessionAlias || v.recorded) && !busy ? '' : 'disabled'} title="세션과 수행 기록·타임라인까지 비우고 처음부터 시작합니다">기록까지 비우기</button>
      </div>
    </section>
    <details class="cs-more cs-block" ${claudeMore ? 'open' : ''}>
      <summary><b>자세히</b><span class="pf-hint">작업 폴더 · 실행 옵션 · AI에게 전달되는 내용</span></summary>
      <div class="cs-field"><span class="cs-label">작업 폴더</span><code class="cs-code mono">${esc(v.dir)}</code>
        <div class="cs-actions"><button type="button" class="btn" data-cs="open">폴더 열기</button><button type="button" class="btn" data-cs="reload">새로고침</button></div></div>
      ${field('실행 옵션', [v.flags.join(' ')])}
      ${(v.prompts || []).map(([label, paths]) => field(label, paths)).join('')}
    </details>
  </div>`;
  body.querySelector('.cs-more').addEventListener('toggle', (e) => { claudeMore = e.target.open; });
}

// ---------- 요금제: 구독(claude 로그인) / API 키. 키는 호스트가 이 PC 파일에만 저장하고 패널로는 있음·없음만 돌려준다 ----------
function billingHtml(v, busy) {
  if (!v.billing) return ''; // 옛 호스트
  const api = claudePrefs.billing === 'api';
  const k = v.billing.key || {};
  const keyLine = k.saved
    ? `<span class="cs-key ok">● 키 저장됨</span> <code class="cs-code mono" title="${esc(k.file)}">${esc(String(k.file).replace(/^(\/(Users|home)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, '~'))}</code>
       <span class="cs-actions"><button type="button" class="btn" data-cs="key-edit">바꾸기</button><button type="button" class="btn danger-line" data-cs="key-del" title="Console 키는 만들 때 한 번만 보입니다. 지우면 새로 만들어야 할 수 있습니다">${keyDelArm ? '한 번 더 누르면 지웁니다' : '지우기'}</button></span>`
    : `<span class="cs-key ${k.invalid ? 'bad' : 'missing'}">● ${k.invalid ? '저장된 키가 올바르지 않습니다' : '키 없음'}</span>`;
  const form = !k.saved || keyEditing
    ? `<div class="cs-key-form">
         <input type="password" class="pf-input mono" data-cs-key autocomplete="off" spellcheck="false" placeholder="sk-ant-api03-…  (Console › API Keys 에서 만든 키)">
         <button type="button" class="primary sm" data-cs="key-save">저장</button>
         ${k.saved ? '<button type="button" class="btn" data-cs="key-cancel">취소</button>' : ''}
       </div>`
    : '';
  return `<section class="cs-block cs-billing">
    <div class="cs-bill-h"><b>요금제</b>
      <div class="seg" role="radiogroup">${BILLING.map(([b, t]) => `<button type="button" data-cs-bill="${b}" class="${claudePrefs.billing === b ? 'on' : ''}" ${busy ? 'disabled' : ''}>${t}</button>`).join('')}</div>
    </div>
    ${api ? `<div class="cs-key-row">${keyLine}</div>${form}
      <div class="pf-hint">Anthropic Console 의 API 크레딧(프로모션 크레딧 포함)에서 차감됩니다. Agent SDK 로 실행해 요청이 Agent SDK 사용으로 기록됩니다.
        키는 호스트가 이 PC 파일(본인만 읽기)에만 저장하며 화면·기록·서버로 보내지 않습니다.</div>`
    : '<div class="pf-hint">이 PC 에 로그인한 Claude Code 구독 한도 안에서 실행합니다.</div>'}
  </section>`;
}
let keyEditing = false;
let keyDelArm = false; // 지우기는 두 번 눌러야 한다
function onApiKeyStatus(m) {
  if (claudeView?.billing) claudeView.billing.key = m.key;
  if (m.key?.saved) keyEditing = false;
  keyDelArm = false;
  if (sheetMode === 'claude') renderSheet();
}

// ---------- 사용량: 구독 한도(5시간·7일)와 이 세션의 토큰. 호스트가 Claude Code의 rate_limit_event를 넘겨준다 ----------
let claudeUsage = null; // { limits: { status, five_hour: { used, resets_at }, seven_day, at }, session: { input, output, turns } }
let claudeMore = false; // '자세히' 펼침 상태
const pct = (x) => Math.round((x || 0) * 100);
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
function fmtReset(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const left = ms - Date.now();
  const hm = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const when = left < 24 * 3600e3 && d.getDate() === new Date().getDate() ? hm : `${d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' })} ${hm}`;
  const mins = Math.max(0, Math.round(left / 60e3));
  const d2 = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  const rest = d2 ? `${d2}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`;
  return `${when} 초기화 (${rest} 뒤)`;
}
function usageRow(label, w) {
  if (!w) return '';
  const u = pct(w.used);
  const level = u >= 90 ? 'fail' : u >= 70 ? 'warn' : 'ok';
  return `<div class="cs-use">
    <div class="cs-use-h"><b>${label}</b><span>사용 <b>${u}%</b> · 남음 <b class="${level}">${100 - u}%</b></span></div>
    <div class="cs-bar"><i class="${level}" style="width:${Math.min(100, u)}%"></i></div>
    <div class="pf-hint">${esc(fmtReset(w.resets_at))}</div>
  </div>`;
}
function usageHtml() {
  const l = claudeUsage?.limits;
  const se = claudeUsage?.session;
  // API 요금제는 구독 한도 대신 이 대화의 비용(추정)을 보여 준다
  if (claudeUsage?.billing === 'api') {
    const cost = se?.cost != null
      ? `<div class="cs-meta"><span>이 대화 비용 <b>$${se.cost.toFixed(4)}</b></span>${se.lastCost != null ? `<span>마지막 지시 <b>$${se.lastCost.toFixed(4)}</b></span>` : ''}<span>응답 <b>${se.turns}회</b></span><span>입력 <b>${fmtTok(se.input)}</b> · 출력 <b>${fmtTok(se.output)}</b> 토큰</span></div>`
      : '<div class="pf-hint">비용은 AI가 한 번 응답하면 표시됩니다.</div>';
    return `<div class="cs-usage"><div class="cs-block-h"><b>사용량</b><span class="pf-hint">이 대화 비용(추정)</span></div>${cost}<div class="pf-hint">정가 기준 추정치입니다. 실제 차감액은 Console 의 Usage·Billing 에서 확인하세요.</div></div>`;
  }
  const limits = l && (l.five_hour || l.seven_day)
    ? `${usageRow('5시간 한도', l.five_hour)}${usageRow('주간 한도', l.seven_day)}
       <div class="pf-hint">Claude Code 구독 한도입니다. AI가 응답할 때마다 갱신됩니다(마지막 ${new Date(l.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}).</div>`
    : '<div class="pf-hint">사용량은 AI가 한 번 응답하면 표시됩니다.</div>';
  const sess = se?.turns ? `<div class="cs-meta"><span>이 세션 <b>응답 ${se.turns}회</b></span><span>입력 <b>${fmtTok(se.input)}</b> 토큰</span><span>출력 <b>${fmtTok(se.output)}</b> 토큰</span></div>` : '';
  return `<div class="cs-usage"><div class="cs-block-h"><b>사용량</b><span class="pf-hint">Claude Code 구독 한도</span></div>${limits}${sess}</div>`;
}
function onClaudeUsage(m) {
  claudeUsage = m;
  updateClaudeTip();
  if (sheetMode === 'claude') renderSheet();
}

document.getElementById('sheet-body').addEventListener('click', async (e) => {
  if (sheetMode !== 'claude') return;
  const act = e.target.closest('[data-cs]')?.dataset.cs;
  if (act === 'open') fetch('http://127.0.0.1:8765/claude/open', { method: 'POST' });
  if (act === 'compact' && ws?.readyState === 1) { ws.send(JSON.stringify({ type: 'session_compact' })); closeSheet(); }
  if (act === 'clear' && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'session_clear' }));
  if (act === 'reset') openSheet('confirm', { alias: sessionAlias, recorded: claudeView?.recorded }); // 옛 호스트는 recorded를 주지 않는다
  if (act === 'reload') { claudeView = null; renderSheet(); loadClaudeView(); }
  const bill = e.target.closest('[data-cs-bill]')?.dataset.csBill;
  if (bill && !aiBusy && bill !== claudePrefs.billing) {
    claudePrefs = { ...claudePrefs, billing: bill };
    chrome.storage.local.set({ claudePrefs }).catch(() => {});
    sendClaudePrefs();
    msg('sys', `Claude 요금제: ${BILLING.find(([b]) => b === bill)[1]}`);
    renderSheet();
  }
  if (act === 'key-edit') { keyEditing = true; renderSheet(); }
  if (act === 'key-cancel') { keyEditing = false; renderSheet(); }
  if (act === 'key-del') {
    if (!keyDelArm) { keyDelArm = true; renderSheet(); setTimeout(() => { if (keyDelArm) { keyDelArm = false; if (sheetMode === 'claude') renderSheet(); } }, 4000); }
    else if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'api_key', action: 'delete' }));
  }
  if (act === 'key-save') saveApiKey();
});
// 키는 호스트로 한 번 보내고 입력칸을 바로 비운다(패널에는 남기지 않는다)
function saveApiKey() {
  const el = document.querySelector('[data-cs-key]');
  const key = el?.value.trim();
  if (!key) return;
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) { msg('err', 'API 키 형식이 아닙니다(sk-ant- 로 시작하는 Console 키)'); return; }
  if (ws?.readyState !== 1) { msg('err', '호스트에 연결되지 않아 저장하지 못했습니다'); return; }
  ws.send(JSON.stringify({ type: 'api_key', action: 'save', key }));
  el.value = '';
}
document.getElementById('sheet-body').addEventListener('keydown', (e) => {
  if (sheetMode === 'claude' && e.target.matches('[data-cs-key]') && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveApiKey(); }
});
document.getElementById('claude-btn').onclick = () => { claudeView = null; openSheet('claude'); loadClaudeView(); };

// ---------- Claude 버튼: 실행 중인 모델과 effort(쌓기 아이콘) ----------
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_COLORS = ['#3d9a5f', '#9bb83a', '#e0a526', '#e5672f', '#d1352b']; // 초록 → 빨강

// 낮은 등급은 1줄, 높을수록 줄이 쌓이고 위로 갈수록 빨개진다
function effortIcon(effort) {
  const level = EFFORTS.indexOf(effort);
  if (level < 0) {
    return `<svg viewBox="0 0 12 14" width="11" height="13"><rect x="1" y="11" width="10" height="2" rx="1" fill="none" stroke="currentColor" stroke-width=".8" stroke-dasharray="1.5 1.2" opacity=".55"/></svg>`;
  }
  const bars = Array.from({ length: level + 1 }, (_, i) =>
    `<rect x="1" y="${11 - i * 2.6}" width="10" height="1.9" rx=".9" fill="${EFFORT_COLORS[i]}"/>`).join('');
  // 줄 묶음 전체를 아이콘 세로 가운데에 둔다(버튼 글자와 같은 중심)
  const top = 11 - level * 2.6;
  const dy = (14 - (12.9 - top)) / 2 - top;
  return `<svg viewBox="0 0 12 14" width="11" height="13"><g transform="translate(0 ${dy.toFixed(2)})">${bars}</g></svg>`;
}

function renderClaudeRun(model, effort) {
  const m = $('claude-model');
  const e = $('claude-effort');
  // 모델명은 Claude Code가 알려 준 값 그대로
  if (model) { m.textContent = String(model).replace(/^claude-/, ''); m.title = model; m.hidden = false; } // 헤더에는 앞의 claude- 없이
  e.innerHTML = effortIcon(effort);
  e.hidden = !model;
  claudeRun = { model, effort };
  updateClaudeTip();
}

// Claude 버튼 툴팁: AI 상태 · 모델 · effort · 클릭 안내 (빠른 툴팁으로 보여 준다)
let claudeRun = { model: null, effort: null };
let sessionAlias = null;
function renderSession(alias) {
  sessionAlias = alias;
  $('claude-session').textContent = alias || '';
  $('claude-session').hidden = !alias;
  updateClaudeTip();
  if (sheetMode === 'claude') renderSheet();
}
function updateClaudeTip() {
  const state = document.getElementById('ai-dot')?.getAttribute('aria-label') || '';
  $('claude-btn').dataset.tip = [
    state,
    `모델  ${claudeRun.model || '아직 실행 전'}`,
    `effort  ${claudeRun.effort || '-'}`,
    `세션  ${sessionAlias || (claudeConn.state === 'connecting' ? '여는 중' : '없음 (곧 새로 엽니다)')}`,
    ...(claudeUsage?.billing === 'api' ? [`요금제  API 키${claudeUsage.session?.cost != null ? ` · 이 대화 $${claudeUsage.session.cost.toFixed(4)}` : ''}`] : []),
    ...(claudeUsage?.billing !== 'api' && claudeUsage?.limits?.five_hour ? [`사용량  5시간 ${pct(claudeUsage.limits.five_hour.used)}% · 주간 ${pct(claudeUsage.limits.seven_day?.used)}%`] : []),
    '클릭하면 Claude 설정을 엽니다',
  ].join('\n');
  $('claude-btn').removeAttribute('title');
}

// 모델·effort 고르기
document.getElementById('sheet-body').addEventListener('change', (e) => {
  const k = sheetMode === 'claude' && e.target.dataset?.cp;
  if (!k || aiBusy) return;
  claudePrefs = { ...claudePrefs, [k]: e.target.value };
  chrome.storage.local.set({ claudePrefs }).catch(() => {});
  sendClaudePrefs();
  msg('sys', `Claude 설정: 모델 ${claudePrefs.model || '기본'} · effort ${claudePrefs.effort || '기본'}`);
});
