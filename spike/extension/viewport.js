// ── 화면 크기: 작업 탭만 정한 크기로 흉내 낸다(개발자 도구의 기기 모드와 같은 방식) ──
// 창·다른 탭은 그대로 두고, 작업 탭의 화면 폭·높이(와 모바일 여부)만 바꾼다.
// 창보다 크면 일부만 보인다. 축소(scale)해 보여 주면 클릭 좌표가 어긋나 Playwright·AI 조작이 실패하므로 축소하지 않는다.
// AI 조작·작업 탭 테스트 실행은 이 크기에서 돌고, 새 브라우저 실행도 호스트가 같은 크기로 띄운다
const VP_PRESETS = [
  ['window', '창 크기 그대로', null],
  ['mobile', '모바일', { w: 390, h: 844, mobile: true }],
  ['tablet', '태블릿', { w: 820, h: 1180, mobile: true }],
  ['laptop', '노트북', { w: 1366, h: 768 }],
  ['desktop', '데스크톱', { w: 1920, h: 1080 }],
];
let viewport = null; // { w, h, mobile } | null(창 크기 그대로)
const vpReady = chrome.storage.local.get('viewport').then((r) => { if (r?.viewport?.w) viewport = r.viewport; }).catch(() => {});
const vpText = (v) => (v ? `${v.w}×${v.h}${v.mobile ? ' 모바일' : ''}` : '창 크기');
const vpPreset = (v) => VP_PRESETS.find(([, , p]) => (p ? v && p.w === v.w && p.h === v.h && !!p.mobile === !!v.mobile : !v))?.[0] || 'custom';
let vpWin = null; // 작업 탭의 실제 크기(창)
const vpTooBig = () => !!(viewport && vpWin && (viewport.w > vpWin.w || viewport.h > vpWin.h));
const vpClamp = (n) => Math.max(200, Math.min(4000, Math.round(Number(n) || 0)));

// 지금 작업 탭에 크기를 건다(붙어 있을 때만)
async function applyViewport() {
  await vpReady;
  if (!attachedTo) return;
  const on = (m, p) => chrome.debugger.sendCommand({ tabId: attachedTo }, m, p).catch(() => {});
  if (!viewport) {
    await on('Emulation.clearDeviceMetricsOverride', {});
    await on('Emulation.setTouchEmulationEnabled', { enabled: false });
    return;
  }
  await on('Emulation.setDeviceMetricsOverride', { width: viewport.w, height: viewport.h, deviceScaleFactor: 0, mobile: !!viewport.mobile });
  await on('Emulation.setTouchEmulationEnabled', { enabled: !!viewport.mobile, maxTouchPoints: viewport.mobile ? 5 : 1 });
}
// 호스트에 알린다: 새 브라우저 실행이 같은 크기로 뜨게(창 크기 그대로면 작업 탭의 지금 크기)
async function sendViewport() {
  await vpReady;
  if (ws?.readyState !== 1) return;
  const id = attachedTo || tabId;
  const t = id ? await chrome.tabs.get(id).catch(() => null) : null;
  vpWin = t?.width ? { w: t.width, h: t.height } : null;
  ws.send(JSON.stringify({ type: 'viewport', viewport, window: vpWin }));
  renderVp();
}
async function setViewport(v, by = '') {
  viewport = v ? { w: vpClamp(v.w), h: vpClamp(v.h), mobile: !!v.mobile } : null;
  chrome.storage.local.set({ viewport }).catch(() => {});
  if (!attachedTo) await ensureAttached().catch(() => {});
  await applyViewport();
  renderVp();
  sendViewport();
  if (by) msg('sys', `화면 크기: ${vpText(viewport)}${by === 'ai' ? ' (AI가 바꿈)' : ''}`);
  return viewport;
}
// AI 도구 viewport: preset 또는 width·height(·mobile)
async function viewportFromAi(a) {
  const p = a.preset && VP_PRESETS.find(([k]) => k === a.preset);
  if (a.preset && !p) throw new Error(`모르는 크기입니다: ${a.preset}. ${VP_PRESETS.map(([k]) => k).join('·')} 또는 width·height`);
  const v = p ? p[2] : a.width && a.height ? { w: a.width, h: a.height, mobile: !!a.mobile } : undefined;
  if (v === undefined) throw new Error('preset 이나 width·height 를 주세요');
  const now = await setViewport(v, 'ai');
  const t = await chrome.tabs.get(attachedTo).catch(() => null);
  return { viewport: now ? { width: now.w, height: now.h, mobile: now.mobile } : 'window', window: t?.width ? { width: t.width, height: t.height } : undefined,
    forAi: { 화면: now ? `${now.w}×${now.h}${now.mobile ? ' 모바일(터치)' : ''}` : `창 크기 그대로${t?.width ? ` ${t.width}×${t.height}` : ''}` } };
}

function renderVp() {
  const b = $('vp-btn');
  if (!b) return;
  b.textContent = vpText(viewport);
  b.classList.toggle('on', !!viewport);
  b.classList.toggle('big', vpTooBig());
  const m = $('vp-menu');
  if (m.hidden) return;
  const cur = vpPreset(viewport);
  m.innerHTML = `${VP_PRESETS.map(([k, t, p]) => `<button type="button" role="menuitemradio" aria-checked="${cur === k}" data-vp="${k}"><span class="vp-chk">${cur === k ? '✓' : ''}</span>${t}<span class="pf-hint">${p ? `${p.w}×${p.h}` : ''}</span></button>`).join('')}
    <div class="vp-custom"><input type="number" id="vp-w" min="200" max="4000" value="${viewport?.w || 1280}" aria-label="폭"><span>×</span><input type="number" id="vp-h" min="200" max="4000" value="${viewport?.h || 800}" aria-label="높이">
      <label><input type="checkbox" id="vp-m" ${viewport?.mobile ? 'checked' : ''}> 모바일</label><button type="button" class="btn sm" data-vp="custom">적용</button></div>
    <div class="pf-hint vp-note">작업 탭에만 적용됩니다(창·다른 탭은 그대로). AI 조작과 테스트 실행이 이 크기에서 돕니다.${vpTooBig() ? ' <b>지금 창보다 커서 일부만 보입니다</b>(조작·테스트에는 영향 없음).' : ''}</div>`;
}
$('vp-btn').onclick = (e) => {
  e.stopPropagation();
  const m = $('vp-menu');
  m.hidden = !m.hidden;
  $('vp-btn').setAttribute('aria-expanded', String(!m.hidden));
  renderVp();
};
$('vp-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  const k = e.target.closest('[data-vp]')?.dataset.vp;
  if (!k) return;
  const v = k === 'custom' ? { w: $('vp-w').value, h: $('vp-h').value, mobile: $('vp-m').checked } : VP_PRESETS.find(([x]) => x === k)[2];
  $('vp-menu').hidden = true;
  $('vp-btn').setAttribute('aria-expanded', 'false');
  setViewport(v, 'me');
});
document.addEventListener('click', () => { if (!$('vp-menu').hidden) { $('vp-menu').hidden = true; $('vp-btn').setAttribute('aria-expanded', 'false'); } });
vpReady.then(renderVp);
