// 실패한 테스트 고치기(소거법)를 돕는다: 실행 결과에서 실패 증거를 뽑고, 같은 작업 안의 시도를 테스트별로 남겨
// AI가 이미 배제한 가설을 다시 시도하거나 같은 실패를 같은 방향으로 고치지 않게 한다
import fs from 'node:fs';
import path from 'node:path';

const clean = (s) => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');

// Playwright JSON 결과(테스트 한 번) → 실패 증거: 실패한 단계·줄·앞뒤 코드·실패 순간의 화면(error-context)
export function failDetail(r, { pageMax = 3000 } = {}) {
  const e = r?.error;
  if (!e) return undefined;
  const ctx = (r.attachments || []).find((a) => a.name === 'error-context' && a.path);
  let page;
  try { page = ctx ? fs.readFileSync(ctx.path, 'utf8').slice(0, pageMax) : undefined; } catch {}
  return {
    at: e.location ? `${path.basename(e.location.file)}:${e.location.line}` : undefined,
    step: failedStep(r.steps || []),
    snippet: e.snippet ? clean(e.snippet) : undefined,
    page,
  };
}
// 오류가 난 test.step 을 바깥부터 이어 붙인다('Then 완료가 보인다 > 저장 확인')
function failedStep(steps) {
  for (const s of steps) {
    if (!s.error) continue;
    const inner = failedStep(s.steps || []);
    return inner ? `${s.title} > ${inner}` : s.title;
  }
  return undefined;
}

const errorHead = (msg) => clean(msg).split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 200) || '';
// 저장 때 AI가 적은 note 에서 이 테스트 id 가 든 줄만 고른다(없으면 note 전체)
function noteFor(note, title) {
  if (!note) return undefined;
  const id = title.split(' ')[0];
  const mine = note.split('\n').filter((l) => l.includes(id)).join('\n');
  return (mine || note).slice(0, 300);
}

// 테스트별 시도 기록. 새 코드 작업(생성·추가)마다 reset 한다. 세트가 바뀌면 저절로 비운다
export function createFixLog({ pageLimit = 5 } = {}) {
  let set = null;
  let n = 0;
  const tries = new Map(); // title → [{ n, status, sig, step, at, error, note }]
  const log = {
    reset(id = null) { set = id; n = 0; tries.clear(); },
    // 실행 한 번(결과마다 debug = failDetail)을 기록하고 AI에게 돌려줄 실패 목록·회귀를 만든다
    record(id, results, note = '') {
      if (id !== set) log.reset(id);
      n += 1;
      const failures = [];
      const regressed = [];
      for (const r of results) {
        const past = tries.get(r.title) || [];
        const prev = past.at(-1);
        const d = r.debug || {};
        const error = r.status === 'failed' ? errorHead(r.error) : undefined;
        // 같은 실패: 같은 단계·같은 줄·같은 오류 첫 줄
        const sig = r.status === 'failed' ? `${d.step || ''}|${d.at || ''}|${error}` : '';
        tries.set(r.title, [...past, { n, status: r.status, sig, step: d.step, at: d.at, error, note: noteFor(note, r.title) }]);
        if (r.status !== 'failed') continue;
        if (prev?.status === 'passed') regressed.push(r.title);
        let repeat = 1;
        for (let i = past.length - 1; i >= 0 && past[i].sig === sig; i--) repeat += 1;
        failures.push({
          title: r.title, error: r.error, step: d.step, at: d.at, snippet: d.snippet,
          // 화면은 앞쪽 실패 몇 개만 싣는다(도구 결과가 너무 커지지 않게)
          page: failures.length < pageLimit ? d.page : d.page && '(생략: 실패가 많아 앞쪽 테스트만 화면을 싣는다)',
          tries: past.length ? past.slice(-3).map(({ n: t, status, step, at, error: er, note: nt }) => ({ try: t, status, step, at, error: er, note: nt })) : undefined,
          repeat: repeat > 1 ? repeat : undefined,
          regressed: prev?.status === 'passed' || undefined,
        });
      }
      return { failures, regressed };
    },
  };
  return log;
}
