// 메뉴 전체 돌기(1차)·목록 상세 돌기(2차): AI 없이, 서비스 지식 없이 관측되는 메뉴를 모두 방문해 메뉴 경로 지도를 채운다.
// 조작은 도구 경로(act = 호스트 relay)로 한다. 지도 기록·화면 표시·데이터 바꾸는 버튼 막기(계획 모드)를 그대로 쓴다.
// 공식은 docs/superpowers/specs/2026-10-30-menu-map-design.md '메뉴 전체 돌기'
import { screenKey } from './menumap.mjs';

const SEP = '›';
const key = (m) => m.join(SEP);
const under = (m, g) => m.length > g.length && key(m.slice(0, g.length)) === key(g);

// 누르지 않는 메뉴: 세션을 끝내거나 데이터를 바꾸는 말(어느 사이트에나 통하는 일반 단어)
export const DENY = /로그아웃|log ?out|sign ?out|탈퇴|삭제|delete|remove|초기화|reset/i;
// 파일을 내려받는 링크
const FILE = /\.(pdf|xlsx?|csv|zip|hwp|docx?|pptx?)(\?|#|$)/i;

export const childrenOf = (items, g) => items.filter((i) => i.menu.length === g.length + 1 && under(i.menu, g));
// 잎: 그룹 머리가 아니고 하위 항목이 없는 것
export const leavesOf = (items) => items.filter((i) => !i.group && !items.some((o) => under(o.menu, i.menu)));

// act(tool, args) → { ok, result, error } · read() → { url, items, password, tables, dialog, size(화면 요소 수) }
// done: 이미 끝낸 잎 경로(이어하기). rows: 잎 화면마다 목록 첫 행을 눌러 상세를 연다(2차). wait: 다시 볼 때까지 쉬기
export async function crawl({ act, read, done = new Set(), rows = false, onDialog, onProgress, shouldStop = () => false, limit = 500, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const out = { visited: [], failed: [], skipped: [], details: [], noDetail: [], stopped: null };
  let s = await read();
  // 작업 탭을 읽을 수 없거나(chrome:// 등) 세트 사이트가 아니면 시작하지 않는다. 메뉴가 하나도 없으면 돌 것이 없다
  if (s.error) return { ...out, stopped: 'tab', why: s.error };
  if (s.password) return { ...out, stopped: 'login' };
  if (!s.items.length) return { ...out, stopped: 'nomenu' };
  const refresh = async () => { s = await read(); return s; };

  // 조상 그룹을 차례로 펼친다: 하위 항목을 모르거나(그리기 전) 모두 숨어 있으면 머리를 누른다
  const open = async (path) => {
    for (let i = 1; i <= path.length; i++) {
      const g = path.slice(0, i);
      const kids = childrenOf(s.items, g);
      if (kids.length && kids.some((k) => !k.hidden)) continue;
      const r = await act('click', { locator: { menu: g } });
      if (!r.ok) return r;
      await refresh();
    }
    return { ok: true };
  };

  const tried = new Set(); // 펼쳐 본 그룹(고정점: 새 항목이 더 안 나올 때까지)
  for (let n = 0; n < limit; n++) {
    if (shouldStop()) { out.stopped = 'user'; break; }
    const lazy = s.items.find((i) => i.group && !childrenOf(s.items, i.menu).length && !tried.has(key(i.menu)));
    if (lazy) {
      tried.add(key(lazy.menu));
      const r = await open(lazy.menu);
      if (!r.ok && /중지/.test(r.error || '')) { out.stopped = 'user'; break; }
      continue;
    }
    // 펼쳐 봐도 하위 항목이 없는 그룹 머리가 주소를 가지면 잎으로 본다
    const leaves = s.items.filter((i) => !s.items.some((o) => under(o.menu, i.menu)) && (!i.group || (tried.has(key(i.menu)) && i.href)));
    const next = leaves.find((l) => !done.has(key(l.menu)));
    onProgress?.({ done: done.size, total: leaves.length, next: next?.menu });
    if (!next) break;
    done.add(key(next.menu));
    const why = DENY.test(next.menu.at(-1)) ? '누르지 않는 말(로그아웃·삭제 등)' : next.newTab ? '새 탭·다른 사이트로 열림' : FILE.test(next.href || '') ? '파일 내려받기' : null;
    if (why) { out.skipped.push({ menu: next.menu, why }); continue; }

    const o = await open(next.menu.slice(0, -1));
    const r = o.ok ? await act('click', { locator: { menu: next.menu } }) : o;
    if (!r.ok) {
      if (/중지/.test(r.error || '')) { out.stopped = 'user'; break; }
      out.failed.push({ menu: next.menu, error: String(r.error || '').slice(0, 200) });
      await refresh();
      continue;
    }
    out.visited.push({ menu: next.menu, url: r.result?.url });
    await refresh();
    if (s.error) { out.stopped = 'tab'; out.why = s.error; break; }
    if (s.password) { out.stopped = 'login'; break; }
    if (rows) await probeRows(next.menu);
  }
  return out;

  // 2차: 목록 첫 행을 눌러 상세가 어떻게 열리는지 본다(새 화면 → 돌아가기, 대화상자 → 닫기, 같은 화면 안에서 바뀜, 아무 일 없음).
  // 목록이 늦게 그려지거나 화면이 늦게 바뀔 수 있어 한 번씩 다시 본다
  async function probeRows(menu) {
    if (!s.tables) return;
    const from = s.url;
    const size = s.size;
    let r = await act('click', { locator: { row: true } });
    if (!r.ok && !/중지/.test(r.error || '')) { await wait(1000); r = await act('click', { locator: { row: true } }); }
    if (!r.ok) { out.noDetail.push({ menu, why: /요소 없음/.test(r.error || '') ? '빈 목록이거나 누를 칸이 없음' : `행을 누르지 못함: ${String(r.error || '').slice(0, 80)}` }); return; }
    await refresh();
    const same = () => screenKey(s.url) === screenKey(from) && !s.dialog;
    if (same() && !s.password) { await wait(1000); await refresh(); }
    if (s.password) return;
    if (screenKey(s.url) !== screenKey(from)) {
      out.details.push({ menu, kind: 'page', url: s.url });
      await act('back', {});
      await refresh();
    } else if (s.dialog) {
      out.details.push({ menu, kind: 'dialog', url: from });
      onDialog?.(from, menu);
      await act('press', { key: 'Escape' });
      await refresh();
    } else if (size && s.size && Math.abs(s.size - size) / size > 0.2) {
      out.details.push({ menu, kind: 'inline', url: from }); // 옆 패널·행 펼침 등: 주소는 그대로, 화면 요소가 크게 바뀜
    } else out.noDetail.push({ menu, why: '행을 눌러도 화면·대화상자가 열리지 않음' });
  }
}
