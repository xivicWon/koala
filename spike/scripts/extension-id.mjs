// manifest.json 의 key 로 확장 id 를 계산한다(설치 스크립트가 Native Messaging 허용 목록에 쓴다)
//   node scripts/extension-id.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';

const m = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url)));
const der = Buffer.from(m.key, 'base64');
const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
console.log([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(''));
