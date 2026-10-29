// 작업 탭에서 테스트 실행: Playwright 가 새 브라우저를 띄우지 않고 이 중계에 connectOverCDP 로 붙는다.
// 중계는 '탭 하나뿐인 브라우저'처럼 답하고, 페이지 명령은 사이드패널로 넘겨 chrome.debugger 로 작업 탭에 보낸다.
//   Playwright ⇄ (ws://127.0.0.1:<임의 포트>/<비밀>) 중계 ⇄ (호스트 WS) 사이드패널 ⇄ chrome.debugger ⇄ 작업 탭
// 브라우저 수준 명령(새 탭·창 닫기·브라우저 닫기)은 사용자 브라우저를 건드리지 않도록 막고,
// 쿠키 명령은 작업 탭이 보는 사이트의 쿠키로만 좁힌다(사용자의 다른 사이트 로그인은 그대로)
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

export const PAGE_SESSION = 'koala-tab';

// target: 패널이 알려 준 작업 탭 { targetId, url, title }
// toPanel(method, params) → Promise<{ result } | { error }> : 작업 탭에 CDP 명령을 보낸다
export async function startTabRelay({ target, toPanel }) {
  const secret = crypto.randomBytes(16).toString('hex');
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const wss = new WebSocketServer({ server, path: `/${secret}` });
  const clients = new Set();
  const log = [];
  const pageCall = async (method, params) => {
    const r = await toPanel(method, params);
    if (r.error) throw Object.assign(new Error(r.error.message || String(r.error)), { cdp: r.error });
    return r.result || {};
  };
  // 쿠키: Playwright 는 브라우저 수준 Storage.* 로 부른다 → 작업 탭의 Network.* 로 바꾼다(지금 페이지 주소에 해당하는 쿠키만)
  const BROWSER = {
    'Browser.getVersion': () => ({ protocolVersion: '1.3', product: 'Chrome/141.0.0.0', revision: '', userAgent: 'koala-tab-relay', jsVersion: '' }),
    'Target.getBrowserContexts': () => ({ browserContextIds: [] }),
    'Target.getTargetInfo': () => ({ targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true } }),
    'Storage.getCookies': async () => ({ cookies: (await pageCall('Network.getCookies', {})).cookies || [] }),
    'Storage.setCookies': async (p) => pageCall('Network.setCookies', { cookies: p.cookies || [] }),
    'Storage.clearCookies': async () => {
      const { cookies = [] } = await pageCall('Network.getCookies', {});
      for (const c of cookies) await pageCall('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
      return {};
    },
    'Target.createTarget': () => { throw new Error('작업 탭에서 실행할 때는 새 탭·창을 열 수 없습니다(테스트는 작업 탭 하나에서 돈다)'); },
    'Target.createBrowserContext': () => { throw new Error('작업 탭에서 실행할 때는 새 브라우저 컨텍스트를 만들 수 없습니다'); },
  };
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    const toPw = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
    ws.on('message', async (raw) => {
      const m = JSON.parse(raw);
      const reply = (r) => toPw({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), ...r });
      log.push(m.method);
      try {
        if (!m.sessionId) {
          if (m.method === 'Target.setAutoAttach') {
            reply({ result: {} });
            return toPw({ method: 'Target.attachedToTarget', params: { sessionId: PAGE_SESSION, waitingForDebugger: false,
              targetInfo: { targetId: target.targetId, type: 'page', title: target.title || '', url: target.url || '', attached: true, canAccessOpener: false, browserContextId: 'koala-ctx' } } });
          }
          const fn = BROWSER[m.method];
          return reply({ result: fn ? await fn(m.params || {}) : {} }); // 그 밖의 브라우저 명령(닫기 등)은 아무것도 하지 않는다
        }
        // 작업 탭 세션: 하위 대상 자동 연결·디버거 대기 해제는 여기서 끝낸다(chrome.debugger 는 탭 하나만 다룬다)
        if (m.method === 'Target.setAutoAttach' || m.method === 'Runtime.runIfWaitingForDebugger') return reply({ result: {} });
        reply({ result: await pageCall(m.method, m.params || {}) });
      } catch (e) {
        reply({ error: { code: -32000, message: e.message } });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}/${secret}`,
    log,
    // 작업 탭에서 온 CDP 이벤트를 붙어 있는 Playwright 에 넘긴다
    event(method, params) {
      const s = JSON.stringify({ method, params, sessionId: PAGE_SESSION });
      for (const c of clients) if (c.readyState === 1) c.send(s);
    },
    // 작업 탭을 잃었다(탭 닫힘·디버거 해제): 붙어 있는 Playwright 를 끊어 테스트가 기다리지 않고 실패하게 한다
    drop() { for (const c of clients) c.terminate(); },
    close() { for (const c of clients) c.terminate(); wss.close(); server.close(); },
  };
}

// 생성 코드를 작업 탭용 사본으로: '@playwright/test' 대신 '@koala/tab'(작업 탭에 붙는 test·page)을 불러온다.
// 원본은 그대로 둔다(서버·CI 에서는 원본을 평소처럼 새 브라우저로 돌린다)
export function tabSpecSource(code) {
  return String(code).replace(/from\s+(['"])@playwright\/test\1/g, "from '@koala/tab'");
}
export const tabSpecFile = (file) => String(file).replace(/\.spec\.ts$/, '.koala-tab.spec.ts');
