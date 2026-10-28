// 스파이크(버림용): claude -p 가 쓰는 koala 브라우저 도구. 호출을 호스트로 넘기고 결과를 돌려준다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import http from 'node:http';
import { hostToken, HEADER } from './host-token.mjs';

const locator = z.object({
  testid: z.string().optional().describe('data-testid 값. 있으면 최우선'),
  text: z.string().optional().describe('보이는 글자가 정확히 일치하는 요소'),
  css: z.string().optional().describe('testid·text로 안 될 때만'),
  nth: z.number().int().optional().describe('여러 개와 일치할 때 몇 번째(0부터)'),
});

// fetch(undici)는 응답 헤더를 5분까지만 기다린다. save_code처럼 테스트 실행이 끝나야 답하는 도구가 있어
// 시간 제한 없는 node:http로 부른다
function post(body) {
  return new Promise((resolve, reject) => {
    const req = http.request('http://127.0.0.1:8765/tool', { method: 'POST', headers: { 'content-type': 'application/json', [HEADER]: hostToken() } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function call(name, args) {
  const r = await post({ name, args });
  if (!r.ok) return { content: [{ type: 'text', text: JSON.stringify({ error: r.error, ...r.context }) }], isError: true };
  const { image, forAi, ...rest } = r.result;
  const content = [{ type: 'text', text: JSON.stringify(rest) }];
  if (image) content.push({ type: 'image', data: image.split(',')[1], mimeType: 'image/jpeg' });
  return { content };
}

const server = new McpServer({ name: 'koala', version: '0.0.2' });
const tool = (name, description, inputSchema) =>
  server.registerTool(name, { description, inputSchema }, (args) => call(name, args));

// 묶음 실행: 할 일을 큐로 보내면 쉬지 않고 차례로 처리하고, 실패하면 거기서 멈춘다
const ACTIONS = ['snapshot', 'screenshot', 'goto', 'back', 'click', 'type', 'select', 'hover', 'press', 'tab_order', 'fault', 'fault_clear', 'clear_login',
  'expect_visible', 'expect_text', 'expect_value', 'expect_count', 'expect_url', 'expect_focused'];
tool('run', `여러 단계를 한 번에 실행한다(권장). 각 단계는 {"tool": 이름, ...그 도구의 인자} 한 겹 객체다.
예: [{"tool":"type","locator":{"testid":"id-input"},"value":"$KOALA_ADMIN_USER"},{"tool":"click","locator":{"text":"로그인"}},{"tool":"expect_url","pattern":"/dashboard$"}]
실패하면 그 지점에서 멈추고 status:"failed", failedAt, error, 그 단계의 requests·consoleErrors, remaining(남은 단계), screen(현재 화면)을 돌려준다.
성공하면 status:"done"과 단계별 결과를 돌려준다.`, {
  steps: z.array(z.object({
    tool: z.enum(ACTIONS),
    locator: locator.optional(), url: z.string().optional(), value: z.string().optional(),
    option: z.string().optional(), key: z.string().optional(), text: z.string().optional(),
    count: z.number().int().optional(), pattern: z.string().optional(),
    method: z.string().optional(), path: z.string().optional(), kind: z.enum(['status', 'delay', 'network']).optional(),
    status: z.number().int().optional(), body: z.string().optional(), delay_ms: z.number().int().optional(), times: z.number().int().optional(),
  })).min(1),
});

// 오류 주입: 서버 오류를 실제 서버에서 일으키지 않고 화면의 오류 처리를 확인한다
tool('fault', `다음에 오는 요청(method·path 정규식 일치)에 오류를 주입한다. 실제 서버에는 요청이 가지 않는다.
kind=status: 지정한 상태 코드(400/401/403/404/409/500/503 등)로 응답, kind=delay: delay_ms만큼 지연 후 전달, kind=network: 네트워크 끊김.
times만큼 적용 후 자동 해제(기본 1). 주입한 뒤 그 요청을 일으키는 조작을 하고, 화면의 오류 안내·버튼 상태·데이터 미반영을 검증한다.`, {
  method: z.string().optional().describe('예: POST (없으면 모든 메서드)'),
  path: z.string().describe('요청 경로 정규식. 예: ^/api/inspectionDocs$'),
  kind: z.enum(['status', 'delay', 'network']),
  status: z.number().int().optional(), body: z.string().optional().describe('응답 본문(JSON 문자열). 없으면 기본 오류 본문'),
  delay_ms: z.number().int().optional(), times: z.number().int().optional(),
});
tool('fault_clear', '걸어 둔 오류 주입을 모두 해제한다', {});
tool('clear_login', '대상 사이트의 로그인 상태(쿠키·저장소)를 지운다. 다른 역할 계정으로 바꿔 로그인하기 전에 쓴다. 지운 뒤 로그인 화면으로 goto 한다', {});

// 키보드 탭 순서 (접근성·사용성 체크 포인트)
tool('tab_order', '시작 요소(locator, 없으면 현재 포커스)에서 Tab을 count번 눌러 포커스가 이동한 순서를 돌려준다(testid·라벨·글자, 화면 위치). 입력 폼·대화상자의 탭 순서 확인용', {
  locator: locator.optional(), count: z.number().int().min(1).max(30),
});
tool('expect_focused', '검증: 지금 키보드 포커스가 이 요소에 있다(press Tab 뒤에 써서 탭 순서를 테스트로 남긴다)', { locator });

// 수행 이력으로 만든 테스트 초안: 업무 흐름 지도 + BDD 시나리오 + TDD 케이스
const str = z.string();
const flowStep = z.object({
  step: str.describe('예: 1. 점검 유형 선택'),
  screen: str.describe('화면 URL 경로 또는 대화상자 이름'),
  inputs: z.array(z.object({ name: str, required: z.boolean().optional(), options: z.array(str).optional(), note: str.optional() })).optional(),
  tab_order: z.array(str).optional().describe('tab_order로 확인한 포커스 이동 순서(요소 이름). 화면 순서와 다르면 note에 적는다'),
  messages: z.array(str).optional().describe('화면에 나온 안내·검증 메시지'),
  request: str.optional().describe('이 단계에서 보낸 주요 데이터 요청(메서드·경로·응답 요약)'),
});
const scenario = z.object({
  id: str.describe('예: SC-REQ-01'),
  title: str,
  priority: z.enum(['high', 'medium', 'low']),
  as: str.optional().describe('이 시나리오를 수행하는(로그인하는) 역할 key. 예: ADMIN, MEMBER. 프로필 역할 목록에서 고른다. 없으면 이번에 로그인한 역할'),
  roles: z.record(str, str).optional().describe('여러 역할로 확인한 시나리오의 역할별 기대 결과. 예: {"ADMIN":"허용","MEMBER":"거부: 메뉴 없음, 주소로 들어가면 대시보드로 돌려보냄"}. 값은 "허용" 또는 "거부: …" 또는 "일부: …". 역할마다 시나리오를 복사하지 않는다'),
  given: z.array(str), when: z.array(str), then: z.array(str),
  changes_data: z.boolean(),
  cleanup: str.optional(),
  screens: z.array(str),
  evidence: str.describe('그 화면에서 실제로 확인한 요소·문구'),
  tags: z.array(str).optional().describe('서버 태그 목록에서 고른 태그(예: @smoke). 자동 태그는 적지 않아도 된다'),
});
const testCase = z.object({
  id: str.describe('예: TC-REQ-01-1'),
  scenario: str.describe('속한 시나리오 id'),
  title: str,
  technique: z.enum(['정상', '동등분할', '경계값', '예외', '권한', '접근성']),
  input: str.describe('입력값·조건'),
  expected: str.describe('기대 결과'),
  check: str.describe('검증 방법. 예: expect_text(토스트, "필수 항목") / 결재요청 목록 행 존재'),
  priority: z.enum(['high', 'medium', 'low']),
  tags: z.array(str).optional().describe('서버 태그 목록에서 고른 태그. 시나리오에서 물려받는 기능 영역 태그는 적지 않는다'),
});
tool('save_tests', `방금 실제로 수행한 이력(조작·확인·네트워크)을 근거로 테스트 초안을 만든다. 사용자가 사용/제거를 고른 뒤 반영·서버 전송한다.
- flow: 업무 흐름 지도(화면 순서, 입력 항목·필수 여부·선택지, 안내 메시지, 막힌 데이터 변경 요청)
- scenarios: BDD 시나리오(Given/When/Then, 사용자 행동 기준)
- cases: TDD 케이스(시나리오별로 입력값·기대 결과·검증 방법을 먼저 정한 세부 케이스. 정상/동등분할/경계값/예외/권한)
화면에서 확인하지 못한 내용은 만들지 않거나 '미확인'으로 표시한다.`, {
  title: str.describe('계획 제목. 예: 점검 의뢰 기능'),
  scope: str.describe('범위와 제외 범위'),
  flow: z.array(flowStep).min(1),
  scenarios: z.array(scenario).min(1),
  coverage: z.array(z.object({
    category: z.enum(['필수값 누락', '형식·길이(경계값)', '취소·닫기', '중복 제출', '세션 만료', '권한 없음', '서버 오류(4xx/5xx)', '응답 지연', '네트워크 끊김', '탭 순서']),
    status: z.enum(['수행', '미수행', '해당 없음']),
    note: str.describe('수행했다면 확인한 결과, 미수행이면 이유나 수행 방법'),
  })).describe('예외·오류 점검표. 모든 항목을 빠짐없이 채운다'),
  cases: z.array(testCase).min(1),
});

tool('make_tests', `[테스트 만들기 요청] 사용자가 지금까지 수행한 것으로 테스트(TDD·BDD 시나리오·케이스, 테스트 초안)를 만들어 달라고 할 때 부른다.
부르면 이 응답이 끝난 뒤 호스트가 수행 이력·태그 목록을 정리해 테스트 초안 만들기를 시작한다. 직접 save_tests를 부르지 않는다.
부른 뒤에는 한 줄로 알리고 응답을 끝낸다. 브라우저를 더 조작하지 않는다.`, {
  note: str.optional().describe('사용자가 덧붙인 범위·요청(예: "로그인 부분만", "예외 위주로"). 없으면 생략'),
});

tool('save_tags', '테스트 초안의 시나리오·케이스에 서버 태그 목록에서 고른 태그를 저장한다. 자동 태그와 사람이 붙인 태그는 호스트가 합친다', {
  items: z.array(z.object({ id: str.describe('시나리오 또는 케이스 id'), tags: z.array(str) })).min(1),
});

tool('save_code', `채택된 테스트를 Playwright 테스트 코드 한 파일로 저장한다. 저장하면 호스트가 바로 로컬에서 실행하고 테스트별 결과(통과·실패·오류 메시지)를 돌려준다.
실패가 있으면 고쳐서 다시 호출한다. 주소는 상대 경로, 계정은 시나리오 역할의 process.env.KOALA_ADMIN_USER 같은 환경변수로만 쓴다.`, {
  code: str.describe('TypeScript 전체 소스. import { test, expect } from \'@playwright/test\''),
});

tool('add_tests', `[테스트 추가] 기존 테스트 묶음에 새 시나리오·케이스만 덧붙인다. 기존 항목은 다시 보내지 않는다(고치거나 지우지 않음).
방금 브라우저에서 실제로 수행해 확인한 것만 넣는다. id는 기존 번호 다음으로 매기고, 새 케이스가 기존 시나리오에 속하면 그 시나리오 id를 쓴다.`, {
  scenarios: z.array(scenario).describe('새 시나리오(없으면 빈 배열)'),
  cases: z.array(testCase).describe('새 케이스'),
  flow: z.array(flowStep).optional().describe('새로 확인한 흐름 단계(있으면)'),
});

tool('append_code', `[테스트 추가] 새 테스트만 담은 코드 조각을 기존 테스트 코드 파일 끝에 덧붙인다. 기존 코드는 다시 보내지 않는다.
조각은 같은 파일 안이므로 기존 import·도우미 함수를 그대로 쓸 수 있다. test.describe('BDD', …) / test.describe('TDD', …) 를 다시 열어 그 안에 쓴다.
저장하면 호스트가 목록 검사 뒤 새 테스트만 실행해 결과를 돌려준다. 실패하면 조각 전체를 고쳐 다시 호출한다(앞서 보낸 조각은 버려진다).`, {
  code: str.describe('파일 끝에 붙일 TypeScript 조각(import 문 없이)'),
});

// 읽기
tool('snapshot', '현재 화면의 조작 가능한 요소(testid·글자·라벨·값)와 표(헤더·행 수·앞쪽 행)', {});
tool('screenshot', '현재 화면을 이미지로 본다. 레이아웃·시각적 이상을 볼 때', {});
// 이동
tool('goto', '현재 탭을 URL로 이동', { url: z.string() });
tool('back', '브라우저 뒤로 가기', {});
// 조작 (모두 실제 마우스·키보드 이벤트, 결과에 이 단계의 API 요청·콘솔 오류가 함께 온다)
tool('click', '요소 클릭', { locator });
tool('type', '입력란을 클릭해 기존 값을 지우고 한 글자씩 입력. 계정은 $KOALA_ADMIN_USER, $KOALA_ADMIN_PASS 처럼 역할 계정의 환경변수 이름으로', { locator, value: z.string() });
tool('select', '드롭다운(셀렉트)을 열고 보이는 글자가 일치하는 선택지를 고른다', { locator, option: z.string() });
tool('hover', '요소 위에 마우스를 올린다', { locator });
tool('press', '키 입력: Enter, Escape, Tab, Backspace, ArrowDown, ArrowUp', { key: z.string() });
// 검증 (테스트 코드의 expect로 기록된다)
tool('expect_visible', '검증: 요소가 보인다', { locator });
tool('expect_text', '검증: 요소의 글자에 text가 포함된다', { locator, text: z.string() });
tool('expect_value', '검증: 입력란의 값이 value와 같다', { locator, value: z.string() });
tool('expect_count', '검증: locator와 일치하는 보이는 요소 개수', { locator, count: z.number().int() });
tool('expect_url', '검증: 현재 URL이 정규식과 일치(끝까지 고정, 예: /dashboard$)', { pattern: z.string() });

await server.connect(new StdioServerTransport());
