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
