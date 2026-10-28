// 호스트 접속 토큰: 같은 PC의 koala 프로세스(MCP 서버·자동 점검)가 호스트 HTTP를 부를 때 낸다.
// 웹 페이지는 이 파일을 읽을 수 없으므로, 브라우저에서 온 요청은 토큰 대신 확장 출처(Origin)로만 받는다
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.koa', 'host-token');
export const HEADER = 'x-koala-token';

export function hostToken() {
  try {
    const t = fs.readFileSync(FILE, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch { /* 처음 */ }
  const t = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, t, { mode: 0o600 });
  return t;
}
