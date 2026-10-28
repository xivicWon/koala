// 업데이트 알림: 이름 오른쪽의 둥근 버튼.
//   업데이트 vX     — 설치본에 새 GitHub 릴리즈가 있다. 누르면 호스트가 그 태그로 바꾸고 다시 켜진다
//   새 버전 적용 vX — 디스크의 코드는 새 버전인데 돌고 있는 호스트나 불러온 확장이 옛 코드다
//                     (개발 폴더에 새 커밋이 들어왔거나, 업데이트를 받은 직후). 누르면 호스트를 다시 켜고 확장도 새로고침한다
//   호스트 불일치   — 확장과 호스트가 서로 다른 폴더(설치본과 개발 폴더 등)에서 왔다. 업데이트 확인은 호스트 폴더 기준이라
//                     확장 쪽 업데이트가 보이지 않는다. 누르면 원인과 할 일을 대화창에 적는다
let updateState = null; // 호스트가 보낸 { version(돌고 있는 코드), disk, stale, tag, dev, home, latest, available }
let updating = false;
let extDisk = null;     // 디스크에 있는 확장 manifest 버전(불러온 버전과 다르면 확장이 옛 코드)

const extVersion = () => chrome.runtime.getManifest().version;
const RELOAD_AFTER_RESTART = 'koala-reload-after-restart';

// 압축 해제 확장은 파일을 디스크에서 바로 읽으므로, manifest.json 을 다시 읽으면 새 버전을 알 수 있다
async function readExtDisk() {
  try {
    const r = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    extDisk = (await r.json()).version;
  } catch { extDisk = null; }
}

async function onUpdate(m) {
  updateState = m;
  updating = false;
  await readExtDisk();
  // '새 버전 적용'으로 호스트를 다시 켠 뒤 다시 연결되면, 이어서 확장을 새로고침한다
  let pending = false;
  try { pending = sessionStorage.getItem(RELOAD_AFTER_RESTART) === '1'; } catch {}
  if (pending && !m.stale) {
    try { sessionStorage.removeItem(RELOAD_AFTER_RESTART); } catch {}
    if (extDisk && extDisk !== extVersion()) return chrome.runtime.reload();
  }
  renderUpdate();
  checkWhatsNew();
}

function onUpdateDone(m) {
  updating = false;
  msg('sys', `v${m.from} → v${m.to} 업데이트 완료. 호스트가 다시 켜집니다`);
  try { sessionStorage.setItem(RELOAD_AFTER_RESTART, '1'); } catch {} // 다시 연결되면 확장도 새로고침
  renderUpdate();
}

// 확장 폴더의 버전(디스크)과 호스트 폴더의 버전(디스크)이 다르면 서로 다른 폴더에서 온 것이다.
// 같은 폴더면 업데이트·커밋이 둘을 함께 바꾸므로 같아야 한다(RELEASING: package.json과 manifest를 같이 올린다)
const mismatch = () => !!updateState?.disk && !!extDisk && updateState.disk !== extDisk;
function mismatchText() {
  const u = updateState;
  return `확장과 호스트가 서로 다른 폴더에서 왔습니다.
· 확장: v${extVersion()} (불러온 폴더의 버전 v${extDisk})
· 호스트: v${u.version} · ${u.home || '폴더 모름'}${u.dev ? ' (개발 체크아웃)' : u.tag ? ` (릴리즈 ${u.tag})` : ''}
업데이트 확인은 호스트 폴더 기준이라, 확장 쪽의 새 버전은 알 수 없습니다.
할 일: 쓰려는 쪽으로 맞춥니다.
· 설치본을 쓰려면: 다른 호스트를 끄면 사이드패널이 설치본 호스트를 자동으로 켭니다.
· 개발 폴더를 쓰려면: chrome://extensions 에서 그 폴더의 spike/extension 을 불러옵니다.`;
}

