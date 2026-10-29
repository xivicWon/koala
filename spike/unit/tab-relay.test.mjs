// 작업 탭 실행 중계: Playwright 쪽 CDP 를 '탭 하나뿐인 브라우저'로 답하고, 페이지 명령은 패널로 넘긴다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startTabRelay, tabSpecSource, tabSpecFile, PAGE_SESSION } from '../tab-relay.mjs';

test('tabSpecSource: @playwright/test 만 @koala/tab 으로 바꾸고 나머지는 그대로', () => {
  const src = `import { test, expect, Page } from '@playwright/test';\nimport { clean } from '@support/cleanup';\nconst s = "@playwright/test 문자열";`;
  const out = tabSpecSource(src);
  assert.match(out, /^import \{ test, expect, Page \} from '@koala\/tab';/);
  assert.match(out, /from '@support\/cleanup'/);
  assert.match(out, /"@playwright\/test 문자열"/); // import 가 아닌 문자열은 건드리지 않는다
  assert.equal(tabSpecFile('/d/sets/a/tests/code/a.spec.ts'), '/d/sets/a/tests/code/a.koala-tab.spec.ts');
});

async function relayWith(handler) {
  const calls = [];
  const relay = await startTabRelay({ target: { targetId: 'T1', url: 'http://site.test/', title: 'S' }, toPanel: async (method, params) => { calls.push([method, params]); return handler(method, params); } });
  const ws = new WebSocket(relay.url);
  await new Promise((r) => ws.once('open', r));
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  let id = 0;
  const send = (method, params = {}, sessionId) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params, sessionId })); return i; };
  const reply = async (i) => { for (let k = 0; k < 100; k++) { const m = msgs.find((x) => x.id === i); if (m) return m; await new Promise((r) => setTimeout(r, 10)); } throw new Error(`답 없음 ${i}`); };
  return { relay, ws, msgs, send, reply, calls, done: () => { ws.close(); relay.close(); } };
}

test('중계: 자동 연결하면 작업 탭 하나를 붙이고, 페이지 명령은 패널로 · 이벤트는 그 세션으로', async () => {
  const r = await relayWith((method) => (method === 'Runtime.evaluate' ? { result: { result: { value: 2 } } } : { result: {} }));
  try {
    await r.reply(r.send('Target.setAutoAttach', { autoAttach: true }));
    const att = r.msgs.find((m) => m.method === 'Target.attachedToTarget');
    assert.equal(att.params.sessionId, PAGE_SESSION);
    assert.equal(att.params.targetInfo.targetId, 'T1');
    const ev = await r.reply(r.send('Runtime.evaluate', { expression: '1+1' }, PAGE_SESSION));
    assert.deepEqual(ev.result, { result: { value: 2 } });
    assert.equal(ev.sessionId, PAGE_SESSION);
    r.relay.event('Page.loadEventFired', { timestamp: 1 });
    await new Promise((x) => setTimeout(x, 30));
    assert.ok(r.msgs.some((m) => m.method === 'Page.loadEventFired' && m.sessionId === PAGE_SESSION));
  } finally { r.done(); }
});

test('중계: 브라우저 닫기는 아무것도 하지 않고, 새 탭은 거절하고, 쿠키 지우기는 지금 사이트 쿠키만', async () => {
  const r = await relayWith((method) => (method === 'Network.getCookies' ? { result: { cookies: [{ name: 'a', domain: 'site.test', path: '/' }, { name: 'b', domain: 'site.test', path: '/x' }] } } : { result: {} }));
  try {
    assert.deepEqual((await r.reply(r.send('Browser.close'))).result, {});
    assert.match((await r.reply(r.send('Target.createTarget', { url: 'about:blank' }))).error.message, /새 탭/);
    await r.reply(r.send('Storage.clearCookies', { browserContextId: 'x' }));
    assert.deepEqual(r.calls.map(([m]) => m), ['Network.getCookies', 'Network.deleteCookies', 'Network.deleteCookies']);
    assert.deepEqual(r.calls[2][1], { name: 'b', domain: 'site.test', path: '/x' });
    const got = await r.reply(r.send('Storage.getCookies', {}));
    assert.equal(got.result.cookies.length, 2);
  } finally { r.done(); }
});
