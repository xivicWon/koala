// ── 공사 중(미구현·임시) 항목 ──
// 아직 다 만들지 않았거나 임시로 돌아가는 기능을 쓰려 할 때 공사 표지판으로 알린다.
// 무엇이 지금 되고, 무엇이 안 되고, 그래서 무슨 일이 생기고, 무엇을 고쳐야 하는지를 적는다
const WIP = {
  publish: {
    title: '서버 전송',
    now: '채택한 테스트를 <b>임시 형태(JSON)</b>로 세트의 배포 서버에 보냅니다. 배포 서버가 이 PC면 이 PC의 임시 저장소(<span class="mono">spike/.koa/store/suites/</span>)에 들어갑니다.',
    missing: ['팀이 함께 쓰는 실제 서버가 없습니다', '서버로 보낼 데이터 형태(파일·JSON)가 정해지지 않았습니다', '배포 서버에 인증이 없습니다. 주소를 아는 누구나 받고 덮어쓸 수 있습니다'],
    impact: '보낸 내용은 다른 사람에게 가지 않고, 형태가 정해지면 다시 보내야 할 수 있습니다.',
    next: '데이터 형태 정의 → 보내기 모듈 교체 → 배포 서버 인증',
  },
  sync: {
    title: '서버에서 세트 받기',
    now: '실제 서버가 아니라 <b>이 PC의 임시 저장소</b>(<span class="mono">spike/.koa/store/</span>)를 서버처럼 읽어 세트를 받습니다.',
    missing: ['실제 서버에서 받지 않습니다', '서버 API·인증이 없습니다'],
    impact: '다른 PC나 팀원이 바꾼 세트 정의·역할·지식·태그는 오지 않습니다.',
    next: '서버 API 연결 → 받는 쪽(sets.mjs)만 바꾸기',
  },
  conflict: {
    title: '서버 전송 충돌',
    now: '배포 서버에 이 세트의 더 새 판이 있으면 <b>덮어써서 올리기</b>만 할 수 있습니다.',
    missing: ['서버 판 불러오기는 아직 없습니다(테스트 목록은 이 PC 호스트가 원본이라, 서버 판으로 바꾸는 기능을 호스트에 새로 만들어야 합니다)'],
    impact: '덮어쓰면 서버에 있던 더 새 판의 내용은 이 PC의 목록으로 바뀝니다. 다른 사람이 올린 판을 받으려면 지금은 방법이 없습니다.',
    next: '호스트에 서버 판 받기(세트 목록 교체) 추가 → 패널 버튼',
  },
  secret: {
    title: '계정 비밀번호 저장',
    now: '입력한 계정 값은 Chrome 확장 저장소에 <b>암호화하지 않고</b> 저장됩니다.',
    missing: ['OS 보안 저장소(키체인)에 저장하기 — 뒤로 미룸'],
    impact: '이 PC에 접근할 수 있는 사람·프로그램이 값을 읽을 수 있습니다. <b>운영 계정은 넣지 마세요.</b>',
    next: '키체인 저장',
  },
};

// 공사 표지판. compact: 머리줄과 한 줄 요약만
function wipSign(id, { actions = '', compact = false } = {}) {
  const w = WIP[id];
  if (!w) return '';
  return `<div class="wip" role="alert" data-wip="${id}">
    <div class="wip-stripe" aria-hidden="true"></div>
    <div class="wip-h"><span class="wip-ic" aria-hidden="true"></span><span class="wip-k">공사 중</span><b>${w.title}</b><span class="wip-sub">아직 완성되지 않은 기능입니다</span></div>
    <div class="wip-b">
      <div><span class="wip-l">지금</span><span>${w.now}</span></div>
      ${compact ? '' : `<div><span class="wip-l">안 되는 것</span><ul>${w.missing.map((x) => `<li>${x}</li>`).join('')}</ul></div>`}
      <div><span class="wip-l">그래서</span><span>${w.impact}</span></div>
      ${compact ? '' : `<div><span class="wip-l">고칠 것</span><span>${w.next}</span></div>`}
    </div>
    ${actions ? `<div class="wip-a">${actions}</div>` : ''}
    <div class="wip-stripe" aria-hidden="true"></div>
  </div>`;
}

// 입력칸을 처음 누를 때 그 칸 묶음 아래에 표지판을 한 번 붙인다(다시 그리지 않아 입력이 끊기지 않게)
function wipOnFocus(sel, id, anchorSel) {
  document.getElementById('sheet-body').addEventListener('focusin', (e) => {
    if (!e.target.matches(sel)) return;
    const anchor = e.target.closest(anchorSel);
    if (!anchor || anchor.parentElement.querySelector(`[data-wip="${id}"]`)) return;
    anchor.insertAdjacentHTML('afterend', wipSign(id, { compact: true }));
  });
}
wipOnFocus('[data-acc]', 'secret', '.pf-acc');

function renderWipSheet(body) {
  $('sheet-title').textContent = '공사 중인 기능';
  body.innerHTML = `<div class="pf-hint" style="margin:0 0 10px">아래 기능은 아직 완성되지 않았거나 임시로 돌아갑니다. 쓰려고 하면 같은 표지판이 뜹니다.</div>
    ${Object.keys(WIP).map((id) => wipSign(id)).join('')}`;
}
$('menu-wip-count').textContent = Object.keys(WIP).length;
