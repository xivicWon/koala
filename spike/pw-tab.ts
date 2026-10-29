// 작업 탭에서 실행할 때 생성 코드가 '@playwright/test' 대신 불러오는 것(호스트가 사본의 import 를 바꾼다).
// 새 브라우저를 띄우지 않고 koala 중계(KOALA_TAB_RELAY)에 붙어, 사용자가 보고 있는 작업 탭을 page 로 준다.
// 작업 탭은 하나라 테스트는 차례로 돌고, 로그인 상태(쿠키)는 사용자 브라우저와 함께 쓴다
import { test as base, chromium } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

export * from '@playwright/test';

export const test = base.extend<{ context: BrowserContext; page: Page }>({
  context: async ({ baseURL }, use) => {
    const browser = await chromium.connectOverCDP(process.env.KOALA_TAB_RELAY!);
    const context = browser.contexts()[0];
    // 붙은 기본 컨텍스트에는 baseURL 이 없다. toHaveURL·waitForURL 의 상대 주소가 baseURL 기준으로 풀리게 맞춘다
    (context as any)._options = { ...(context as any)._options, baseURL };
    await use(context);
    await browser.close(); // 중계가 브라우저 닫기를 막으므로 연결만 끊긴다(작업 탭은 그대로)
  },
  page: async ({ context, baseURL, viewport, isMobile, hasTouch }, use) => {
    const page = context.pages()[0];
    // test.use({ viewport, isMobile, hasTouch }) 로 정한 화면 크기를 작업 탭에 걸고, 테스트가 끝나면 사용자가 고른 크기로 되돌린다
    // (작업 탭 실행에서는 설정의 viewport 기본값이 null 이라, 값이 있으면 테스트 코드가 정한 것이다)
    const screen = (body: object) => fetch(process.env.KOALA_TAB_SCREEN!, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.ok);
    const custom = !!(viewport || isMobile || hasTouch);
    if (custom) await screen({ width: viewport?.width, height: viewport?.height, mobile: isMobile, touch: hasTouch });
    // page.goto('/login') 같은 상대 주소도 baseURL 기준으로
    const goto = page.goto.bind(page);
    page.goto = ((url: string, opts?: Parameters<Page['goto']>[1]) => goto(baseURL ? new URL(url, baseURL).href : url, opts)) as Page['goto'];
    await use(page);
    await screen({ reset: true }); // page.setViewportSize 로 바꾼 크기도 되돌린다
  },
});
