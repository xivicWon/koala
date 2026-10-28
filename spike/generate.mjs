// 스파이크(버림용): recording.json → tests/<name>.spec.ts
//   node generate.mjs <테스트 이름> [기록 파일]
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const name = process.argv[2] || 'recorded';
// 두 번째 인자로 기록 파일을 준다(호스트는 지금 도메인의 기록을 준다). 없으면 예전 위치
const src = process.argv[3] ? nodePath.resolve(process.argv[3]) : fileURLToPath(new URL('./recording.json', import.meta.url));
const steps = JSON.parse(fs.readFileSync(src));

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
// [koa] 로 시작하는 값은 koa가 만드는 테스트 데이터다. 실행마다 겹치지 않게 실행 ID를 붙인다
const creates = steps.some((s) => typeof s.value === 'string' && s.value.startsWith('[koa]'));
const val = (v) => (v?.startsWith('$') ? `process.env.${v.slice(1)}!`
  : v?.startsWith('[koa]') ? `\`${v.replace(/[`$\\]/g, '\\$&')} \${RUN}\`` : q(v ?? ''));
const base = (l) =>
  l.testid ? `page.getByTestId(${q(l.testid)})`
  : l.role ? `page.getByRole(${q(l.role)}, { name: ${q(l.name)} })`
  : l.text ? `page.getByText(${l.text.startsWith('[koa]') ? val(l.text) : q(l.text)}, { exact: true })`
  : `page.locator(${q(l.css)})`;
// 기록 당시 여러 개와 일치했으면 Playwright strict 모드에 걸리지 않도록 몇 번째인지 명시한다
const loc = (l, matched) =>
  base(l) + (l.nth != null ? `.nth(${l.nth})` : matched > 1 ? '.first()' : '');
const path = (u) => { const x = new URL(u); return x.pathname + x.search; };

// 같은 표의 행을 n번째로 짚는 검증은 직전에 확인한 [koa] 행 안으로 좁힌다(행 순서에 의존하지 않도록)
let koaRow = null; // { key: 행 locator, text: [koa] 이름 }
const body = steps.map((s) => {
  if (s.locator?.nth != null && s.action === 'expectText') {
    const { nth, ...rest } = s.locator;
    const key = JSON.stringify(rest);
    if (s.text?.startsWith('[koa]')) koaRow = { key, text: s.text };
    else if (koaRow?.key === key) {
      return `await expect(${base(rest)}.filter({ hasText: ${val(koaRow.text)} })).toContainText(${q(s.text)});`;
    }
  }
  const L = s.locator && loc(s.locator, s.matched);
  switch (s.action) {
    case 'goto': return `await page.goto(${q(path(s.url))});`;
    case 'back': return 'await page.goBack();';
    case 'click': return `await ${L}.click();`;
    case 'hover': return `await ${L}.hover();`;
    case 'type':
    case 'fill': return `await ${L}.fill(${val(s.value)});`;
    case 'select': return `await ${L}.click();\n  await page.getByRole('option', { name: ${q(s.option)}, exact: true }).click();`;
    case 'press': return `await page.keyboard.press(${q(s.key)});`;
    case 'expectVisible': return `await expect(${L}).toBeVisible();`;
    // koa는 화면에 보이는 글자(innerText)로 확인하므로 같은 기준으로 비교한다
    // 새로 만든 [koa] 데이터를 "n번째 행"으로 확인하면 순서에 따라 깨진다. 그 이름을 가진 행이 보이는지로 바꾼다
    case 'expectText':
      if (s.text?.startsWith('[koa]') && s.locator?.nth != null) {
        const { nth, ...rest } = s.locator;
        return `await expect(${base(rest)}.filter({ hasText: ${val(s.text)} })).toBeVisible();`;
      }
      return `await expect(${L}).toContainText(${s.text?.startsWith('[koa]') ? val(s.text) : q(s.text)}, { useInnerText: true });`;
    case 'expectValue': return `await expect(${L}).toHaveValue(${val(s.value)});`;
    case 'expectCount': return `await expect(${base(s.locator)}.filter({ visible: true })).toHaveCount(${s.count});`;
    // 오류 주입은 Playwright 라우팅으로 옮긴다(실제 서버에 가지 않음)
    case 'fault': {
      const m = s.method ? `route.request().method() !== ${q(s.method.toUpperCase())} ? route.continue() : ` : '';
      const act = s.kind === 'network' ? `route.abort('internetdisconnected')`
        : s.kind === 'delay' ? `new Promise((r) => setTimeout(r, ${s.delay_ms || 3000})).then(() => route.continue())`
        : `route.fulfill({ status: ${s.status || 500}, contentType: 'application/json', body: ${q(s.body ?? JSON.stringify({ status: s.status || 500, error: 'koa fault injection' }))} })`;
      return `await page.route((url) => new RegExp(${q(s.path)}).test(url.pathname + url.search), (route) => ${m}${act}, { times: ${s.times ?? 1} });`;
    }
    // 역할을 바꾸려고 로그인 상태를 지운다
    case 'clearLogin': return `await page.context().clearCookies();\n  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });`;
    case 'faultClear': return `await page.unrouteAll({ behavior: 'ignoreErrors' });`;
    case 'expectFocused': return `await expect(${L}).toBeFocused();`;
    case 'expectUrl': return `await expect(page).toHaveURL(new RegExp(${q(s.pattern)}));`;
    default: return `// 지원하지 않는 단계: ${JSON.stringify(s)}`;
  }
}).map((line, i) => {
  // 새로 만든 [koa] 데이터는 목록(검색 색인)에 늦게 반영될 수 있다. 보일 때까지 새로고침하며 다시 확인한다
  const s = steps[i];
  const koaCheck = s.action?.startsWith('expect') && [s.text, s.value, s.locator?.text].some((v) => v?.startsWith?.('[koa]'));
  if (!koaCheck) return line;
  return `{\n    let tries = 0;\n    await expect(async () => {\n      if (tries++) await page.reload();\n      ${line}\n    }).toPass({ timeout: 20_000 });\n  }`;
}).map((l) => `  ${l}`).join('\n');

fs.mkdirSync(new URL('./tests/', import.meta.url), { recursive: true });
const out = new URL(`./tests/${name}.spec.ts`, import.meta.url);
const header = creates
  ? `import { cleanupKoaData } from './support/cleanup';

// 이 실행에서 만든 [koa] 데이터를 구분하는 ID
const RUN = Date.now().toString(36);

test.afterEach(async ({ page }) => {
  const cleaned = await cleanupKoaData(page, RUN);
  console.log('[koa] 정리:', cleaned);
});
`
  : '';
fs.writeFileSync(out, `// koa 스파이크가 recording.json 에서 자동 생성
import { test, expect } from '@playwright/test';
${header}
test(${q(name)}, async ({ page }) => {
${body}
});
`);
console.log(`생성: ${out.pathname}`);
