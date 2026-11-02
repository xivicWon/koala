// 데이터 루트·포트를 정하는 한 곳. 시험은 KOALA_DATA_DIR·KOALA_PORT 로 임시 폴더·다른 포트를 쓴다
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const spike = fileURLToPath(new URL('.', import.meta.url));
const given = process.env.KOALA_DATA_DIR;
export const DATA = given ? path.resolve(given) : path.join(spike, '.koa'); // 끝에 / 없음
// 프로필 폴더들(~/koala-profiles/<이름>/)과 사용자 레벨(~/.koala/). 데이터 폴더를 따로 준 시험 실행이면 그 안에 둔다(실제 폴더를 건드리지 않게)
const home = process.env.HOME || process.env.USERPROFILE || '';
export const PROFILES = process.env.KOALA_PROFILES ? path.resolve(process.env.KOALA_PROFILES) : given ? path.join(DATA, 'profiles') : path.join(home, 'koala-profiles');
export const USER_DIR = process.env.KOALA_USER_DIR ? path.resolve(process.env.KOALA_USER_DIR) : given ? path.join(DATA, 'user') : path.join(home, '.koala');
export const SPIKE = spike;
export const PORT = Number(process.env.KOALA_PORT) || 8765;
export const HOST_URL = `http://127.0.0.1:${PORT}`;
