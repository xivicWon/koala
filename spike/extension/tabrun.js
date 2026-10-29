// ── 작업 탭에서 테스트 실행(중계) ──
// 호스트가 띄운 Playwright 의 페이지 명령(relay_cmd)을 chrome.debugger 로 작업 탭에 보내고, 작업 탭의 CDP 이벤트를 돌려준다(relay_ev).
// 마우스·키 입력은 가상 커서·클릭 파동·입력 배너로 보여 주고, 테스트가 찍는 스크린샷에는 표시물을 넣지 않는다
let relayOn = false;
let relayChain = Promise.resolve();
// 실행 위치: tab(작업 탭) | browser(새 브라우저 창). 이 확장에 저장하고 호스트에 알린다
let runWhere = 'tab';
try { runWhere = localStorage.getItem('koa.runWhere') === 'browser' ? 'browser' : 'tab'; } catch {}
const sendRunWhere = () => ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'run_where', where: runWhere }));
function setRunWhere(w) {
  runWhere = w === 'browser' ? 'browser' : 'tab';
  try { localStorage.setItem('koa.runWhere', runWhere); } catch {}
  sendRunWhere();
}

const relaySend = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (relayOn && src.tabId === attachedTo) relaySend({ type: 'relay_ev', method, params });
});
chrome.debugger.onDetach.addListener((src, reason) => {
  if (relayOn && src.tabId === tabId) { relayOn = false; relaySend({ type: 'relay_lost', reason: reason === 'target_closed' ? '작업 탭이 닫혔습니다' : `디버거가 해제됐습니다(${reason})` }); }
});

async function onRelay(m) {
  if (m.type === 'relay_open') {
    try {
      const tab = await ensureAttached();
      const tgt = (await chrome.debugger.getTargets()).find((t) => t.tabId === tab.id);
      if (!tgt) throw new Error('작업 탭의 디버거 대상을 찾지 못했습니다');
      relayOn = true;
      relayChain = Promise.resolve();
      msg('sys', `테스트를 작업 탭${labelOf(tab.id) ? ` ${labelOf(tab.id)}` : ''}에서 실행합니다. 끝날 때까지 이 탭을 닫거나 조작하지 마세요`);
      relaySend({ type: 'relay_ready', targetId: tgt.id, url: tab.url, title: tab.title, label: labelOf(tab.id) });
    } catch (e) { relaySend({ type: 'relay_ready', error: e.message }); }
  }
  if (m.type === 'relay_close') {
    relayOn = false;
    overlay('veil', false).catch(() => {});
    overlay('banner', '').catch(() => {});
  }
  // Playwright 는 응답을 기다리지 않고 이어서 보낸다(이동 → 누름 → 뗌). 표시를 그리느라 순서가 바뀌지 않게 받은 순서대로 처리한다
  if (m.type === 'relay_cmd') relayChain = relayChain.then(() => relayCmd(m)).catch(() => {});
}

async function relayCmd({ id, method, params = {} }) {
  if (!relayOn) return relaySend({ type: 'relay_res', id, error: { message: '작업 탭 실행이 끝났습니다' } });
  const pace = sp();
  if (method === 'Input.dispatchMouseEvent') {
    if (params.type === 'mouseMoved') { await overlay('cursor', params.x, params.y, Math.round(pace.move / 2)); await sleep(Math.round(pace.move / 2)); }
    if (params.type === 'mousePressed') await overlay('ripple', params.x, params.y);
  }
  if (method === 'Input.insertText' && params.text) await overlay('banner', `입력: ${String(params.text).slice(0, 40)}`);
  if (method === 'Input.dispatchKeyEvent' && params.type === 'rawKeyDown' && params.key && params.key.length > 1) await overlay('banner', `키: ${params.key}`);
  const shot = method === 'Page.captureScreenshot';
  if (shot) await overlay('veil', true); // 테스트가 찍는 스크린샷에는 커서·배너를 넣지 않는다
  try {
    const result = await chrome.debugger.sendCommand({ tabId: attachedTo }, method, params);
    relaySend({ type: 'relay_res', id, result: result || {} });
  } catch (e) {
    relaySend({ type: 'relay_res', id, error: { code: -32000, message: String(e.message || e) } });
  } finally {
    if (shot) await overlay('veil', false);
  }
}
