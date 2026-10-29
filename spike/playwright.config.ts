import { defineConfig } from '@playwright/test';
import 'dotenv/config';
import path from 'node:path';

// paths.mjs 와 같게: 상대 경로는 실행 위치(cwd) 기준
const dataDir = process.env.KOALA_DATA_DIR ? path.resolve(process.env.KOALA_DATA_DIR) : '.koa';
// 사이드패널에서 고른 화면 크기(없으면 작업 탭의 지금 크기). 새 브라우저 실행이 작업 탭과 같은 크기로 돈다. 서버·CI 에서는 비어 있어 기본값
const vp = /^(\d+)x(\d+)$/.exec(process.env.KOALA_VIEWPORT || '');
const screen = {
  ...(vp ? { viewport: { width: Number(vp[1]), height: Number(vp[2]) } } : {}),
  ...(process.env.KOALA_MOBILE === '1' ? { isMobile: true, hasTouch: true } : {}),
};

export default defineConfig({
  testDir: './tests',
  // 세트 폴더(데이터 폴더 안)의 테스트 코드도 '@support/…' 로 정리 도우미를 불러온다
  tsconfig: './tsconfig.json',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.KOALA_BASE_URL,
    ...screen,
    channel: 'chrome',
    trace: process.env.KOALA_TAB_RELAY ? 'off' : 'on', // 작업 탭 실행(중계)에서는 끈다: 화면 녹화 프레임이 확장을 거쳐 오가며 느려진다
    screenshot: 'on',
  },
  projects: [
    // 사이드패널에서 채택한 테스트로 만든 코드: <데이터 폴더>/sets/<세트>/tests/code/*.spec.ts. 같은 계정을 쓰므로 순차 실행
    { name: 'suites', testDir: dataDir, testMatch: /sets[\\/][^\\/]+[\\/]tests[\\/]code[\\/].*\.spec\.ts/, fullyParallel: false },
    // tests/ 아래 직접 둔 테스트
    { name: 'local', testIgnore: /suites\//, fullyParallel: false },
  ],
});