function renderUpdate() {
  const el = $('upd-pill');
  const u = updateState;
  const hostStale = !!u?.stale;
  const extStale = !!extDisk && extDisk !== extVersion();
  let text = '', tip = '', kind = '';
  if (mismatch()) {
    kind = 'mismatch';
    text = '호스트 불일치';
    tip = `${mismatchText()}\n\n누르면 대화창에 적습니다.`;
  } else if (u?.available) {
    kind = 'apply';
    text = updating ? '업데이트 중…' : `업데이트 ${u.latest.tag}`;
    const notes = u.latest.notes?.trim();
    tip = `새 버전 ${u.latest.tag} · 지금 v${u.version}${notes ? `\n\n${notes}` : ''}\n\n누르면 업데이트합니다.`;
  } else if (hostStale || extStale) {
    kind = 'fresh';
    const v = u?.disk || extDisk;
    text = updating ? '적용 중…' : `새 버전 적용 v${v}`;
    tip = [`새 버전 v${v}이 받아져 있습니다.`,
      hostStale ? `· 호스트: v${u.version}로 돌고 있음 → 다시 켭니다(세션·기록 유지)` : null,
      extStale ? `· 확장: v${extVersion()}로 불러와 있음 → 새로고침합니다(패널이 닫히니 다시 여세요)` : null,
      '누르면 적용합니다.'].filter(Boolean).join('\n');
  }
  el.hidden = !kind;
  el.textContent = text;
  el.dataset.act = kind;
  el.dataset.tip = tip; // 빠른 툴팁으로 변경 내용·할 일을 보여 준다
  el.disabled = updating || (kind === 'apply' && aiBusy) || (kind === 'fresh' && hostStale && aiBusy);
  // 버전 표시에 마우스를 올리면 확장·호스트의 버전과 호스트 폴더를 보여 준다
  // 새 릴리즈가 있으면 메뉴 버튼에 점, 메뉴의 '릴리즈 노트 보기'에 '새 버전'을 단다
  $('menu-btn').classList.toggle('has-new', !!u?.available);
  $('menu-release-badge').hidden = !u?.available;
  if (u) $('ver').dataset.tip = `확장 v${extVersion()} · 호스트 v${u.version}\n호스트 폴더 ${u.home || '-'}${u.dev ? ' (개발 체크아웃)' : u.tag ? ` (릴리즈 ${u.tag})` : ''}`;
}

$('upd-pill').addEventListener('click', (e) => {
  const act = e.currentTarget.dataset.act;
  if (act === 'mismatch') return msg('sys', mismatchText());
  if (act === 'fresh' && !updating) {
    if (updateState?.stale && ws?.readyState === 1) {
      // 호스트부터 다시 켜고, 다시 연결되면(onUpdate) 확장을 새로고침한다
      updating = true;
      try { sessionStorage.setItem(RELOAD_AFTER_RESTART, '1'); } catch {}
      renderUpdate();
      ws.send(JSON.stringify({ type: 'host_restart' }));
    } else chrome.runtime.reload();
    return;
  }
  if (act === 'apply' && updateState?.available && ws?.readyState === 1 && !updating) {
    updating = true;
    renderUpdate();
    msg('me', `${updateState.latest.tag}로 업데이트`);
    ws.send(JSON.stringify({ type: 'update_apply', tag: updateState.latest.tag }));
  }
});

// 패널을 다시 볼 때마다 확인한다(호스트가 GitHub과 디스크를 다시 본다)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'update_check' }));
});

// ── 헤더 메뉴(⋯) ──
function setMenu(open) {
  $('menu').hidden = !open;
  $('menu-btn').setAttribute('aria-expanded', String(open));
  if (open) $('menu').querySelector('button')?.focus();
}
$('menu-btn').addEventListener('click', (e) => { e.stopPropagation(); setMenu($('menu').hidden); });
document.addEventListener('click', (e) => { if (!$('menu').hidden && !e.target.closest('.menu-wrap')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('menu').hidden) { setMenu(false); $('menu-btn').focus(); } });
$('menu').addEventListener('click', (e) => {
  const act = e.target.closest('[data-menu]')?.dataset.menu;
  if (!act) return;
  setMenu(false);
  if (act === 'release') openRelease();
  if (act === 'logs') {
    if (ws?.readyState !== 1) return msg('err', '호스트와 연결되어 있지 않아 로그 폴더를 열 수 없습니다');
    ws.send(JSON.stringify({ type: 'open_logs' }));
    msg('sys', `작업 로그 폴더를 엽니다: spike/.koa/domains/${viewDomain || 'default'}/logs/ (날짜별 .jsonl)`);
  }
});

