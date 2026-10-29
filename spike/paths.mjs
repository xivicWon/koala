// 데이터 루트·포트를 정하는 한 곳. 시험은 KOALA_DATA_DIR·KOALA_PORT 로 임시 폴더·다른 포트를 쓴다
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const spike = fileURLToPath(new URL('.', import.meta.url));
const given = process.env.KOALA_DATA_DIR;
export const DATA = given ? path.resolve(given) : path.join(spike, '.koa'); // 끝에 / 없음
export const PORT = Number(process.env.KOALA_PORT) || 8765;
export const HOST_URL = `http://127.0.0.1:${PORT}`;
