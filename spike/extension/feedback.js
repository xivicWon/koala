// ── 피드백 보내기 ──
// koala 공개 저장소의 GitHub Issues 로 보낸다. 패널에서 쓴 내용을 채운 새 이슈 화면을 열고, 올리기는 사용자가 GitHub 에서 누른다.
// 공개 저장소라 자동으로 붙이는 정보는 버전·브라우저·OS 뿐이다(프로필 이름·대상 사이트 주소·계정은 넣지 않는다)
const FB_KINDS = [['bug', '버그', 'bug'], ['idea', '개선 제안', 'enhancement'], ['ask', '질문', 'question']];
const FB_KEY = 'koa.feedbackDraft';
let fb = { kind: 'bug', title: '', body: '', env: true };
try { fb = { ...fb, ...JSON.parse(localStorage.getItem(FB_KEY) || '{}') }; } catch {}
const saveFb = () => { try { localStorage.setItem(FB_KEY, JSON.stringify(fb)); } catch {} };
const fbRepo = () => updateState?.repo || 'xivicWon/koala';

function fbEnv() {
  const ua = navigator.userAgentData;
  const brand = ua?.brands?.find((b) => !/Not.A.Brand|Chromium/i.test(b.brand)) || ua?.brands?.[0];
  return `koala v${chrome.runtime.getManifest().version} · ${brand ? `${brand.brand} ${brand.version}` : 'Chrome'} · ${ua?.platform || navigator.platform}`;
}
function fbBody() {
  const kind = FB_KINDS.find(([k]) => k === fb.kind)?.[1] || '';
  return `## 종류\n${kind}\n\n## 내용\n${fb.body.trim() || '(내용 없음)'}\n${fb.env ? `\n---\n${fbEnv()}\n` : ''}`;
}
function fbUrl() {
  const label = FB_KINDS.find(([k]) => k === fb.kind)?.[2];
  const q = new URLSearchParams({ title: fb.title.trim() || `[${FB_KINDS.find(([k]) => k === fb.kind)?.[1]}] `, body: fbBody(), ...(label ? { labels: label } : {}) });
  return `https://github.com/${fbRepo()}/issues/new?${q}`;
}

function renderFeedbackSheet(body) {
  $('sheet-title').textContent = '피드백 보내기';
  body.innerHTML = `<div class="fb">
    <div class="pf-alert"><span>koala 공개 저장소(<b>${esc(fbRepo())}</b>)의 <b>GitHub Issues</b>로 보냅니다. 누구나 볼 수 있으니 <b>대상 사이트 이름·주소·계정·화면 내용</b>은 적지 마세요. 올리려면 GitHub 로그인이 필요합니다.</span></div>
    <div class="seg fb-kind" role="radiogroup">${FB_KINDS.map(([k, t]) => `<button type="button" data-fb-kind="${k}" class="${fb.kind === k ? 'on' : ''}">${t}</button>`).join('')}</div>
    <label class="pf-label">제목</label>
    <input class="pf-input" data-fb="title" value="${esc(fb.title).replace(/"/g, '&quot;')}" placeholder="한 줄 요약. 예: 테스트 목록에서 반영 버튼이 눌리지 않음">
    <label class="pf-label">내용</label>
    <textarea class="pf-input fb-body" data-fb="body" rows="8" placeholder="${fb.kind === 'bug' ? '무엇을 했고, 무엇을 기대했는데, 실제로는 어떻게 됐는지 적어 주세요' : fb.kind === 'idea' ? '어떤 상황에서 무엇이 있으면 좋을지 적어 주세요' : '궁금한 점을 적어 주세요'}">${esc(fb.body)}</textarea>
    <label class="fb-env"><input type="checkbox" data-fb-env ${fb.env ? 'checked' : ''}> 버전·브라우저 정보 함께 보내기 <span class="pf-hint">${esc(fbEnv())}</span></label>
    <div class="pf-actions">
      <span class="grow"></span>
      <button type="button" class="btn sm" data-fb-act="copy">내용 복사</button>
      <button type="button" class="primary sm" data-fb-act="open" ${fb.title.trim() || fb.body.trim() ? '' : 'disabled'}>GitHub 이슈로 열기</button>
    </div>
    <div class="pf-hint">새 탭에 이슈 작성 화면이 열립니다. 내용을 확인한 뒤 GitHub 에서 <b>Submit new issue</b>를 누르면 올라갑니다.</div>
  </div>`;
}
const fbBodyEl = document.getElementById('sheet-body');
fbBodyEl.addEventListener('input', (e) => {
  const k = sheetMode === 'feedback' && e.target.dataset?.fb;
  if (!k) return;
  fb[k] = e.target.value; saveFb();
  const open = fbBodyEl.querySelector('[data-fb-act="open"]');
  if (open) open.disabled = !(fb.title.trim() || fb.body.trim());
});
fbBodyEl.addEventListener('click', async (e) => {
  if (sheetMode !== 'feedback') return;
  const kind = e.target.closest('[data-fb-kind]')?.dataset.fbKind;
  if (kind) { fb.kind = kind; saveFb(); return renderSheet(); }
  if (e.target.matches('[data-fb-env]')) { fb.env = e.target.checked; saveFb(); return renderSheet(); }
  const act = e.target.closest('[data-fb-act]')?.dataset.fbAct;
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(`${fb.title}\n\n${fbBody()}`); msg('sys', '피드백 내용을 복사했습니다'); } catch { msg('err', '복사하지 못했습니다'); }
  }
  if (act === 'open') {
    await chrome.tabs.create({ url: fbUrl() });
    msg('sys', `GitHub 이슈 작성 화면을 열었습니다(${fbRepo()}). 확인한 뒤 Submit new issue 를 누르세요`);
    fb = { ...fb, title: '', body: '' }; saveFb();
    closeSheet();
  }
});
