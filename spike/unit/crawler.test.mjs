import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawl, leavesOf } from '../crawler.mjs';

// 가짜 사이트: 그룹 머리를 누르면 하위가 보이고(아코디언: 다른 그룹은 닫힘), 늦게 그리는 그룹은 처음 펼칠 때 하위가 생긴다
function site({ lazy = {}, rowsAt = {}, logoutAfter = Infinity } = {}) {
  const H = 'https://app.test';
  const menu = [
    { menu: ['대시보드'], href: `${H}/dash` },
    { menu: ['결재'], group: true }, { menu: ['결재', '결재대기'], href: `${H}/appr/wait` }, { menu: ['결재', '결재함'], href: `${H}/appr/box` },
    { menu: ['설정'], group: true }, { menu: ['설정', '사용자 관리'], group: true },
    { menu: ['설정', '사용자 관리', '사용자 관리'], href: `${H}/set/users` },
    { menu: ['로그아웃'], href: `${H}/logout` },
    { menu: ['도움말'], href: 'https://other.test/help', newTab: true },
    ...Object.keys(lazy).map((g) => ({ menu: [g], group: true })),
  ];
  const st = { url: `${H}/dash`, open: null, drawn: new Set(), clicks: [], dialog: false, visits: 0 };
  const visible = (i) => i.menu.length === 1 || st.open === i.menu[0] || (i.menu.length === 3 && st.open === '설정');
  const items = () => [...menu, ...Object.entries(lazy).filter(([g]) => st.drawn.has(g)).flatMap(([, kids]) => kids)]
    .map((i) => ({ ...i, hidden: !visible(i) || undefined }));
  const act = async (tool, args) => {
    st.clicks.push(tool === 'click' ? (args.locator.menu || ['ROW']).join('›') : tool);
    if (tool === 'back') { st.url = st.prev; return { ok: true, result: { url: st.url } }; }
    if (tool === 'press') { st.dialog = false; return { ok: true, result: { url: st.url } }; }
    if (args.locator.row) {
      const how = rowsAt[st.url];
      if (!how) return { ok: false, error: '요소 없음' };
      if (how === 'page') { st.prev = st.url; st.url = `${st.url}/1`; } else st.dialog = true;
      return { ok: true, result: { url: st.url } };
    }
    const it = items().find((i) => i.menu.join('›') === args.locator.menu.join('›'));
    if (!it || it.hidden) return { ok: false, error: `요소 없음: ${args.locator.menu}` };
    if (it.group) { st.open = it.menu[0]; if (lazy[it.menu.join('›')]) st.drawn.add(it.menu.join('›')); return { ok: true, result: { url: st.url } }; }
    st.url = it.href; st.visits += 1;
    return { ok: true, result: { url: st.url } };
  };
  const read = async () => ({ url: st.url, items: items(), password: st.visits > logoutAfter, tables: !!rowsAt[st.url], dialog: st.dialog });
  return { act, read, st };
}

test('메뉴 전체 돌기: 접힌 그룹을 펼쳐 잎을 모두 방문, 로그아웃·새 탭은 건너뜀', async () => {
  const s = site();
  const r = await crawl({ act: s.act, read: s.read });
  assert.deepEqual(r.visited.map((v) => v.menu.join('›')), ['대시보드', '결재›결재대기', '결재›결재함', '설정›사용자 관리›사용자 관리']);
  assert.deepEqual(r.skipped.map((v) => [v.menu.join('›'), v.why]), [['로그아웃', '누르지 않는 말(로그아웃·삭제 등)'], ['도움말', '새 탭·다른 사이트로 열림']]);
  assert.equal(r.stopped, null);
  assert.ok(!s.st.clicks.includes('로그아웃'));
});

test('고정점: 펼쳐야 그려지는 하위 항목도 찾아 방문한다', async () => {
  const s = site({ lazy: { 통계: [{ menu: ['통계', '일별'], href: 'https://app.test/stat/day' }] } });
  const r = await crawl({ act: s.act, read: s.read });
  assert.ok(r.visited.some((v) => v.menu.join('›') === '통계›일별'));
});

test('로그인이 풀리면(로그인 수단 없음) 멈추고, 풀린 순간 연 메뉴부터 이어간다', async () => {
  const s = site({ logoutAfter: 1 });
  const done = new Set();
  const r = await crawl({ act: s.act, read: s.read, done });
  assert.equal(r.stopped, 'login');
  assert.deepEqual(r.visited.map((v) => v.menu.join('›')), ['대시보드']);
  const s2 = site();
  const r2 = await crawl({ act: s2.act, read: s2.read, done });
  assert.deepEqual(r2.visited.map((v) => v.menu.join('›')), ['결재›결재대기', '결재›결재함', '설정›사용자 관리›사용자 관리']);
});

