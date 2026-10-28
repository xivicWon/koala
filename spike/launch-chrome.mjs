// 스파이크(버림용): 정식 Google Chrome을 별도 프로필로 띄우고 koala 확장을 설치한다
// Chrome 137+는 --load-extension 을 막으므로 CDP Extensions.loadUnpacked 를 쓴다
//   node launch-chrome.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ext = new URL('./extension', import.meta.url).pathname;
// 고정 프로필: 다시 띄워도 확장 저장소(타임라인·초안·프로필)가 남는다. 초기화하려면 KOALA_FRESH=1
const profile = path.join(os.tmpdir(), 'koala-chrome-profile');
if (process.env.KOALA_FRESH) fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: false,
  viewport: null,
  ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
  args: ['--enable-unsafe-extension-debugging', '--window-size=1100,900'],
});
const cdp = await ctx.browser().newBrowserCDPSession();
const { id } = await cdp.send('Extensions.loadUnpacked', { path: ext });
console.log('설치된 확장 id:', id);
const page = ctx.pages()[0] || (await ctx.newPage());
const shots = process.env.KOALA_SHOTS || os.tmpdir();
await page.goto('chrome://extensions');
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(shots, 'chrome-extensions.png') });

// 대상 사이트 탭 + 사이드패널 화면(자동 점검용으로 별도 창)을 연다
await page.goto(process.env.KOALA_BASE_URL || 'about:blank');
const sw = ctx.serviceWorkers().find((w) => w.url().includes(id)) || (await ctx.waitForEvent('serviceworker'));
const panelOpened = ctx.waitForEvent('page');
await sw.evaluate(() => chrome.windows.create({ url: 'sidepanel.html', type: 'popup', width: 440, height: 900 }));
const panel = await panelOpened;
await panel.waitForSelector('#ai-dot.idle', { timeout: 10000 }).catch(() => {});
await panel.screenshot({ path: path.join(shots, 'chrome-sidepanel.png') });
console.log('사이드패널 상태:', await panel.getAttribute('#ai-dot', 'class'));
// 자동 점검용: GET /shot 으로 대상 탭과 사이드패널 화면을 브라우저 안에서만 캡처한다
http.createServer(async (req, res) => {
  const tag = new URL(req.url, 'http://x').searchParams.get('tag') || 'now';
  const panelPage = ctx.pages().find((p) => p.url().includes('sidepanel.html'));
  const target = ctx.pages().find((p) => !p.url().startsWith('chrome-extension://'));
  const q = new URL(req.url, 'http://x').searchParams;
  if (q.get('clear')) await ctx.clearCookies(); // 측정용: 로그인 상태를 지운다
  if (q.get('goto')) await target?.goto(q.get('goto')).catch(() => {});
  // 자동 점검용: 사이드패널 안에서 스크립트 실행
  if (q.get('eval')) console.log('eval:', await panelPage?.evaluate(q.get('eval')).catch((e) => String(e)));
  const click = q.get('click');
  if (click) await panelPage?.click(click).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await target?.screenshot({ path: path.join(shots, `page-${tag}.png`) }).catch(() => {});
  await panelPage?.screenshot({ path: path.join(shots, `panel-${tag}.png`) }).catch(() => {});
  res.end('ok');
}).listen(8766, '127.0.0.1');
console.log('준비 완료');
await new Promise(() => {});
