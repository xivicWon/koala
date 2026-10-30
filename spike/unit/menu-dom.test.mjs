// extension/menu.js 를 실제 Chrome 페이지에 넣어 메뉴 경로 공식(설계 문서 1·3)을 확인한다
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const MENU_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'menu.js');
let browser, page;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); page = await browser.newPage(); });
after(async () => { await browser?.close(); });

async function load(html) {
  await page.setContent(`<body>${html}<main><button id="save">저장</button></main></body>`);
  await page.addScriptTag({ path: MENU_JS });
}
const pathOf = (sel) => page.evaluate((s) => window.__koalaMenu.path(document.querySelector(s)), sel);
const items = () => page.evaluate(() => window.__koalaMenu.items());

test('중첩 목록: 그룹 머리 이름 + 항목, 로고는 붙지 않고 아이콘 글자는 빠진다', async () => {
  await load(`<nav><a class="logo" href="/">MyApp</a><ul>
    <li><button aria-expanded="true">운영관리 <i class="material-icons">expand_more</i></button>
      <ul><li><a id="u" href="/admin/users">사용자 관리</a></li><li><a href="/admin/roles">권한</a></li></ul></li>
    <li><a id="d" href="/dash">대시보드</a></li></ul></nav>`);
  assert.deepEqual(await pathOf('#u'), ['운영관리', '사용자 관리']);
  assert.deepEqual(await pathOf('#d'), ['대시보드']);
  assert.deepEqual(await pathOf('nav button'), ['운영관리']);
  assert.equal(await pathOf('#save'), null); // 메뉴 밖
});

test('Vuetify식 그룹(__header + __items), 클릭 대상이 항목 안쪽 span 이어도 항목 이름', async () => {
  await load(`<aside><div class="v-list"><div class="v-list-group">
    <div class="v-list-group__header" aria-expanded="true"><span>설정</span></div>
    <div class="v-list-group__items"><a href="/settings/alarm"><span id="s">알림</span></a></div></div></div></aside>`);
  assert.deepEqual(await pathOf('#s'), ['설정', '알림']);
});

test('aria-controls 로 이어진 머리, 구역 제목은 바깥 목록에서도 쓴다', async () => {
  await load(`<nav><h3>관리</h3><ul><li><button aria-controls="g1" aria-expanded="true">게시판</button>
    <ul id="g1"><li><a id="n" href="/board/notice">공지</a></li></ul></li></ul></nav>`);
  assert.deepEqual(await pathOf('#n'), ['관리', '게시판', '공지']);
});

test('items: 숨은 하위 항목도 읽고, href·그룹 표시, 페이지 넘김은 메뉴가 아니다', async () => {
  await load(`<nav><ul>
    <li><button aria-expanded="false">통계</button><ul style="display:none"><li><a href="/stat/day">일별</a></li></ul></li>
    <li><a href="/dash">대시보드</a></li><li><a href="#">빈 링크</a></li></ul></nav>
    <nav class="v-pagination" aria-label="pagination"><ul><li><button>1</button></li></ul></nav>`);
  const got = await items();
  assert.deepEqual(got.map((x) => x.menu.join('›')), ['통계', '통계›일별', '대시보드', '빈 링크']);
  assert.equal(got[0].group, true);
  assert.equal(got[1].hidden, true);
  assert.match(got[2].href, /\/dash$/);
  assert.equal(got[3].href, undefined);
});

test('항목마다 nav- testid 가 붙은 메뉴(div 그룹 머리·배지·같은 이름의 그룹과 항목)', async () => {
  await load(`<aside class="layout-vertical-nav"><div class="nav-top"><a href="/"><img alt="logo"></a></div><ul class="nav-items">
    <li class="nav-link" data-testid="nav-link-dashboard"><a href="/dashboard"><span class="nav-item-title">대시보드</span></a></li>
    <li class="nav-group"><div class="nav-group-label" data-testid="nav-group-approvals"><span class="nav-item-title">결재</span><span class="nav-item-badge">22</span></div>
      <ul class="nav-group-children" style="display:none"><li class="nav-link" data-testid="nav-link-approvals-approval"><a href="/approvals/approval"><span class="nav-item-title">결재대기</span><span class="nav-item-badge">16</span></a></li></ul></li>
    <li class="nav-group open"><div class="nav-group-label" data-testid="nav-group-compliance-management"><span class="nav-item-title">컴플라이언스</span></div>
      <ul class="nav-group-children"><li class="nav-link" data-testid="nav-link-compliance"><a href="/compliance"><span class="nav-item-title">컴플라이언스</span></a></li></ul></li>
  </ul></aside>`);
  assert.deepEqual(await pathOf('[data-testid=nav-link-compliance] a'), ['컴플라이언스', '컴플라이언스']);
  assert.deepEqual(await pathOf('[data-testid=nav-group-approvals]'), ['결재']);
  const got = await items();
  assert.deepEqual(got.map((x) => `${x.menu.join('›')}${x.group ? ' [G]' : ''}`),
    ['결재 [G]', '컴플라이언스 [G]', '대시보드', '결재›결재대기', '컴플라이언스›컴플라이언스']);
});

test('findAll: 메뉴 경로로 찾는다(그룹과 항목 이름이 같아도 경로로 구분)', async () => {
  await load(`<nav><ul><li class="g"><div class="label">설정</div><ul class="children">
    <li><div class="label">사용자 관리</div><ul class="children"><li><a id="u" href="/u">사용자 관리</a></li></ul></li></ul></li></ul></nav>`);
  const tag = (m) => page.evaluate((x) => window.__koalaMenu.findAll(x).map((e) => e.id || e.className), m);
  assert.deepEqual(await tag(['설정', '사용자 관리', '사용자 관리']), ['u']);
  assert.deepEqual(await tag(['설정', '사용자 관리']), ['label']);
  assert.deepEqual(await tag(['없음']), []);
});

test('rowTargets: 표마다 첫 데이터 행의 링크, 없으면 버튼·체크박스 없는 첫 칸. 데이터 없음 행은 건너뜀', async () => {
  await load(`<table><tbody><tr><td colspan="3">데이터가 없습니다</td></tr></tbody></table>
    <table><tbody><tr><td><input type="checkbox"></td><td id="c">홍길동</td><td><button>삭제</button></td></tr><tr><td></td><td>둘째</td></tr></tbody></table>
    <table><tbody><tr><td>1</td><td><a id="l" href="/d/1">상세</a></td></tr></tbody></table>`);
  assert.deepEqual(await page.evaluate(() => window.__koalaMenu.rowTargets().map((e) => e.id)), ['c', 'l']);
});
