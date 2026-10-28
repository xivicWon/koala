// 세트 테스트 목록: <세트>/tests/tests.json (목록) · results/ (실행 결과). 패널의 suite 객체와 같은 모양에 applied, base_version을 더한다.
import fs from 'node:fs';
import path from 'node:path';
import { setPaths } from './sets.mjs';

const emptySuite = (id) => ({ id, name: id, scenarios: [], cases: [], flow: [], coverage: [], code: null, applied: false, base_version: 0 });

// 없으면 null. 깨진 파일은 .bad-<시각>으로 옮겨 두고 던진다(빈 목록으로 읽혀 덮어써지지 않게).
const readJson = (file) => {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { return JSON.parse(text); } catch {
    const bad = `${file}.bad-${new Date().toISOString().replace(/[^0-9A-Za-z]/g, '-')}`;
    fs.renameSync(file, bad);
    throw new Error(`${path.basename(file)} 파일이 손상되어 읽지 못했습니다. 원본은 ${bad} 에 보관했습니다.`);
  }
};
// 임시 파일에 쓴 뒤 rename — 쓰다 끊겨도 기존 파일이 깨지지 않는다
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
};

export function loadTests(setId, root) {
  const saved = readJson(setPaths(setId, root).testsFile);
  return saved ? { ...emptySuite(setId), ...saved } : emptySuite(setId);
}

export function saveTests(setId, suite, root) {
  writeJson(setPaths(setId, root).testsFile, suite);
}

const maxNum = (items, prefix) =>
  items.reduce((m, x) => {
    const n = new RegExp(`^${prefix}-(\\d+)$`).exec(x?.id)?.[1];
    return n ? Math.max(m, Number(n)) : m;
  }, 0);

// 새 항목을 세트 끝에 더한다. 새 id는 세트 안 최대+1부터 다시 매기고 케이스의 시나리오 참조도 따라 바꾼다.
export function addTests(suite, { scenarios = [], cases = [], flow = [], coverage = [] } = {}) {
  const renamed = {};
  let sc = maxNum(suite.scenarios || [], 'SC');
  let tc = maxNum(suite.cases || [], 'TC');
  const newScenarios = scenarios.map((s) => {
    const id = `SC-${++sc}`;
    if (s.id) renamed[s.id] = id;
    return { ...s, use: s.use ?? true, id, added: true };
  });
  const newCases = cases.map((c) => {
    const id = `TC-${++tc}`;
    if (c.id) renamed[c.id] = id;
    return { ...c, use: c.use ?? true, id, scenario: renamed[c.scenario] ?? c.scenario, added: true };
  });
  return {
    suite: {
      ...suite,
      scenarios: [...(suite.scenarios || []), ...newScenarios],
      cases: [...(suite.cases || []), ...newCases],
      flow: [...(suite.flow || []), ...flow],
      coverage: [...(suite.coverage || []), ...coverage],
      applied: false,
    },
    renamed,
  };
}

// 패널이 보낸 바뀐 것만 받는다: 항목의 채택·태그·이슈·새로 표시, 반영 여부, 이름·범위. 보낸 필드만 바꾸고 null 이면 지운다.
// 항목 내용, 코드·실행 결과·code.key, 서버 기준 버전(base_version)은 호스트 것을 그대로 둔다(보낸 뒤 올린 버전을 패널이 되돌리지 않게).
// 패널에만 있는 항목은 더하지 않는다(항목은 AI 저장으로만 생긴다)
const PANEL_ITEM = ['use', 'tags', 'issue', 'added'];
export function applyPanelEdits(cur, panel = {}) {
  const pick = (list, from) => {
    const mine = new Map((from || []).map((c) => [c?.id, c]));
    return (list || []).map((c) => {
      const p = mine.get(c.id);
      if (!p) return c;
      const out = { ...c };
      for (const k of PANEL_ITEM) {
        if (!Object.hasOwn(p, k)) continue;
        if (p[k] === null) delete out[k]; else out[k] = p[k];
      }
      return out;
    });
  };
  const top = (k) => (Object.hasOwn(panel, k) && panel[k] !== null ? { [k]: k === 'applied' ? !!panel[k] : panel[k] } : {});
  return { ...cur, scenarios: pick(cur.scenarios, panel.scenarios), cases: pick(cur.cases, panel.cases), ...top('applied'), ...top('name'), ...top('scope') };
}

// 코드를 만들 때의 채택 목록 표시: 채택한 항목의 id·태그·이슈. 패널(suite.js adoptedKey)과 같은 식이다.
// 채택·태그·이슈가 바뀌면 이 값이 달라져 코드를 다시 만들어야 서버로 보낼 수 있다
export function adoptedKey(s) {
  return [...(s?.scenarios || []), ...(s?.cases || [])].filter((c) => c.use !== false)
    .map((c) => `${c.id}:${(c.tags || []).join('+')}:${c.issue || ''}`).join(',');
}

// results: [{ title, status, … }]. last.json은 제목별 마지막 결과, runs/<ranAt>.json은 이번 실행.
export function recordResults(setId, results, ranAt, root) {
  const dir = setPaths(setId, root).results;
  const last = readJson(`${dir}/last.json`) || {};
  for (const r of results) last[r.title] = { ...r, ranAt };
  writeJson(`${dir}/last.json`, last);
  // 파일 이름에 쓸 수 없는 글자(':' '/' 등)는 '-'로 바꾼다. 원래 값은 본문에 남긴다
  writeJson(`${dir}/runs/${String(ranAt).replace(/[^0-9A-Za-z._-]/g, '-')}.json`, { ranAt, results });
}