// ── 릴리즈 노트 ──
// 내용은 설치본의 CHANGELOG.md(호스트가 준다). 아직 받지 않은 새 릴리즈는 GitHub 릴리즈 노트(updateState.latest.notes)로 맨 위에 보여 준다
let releaseText = null;   // CHANGELOG.md 원문
let releaseAll = false;   // 이전 버전까지 모두 펼침
let releaseOpts = {};
async function openRelease(opts = {}) {
  releaseOpts = opts;
  releaseAll = false;
  openSheet('release');
  try {
    const r = await fetch('http://127.0.0.1:8765/changelog');
    releaseText = r.ok ? await r.text() : '';
  } catch { releaseText = ''; }
  if (sheetMode === 'release') renderSheet();
}
// "## 0.2.10 — 2026-10-28" 단위로 나눈다. 버전 번호가 없는 절(다음 버전·미배포)은 빼고 보여 준다
function parseChangelog(text) {
  return String(text || '').split(/^## /m).slice(1).map((sec) => {
    const [head, ...lines] = sec.split('\n');
    const v = head.match(/^v?(\d+\.\d+\.\d+)/)?.[1];
    const date = head.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || '';
    return v && { v, date, body: lines.join('\n').trim() };
  }).filter(Boolean);
}
// CHANGELOG에 쓰는 정도의 마크다운: 목록(들여쓰기 한 단계), 굵게, 코드, 링크(글자만)
function releaseMd(text) {
  return String(text || '').split('\n').map((line) => {
    if (!line.trim()) return '';
    const sub = /^\s{2,}[-*] /.test(line);
    const li = /^\s*[-*] /.test(line);
    const t = esc(line.replace(/^\s*[-*] /, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
      .replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    return li ? `<div class="li${sub ? ' sub' : ''}">${t}</div>` : `<div>${t}</div>`;
  }).join('');
}
// 버전 비교(0.2.10 > 0.2.9)
const verParts = (v) => String(v).replace(/^v/, '').split('.').map((x) => Number.parseInt(x, 10) || 0);
const verNewer = (a, b) => { const [x, y] = [verParts(a), verParts(b)]; for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const sameMinor = (a, b) => { const [x, y] = [verParts(a), verParts(b)]; return x[0] === y[0] && x[1] === y[1]; };

// 보여 주는 범위: 사용자가 아직 확인하지 않은 것
//   펼침  — 아직 받지 않은 새 버전, 마지막으로 본 뒤 놓친 버전들(업데이트 직후), 지금 버전
//   접힘  — '이전 버전 보기': 같은 마이너(예: 0.2.x)의 이전 버전
//   그 밖 — GitHub 릴리즈 페이지 링크
function renderReleaseSheet(body) {
  const cur = extVersion();
  $('sheet-title').textContent = releaseOpts.whatsNew ? `v${cur}로 업데이트되었습니다` : '릴리즈 노트';
  if (releaseText === null) { body.innerHTML = '<div class="none">불러오는 중…</div>'; return; }
  const list = parseChangelog(releaseText);
  const latest = updateState?.available && updateState.latest;
  const lv = latest?.tag?.replace(/^v/, '');
  if (latest && !list.some((x) => x.v === lv)) list.unshift({ v: lv, date: (latest.released_at || '').slice(0, 10), body: latest.notes || '(변경 내용 없음)', fresh: true });
  const since = releaseOpts.since;
  const top = list.filter((x) => x.fresh || x.v === cur || (since && verNewer(x.v, since) && !verNewer(x.v, cur)));
  const older = list.filter((x) => !top.includes(x) && !x.fresh && verNewer(cur, x.v) && sameMinor(x.v, cur));
  const repo = updateState?.repo;
  const card = (x, open) => `<details class="rel-v" ${open ? 'open' : ''}>
      <summary><b>v${esc(x.v)}</b><span class="rel-date">${esc(x.date)}</span>
        ${x.fresh ? '<span class="rel-tag new">새 버전 · 업데이트하면 적용</span>' : x.v === cur ? '<span class="rel-tag cur">지금 버전</span>' : since && verNewer(x.v, since) ? '<span class="rel-tag">이번에 함께 받음</span>' : ''}</summary>
      <div class="rel-body">${releaseMd(x.body)}</div>
    </details>`;
  if (!top.length && !older.length) { body.innerHTML = '<div class="none">릴리즈 노트를 찾지 못했습니다. 호스트가 켜져 있는지 확인하세요.</div>'; return; }
  const [maj, min] = verParts(cur);
  body.innerHTML = `<div class="rel">
    ${top.map((x) => card(x, true)).join('')}
    ${older.length ? (releaseAll ? older.map((x) => card(x, false)).join('')
      : `<button type="button" class="btn sm ghost rel-more" data-rel="all">이전 버전 보기 (${maj}.${min}.x · ${older.length}개)</button>`) : ''}
    ${repo ? `<a class="rel-link" href="https://github.com/${esc(repo)}/releases" target="_blank" rel="noopener">전체 기록은 GitHub 릴리즈에서 보기 ↗</a>` : ''}
  </div>`;
}
document.getElementById('sheet-body').addEventListener('click', (e) => {
  if (sheetMode === 'release' && e.target.closest('[data-rel="all"]')) { releaseAll = true; renderSheet(); }
});

// 새 버전으로 바뀐 뒤 처음 패널을 열면 릴리즈 노트를 한 번 보여 준다(처음 설치할 때는 보여 주지 않는다)
let whatsNewChecked = false;
async function checkWhatsNew() {
  if (whatsNewChecked) return;
  whatsNewChecked = true;
  const v = extVersion();
  let seen = null, existing = false;
  try {
    const r = await chrome.storage.local.get(['seenRelease', 'profiles']);
    seen = r.seenRelease || null;
    existing = !!r.profiles; // 이 기능 전부터 쓰던 사람(본 버전 기록이 없다)도 한 번 보여 준다
  } catch {}
  try { await chrome.storage.local.set({ seenRelease: v }); } catch {}
  // 마지막으로 본 버전 다음부터 지금 버전까지를 '놓친 버전'으로 펼쳐 보여 준다
  if ((seen ? seen !== v : existing) && !sheetMode) openRelease({ whatsNew: true, since: seen });
}
