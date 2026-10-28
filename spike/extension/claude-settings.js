// "Claude 설정" 시트: koa가 Claude를 실행하는 작업 폴더(지식 문서 사본)와 실제로 전달되는 내용을 보여 준다
let claudeView = null;
let claudeTab = 'prompt';

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
  const tabs = [['prompt', '실제 전달 내용'], ...v.files.map((f) => [`file:${f.name}`, f.name])];
  const file = claudeTab.startsWith('file:') && v.files.find((f) => `file:${f.name}` === claudeTab);
  const content = file
    ? `<pre class="cs-pre mono">${esc(file.content)}</pre>`
    : `<div class="cs-sec"><b>① koa 기본 규칙</b> <span class="pf-hint">--append-system-prompt</span><pre class="cs-pre mono">${esc(v.system)}</pre></div>
       <div class="cs-sec"><b>② 지식 (CLAUDE.md, 불러온 파일 펼침)</b> <span class="pf-hint">작업 폴더에서 자동으로 읽힘</span><pre class="cs-pre mono">${esc(v.claudeMdExpanded)}</pre></div>
       <div class="cs-sec"><b>③ 프로필 (대상 서비스·계정·사이트 지식)</b> <span class="pf-hint">지시마다 덧붙임</span><pre class="cs-pre mono">${esc(v.profileContext || '(활성 프로필 없음)')}</pre></div>`;
  body.innerHTML = `<div class="cs">
    <div class="cs-session">
      <span class="pf-hint">세션</span><b class="mono">${esc(sessionAlias || '새 대화')}</b>
      <span class="pf-hint">${sessionAlias ? '다시 연결해도 이 세션으로 이어집니다' : '다음 지시에서 새 세션이 시작됩니다'}</span>
      <span class="grow"></span>
      <button type="button" class="btn sm" data-cs="compact" ${sessionAlias && !aiBusy ? '' : 'disabled'} title="지금까지 대화를 요약해 토큰을 줄입니다(같은 세션 유지)">압축</button>
      <button type="button" class="btn sm ghost" data-cs="clear" ${sessionAlias && !aiBusy ? '' : 'disabled'} title="대화 맥락만 지우고 새 세션으로 시작합니다(수행 기록은 유지)">세션 비우기</button>
      <button type="button" class="btn sm ghost danger-text" data-cs="reset" ${(sessionAlias || v.recorded) && !aiBusy ? '' : 'disabled'} title="세션과 수행 기록·타임라인까지 비우고 처음부터 시작합니다(예전 '새 시나리오')">기록까지 비우기</button>
    </div>
    <div class="cs-row">
      <div class="cs-path"><span class="pf-hint">작업 폴더</span><code class="mono">${esc(v.dir)}</code></div>
      <button type="button" class="btn sm" data-cs="open">폴더 열기</button>
      <button type="button" class="btn sm ghost" data-cs="reload">새로고침</button>
    </div>
    <div class="cs-meta">
      <span>지식 <b>${esc(v.versions.knowledge.join(' · ') || '없음')}</b></span>
      <span>프로필 <b>${esc(v.versions.profile || '-')}</b></span>
      <span>Claude <b>${esc(v.claude?.ok ? v.claude.version : '사용 불가')}</b></span>
    </div>
    <div class="cs-meta"><span class="pf-hint">실행 옵션</span> <code class="mono">${esc(v.flags.join(' '))}</code></div>
    <div class="pf-hint" style="margin:6px 0 0">이 폴더는 지식 문서로 만든 사본입니다. 내용을 고치려면 지식 문서를 고쳐 새 버전으로 게시하세요.</div>
    <div class="cs-tabs">${tabs.map(([k, label]) => `<button type="button" class="cs-tab ${k === claudeTab ? 'on' : ''}" data-tab="${esc(k)}">${esc(label)}</button>`).join('')}</div>
    ${content}
  </div>`;
}

document.getElementById('sheet-body').addEventListener('click', async (e) => {
  if (sheetMode !== 'claude') return;
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (tab) { claudeTab = tab; return renderSheet(); }
  const act = e.target.closest('[data-cs]')?.dataset.cs;
  if (act === 'open') fetch('http://127.0.0.1:8765/claude/open', { method: 'POST' });
  if (act === 'compact' && ws?.readyState === 1) { ws.send(JSON.stringify({ type: 'session_compact' })); closeSheet(); }
  if (act === 'clear' && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'session_clear' }));
  if (act === 'reset') openSheet('confirm', { alias: sessionAlias, recorded: claudeView?.recorded }); // 옛 호스트는 recorded를 주지 않는다
  if (act === 'reload') { claudeView = null; renderSheet(); loadClaudeView(); }
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
  if (model) { m.textContent = model; m.hidden = false; }
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
    '클릭하면 Claude 설정을 엽니다',
  ].join('\n');
  $('claude-btn').removeAttribute('title');
}
