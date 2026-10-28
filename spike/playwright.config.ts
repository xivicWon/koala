import { defineConfig } from '@playwright/test';
import 'dotenv/config';

export default defineConfig({
  testDir: './tests',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.KOALA_BASE_URL,
    channel: 'chrome',
    trace: 'on',
    screenshot: 'on',
  },
  projects: [
    // 사이드패널에서 채택한 테스트로 만든 코드(테스트 묶음). 같은 계정을 쓰므로 순차 실행
    { name: 'suites', testMatch: /suites\/.*\.spec\.ts/, fullyParallel: false },
    // tests/ 아래 직접 둔 테스트
    { name: 'local', testIgnore: /suites\//, fullyParallel: false },
  ],
});
