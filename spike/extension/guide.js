// 사용 가이드: 입력창 위 '사용 가이드' 버튼. 어떤 순서로, 어떻게 말하면 되는지 보여 준다.
// 예시 문장을 누르면 입력창에 넣는다(바로 실행하지는 않는다)
const GUIDE = [
  { t: '세트 고르기', d: '오른쪽 위 세트 칩에서 점검할 세트(서비스·버전·목적)를 받고 고릅니다. 대상 탭이 그 세트의 사이트여야 실행됩니다. 로그인 계정은 세트 창의 <b>내 설정 → 역할과 계정</b>에서 확인합니다.' },
  { t: '대화로 테스트하기', d: '확인할 흐름을 입력창에 적고 <b>실행</b>합니다. AI가 화면을 직접 조작하고, 단계·요청·오류가 타임라인에 나옵니다. 나눠서 여러 번 지시해도 같은 대화로 이어집니다.',
    ex: ['로그인하고 회원가입 화면의 입력란이 잘 보이는지 확인해줘', '등록 화면에서 필수값을 비우고 등록하면 어떻게 되는지 확인해줘', '목록에서 검색어로 찾고 상세 화면까지 열어 봐줘'] },
  { t: '테스트 만들기', d: '수행이 끝나면 테스트로 만들어 달라고 말합니다. 그 응답이 끝난 뒤 BDD 시나리오·TDD 케이스 초안이 만들어집니다. 범위를 붙일 수 있습니다.',
    ex: ['지금까지 한 걸로 테스트 만들어줘', '로그인 부분만 테스트로 만들어줘', '예외 상황 위주로 테스트 만들어줘'] },
  { t: '고르고 반영하기', d: '<b>테스트 목록</b>에서 쓸 항목은 채택, 뺄 항목은 미채택한 뒤 <b>반영</b>합니다. 미채택 항목은 지워지지 않아 나중에 다시 살릴 수 있습니다. 빠진 것은 <b>+ 테스트 추가</b>에 적습니다.' },
  { t: '코드 만들고 실행하기', d: '테스트 목록의 <b>코드 생성</b>으로 Playwright 코드를 만들면 이 PC에서 바로 실행해 통과·실패를 보여 줍니다.' },
  { t: '서버로 보내기', d: '결과를 확인했으면 <b>서버 전송</b>으로 보냅니다. 세트에 배포 서버가 있어야 켜집니다.' },
];
const GUIDE_TIPS = [
  '역할이 여럿이면 입력창 아래 역할 칩으로 어느 계정으로 할지 고릅니다. 여럿을 고르면 차례로 다시 로그인해 수행하고 권한 차이를 표로 정리합니다.',
  '수행 중에는 <b>실행</b> 버튼이 <b>중지</b>로 바뀝니다. 위쪽 <b>▾ x2 ▴</b>로 조작을 보여 주는 배속(x1·x2·x3, 기본 x2)을 바꾸고, ❚❚로 잠시 멈춥니다. 둘 다 AI가 조작하는 동안에만 켜집니다.',
  '처음부터 다시 하려면 <b>Claude</b> 버튼 → <b>세션 비우기</b>(대화만) 또는 <b>기록까지 비우기</b>(수행 기록까지).',
  'AI가 만드는 데이터에는 이름 앞에 <code>[koa]</code>가 붙습니다.',
];

function renderGuideSheet(body) {
  $('sheet-title').textContent = '사용 가이드';
  body.innerHTML = `<div class="guide">
    <ol class="guide-steps">${GUIDE.map((g) => `<li>
      <b class="guide-t">${g.t}</b>
      <div class="guide-d">${g.d}</div>
      ${g.ex ? `<div class="guide-ex">${g.ex.map((x) => `<button type="button" class="guide-chip" data-guide-ex="${esc(x)}" title="입력창에 넣기">${esc(x)}</button>`).join('')}</div>` : ''}
    </li>`).join('')}</ol>
    <div class="guide-tips"><b>알아 두면 좋은 것</b><ul>${GUIDE_TIPS.map((x) => `<li>${x}</li>`).join('')}</ul></div>
  </div>`;
}
document.getElementById('sheet-body').addEventListener('click', (e) => {
  const ex = sheetMode === 'guide' && e.target.closest('[data-guide-ex]')?.dataset.guideEx;
  if (!ex) return;
  closeSheet();
  $('q').value = ex;
  $('q').focus();
});
$('guide-btn').onclick = () => openSheet('guide');
