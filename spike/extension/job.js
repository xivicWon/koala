// 진행 단계 카드: 호스트가 보내는 작업 단계(job)를 입력창 위에 보여 준다.
// 단계 줄(끝난 단계 ✓ · 지금 단계 · 남은 단계) + 지금 하는 일 + 경과 시간(1초마다 갱신)
let jobNow = null;  // 호스트가 보낸 마지막 job 메시지
let jobHide = null; // 끝난 뒤 카드를 접는 타이머

const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function onJob(m) {
  clearTimeout(jobHide);
  jobNow = m;
  renderJob();
  // 성공하면 잠시 보여 주고 접는다. 실패·중지는 다음 작업이 시작될 때까지 남긴다
  if (m.done && m.ok) jobHide = setTimeout(() => { jobNow = null; renderJob(); }, 6000);
}

function renderJob() {
  const el = $('job-card');
  const j = jobNow;
  el.hidden = !j;
  if (!j) return;
  const at = j.steps.findIndex(([k]) => k === j.key);
  const steps = j.steps.map(([k, label], i) => {
    const st = j.done ? (j.ok || i < at ? 'done' : i === at ? 'fail' : 'todo') : i < at ? 'done' : i === at ? 'now' : 'todo';
    return `<li class="js-${st}"><span class="js-dot">${st === 'done' ? '✓' : st === 'fail' ? '!' : i + 1}</span>${esc(label)}</li>`;
  }).join('<li class="js-sep" aria-hidden="true"></li>');
  const time = j.done ? mmss(j.elapsed) : mmss(Date.now() - j.started);
  const head = j.done ? (j.ok ? '완료' : '멈춤') : (j.steps[at]?.[1] || '진행 중');
  const detail = j.done ? (j.detail || (j.ok ? '' : '작업이 끝나지 못했습니다')) : j.detail;
  el.className = `job-card ${j.done ? (j.ok ? 'ok' : 'fail') : 'run'}`;
  el.innerHTML = `<div class="job-h"><b>${esc(j.label)}</b><span class="job-now">${esc(head)}${j.round > 1 ? ` · 수정 ${j.round - 1}회째` : ''}</span>
      <span class="grow"></span><span class="job-time mono" title="경과 시간">${time}</span></div>
    <ol class="job-steps">${steps}</ol>
    ${detail ? `<div class="job-detail">${esc(detail)}</div>` : ''}`;
}

// 진행 중에는 경과 시간을 1초마다 갱신한다
setInterval(() => {
  if (!jobNow || jobNow.done) return;
  const t = $('job-card').querySelector('.job-time');
  if (t) t.textContent = mmss(Date.now() - jobNow.started);
}, 1000);