test('로그인 화면에서 시작하거나 도중에 풀리면 login() 으로 다시 로그인하고 계속한다(최대 relogins 번)', async () => {
  const s = site({ logoutAfter: 2 });
  s.st.visits = 99; // 로그인 화면에서 시작
  let logins = 0;
  const login = async () => { logins += 1; s.st.visits = 0; return true; }; // 로그인하면 세션이 새로 시작된다
  const r = await crawl({ act: s.act, read: s.read, login });
  assert.equal(r.stopped, null);
  assert.deepEqual(r.visited.map((v) => v.menu.join('›')), ['대시보드', '결재›결재대기', '결재›결재함', '설정›사용자 관리›사용자 관리']);
  assert.equal(logins, 2);
  // 로그인해도 계속 풀리면 relogins 를 다 쓰고 멈춘다
  const s3 = site({ logoutAfter: -1 });
  const r3 = await crawl({ act: s3.act, read: s3.read, login: async () => true, relogins: 1 });
  assert.equal(r3.stopped, 'login');
});

test('목록 상세: 새 화면이면 돌아가고, 대화상자면 닫고, 표가 없으면 누르지 않는다', async () => {
  const s = site({ rowsAt: { 'https://app.test/appr/wait': 'page', 'https://app.test/appr/box': 'dialog' } });
  const dialogs = [];
  const r = await crawl({ act: s.act, read: s.read, rows: true, onDialog: (url) => dialogs.push(url) });
  assert.deepEqual(r.details.map((d) => [d.menu.join('›'), d.kind]), [['결재›결재대기', 'page'], ['결재›결재함', 'dialog']]);
  assert.deepEqual(dialogs, ['https://app.test/appr/box']);
  assert.equal(s.st.clicks.filter((c) => c === 'ROW').length, 2);
  assert.ok(s.st.clicks.includes('back') && s.st.clicks.includes('press'));
});

test('목록 상세: 행이 늦게 그려지면 다시 눌러 열고, 주소가 그대로여도 화면이 크게 바뀌면 같은 화면 안 상세, 빈 목록은 이유를 남긴다', async () => {
  let tries = 0;
  let size = 100;
  let url = 'https://app.test/';
  const items = [{ menu: ['목록'], href: 'https://app.test/list' }, { menu: ['빈 목록'], href: 'https://app.test/empty' }];
  const act = async (tool, args) => {
    if (args.locator?.row) {
      if (url.endsWith('/empty') || ++tries === 1) return { ok: false, error: '요소 없음: {"row":true}' };
      size = 160; // 옆 패널이 열림
      return { ok: true, result: { url } };
    }
    url = items.find((i) => i.menu.join() === args.locator.menu.join()).href;
    size = 100;
    return { ok: true, result: { url } };
  };
  const read = async () => ({ url, items, tables: true, size });
  const r = await crawl({ act, read, rows: true, wait: async () => {} });
  assert.deepEqual(r.details.map((d) => [d.menu.join(), d.kind]), [['목록', 'inline']]);
  assert.deepEqual(r.noDetail, [{ menu: ['빈 목록'], why: '빈 목록이거나 누를 칸이 없음' }]);
  assert.equal(tries, 2);
});

test('작업 탭을 읽지 못하거나 메뉴가 없으면 아무것도 누르지 않고 이유와 함께 멈춘다', async () => {
  const clicks = [];
  const act = async (tool, args) => { clicks.push(args); return { ok: true, result: {} }; };
  const bad = await crawl({ act, read: async () => ({ error: '작업 탭(chrome://extensions/)이 세트 사이트(a.test)가 아닙니다', items: [] }) });
  assert.deepEqual([bad.stopped, bad.why, bad.visited.length], ['tab', '작업 탭(chrome://extensions/)이 세트 사이트(a.test)가 아닙니다', 0]);
  const none = await crawl({ act, read: async () => ({ url: 'https://a.test/', items: [] }) });
  assert.equal(none.stopped, 'nomenu');
  assert.equal(clicks.length, 0);
});

test('leavesOf: 그룹 머리·하위가 있는 항목은 잎이 아니다', () => {
  assert.deepEqual(leavesOf([{ menu: ['a'], group: true }, { menu: ['a', 'b'] }, { menu: ['c'] }]).map((i) => i.menu.join('›')), ['a›b', 'c']);
});
