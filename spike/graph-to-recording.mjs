// 스파이크(버림용): 그래프에 저장된 경로를 이어 붙여 generate.mjs 입력(기록)으로 만든다
//   node graph-to-recording.mjs <시작 화면 key> <목적에 들어간 글자> <출력 파일>
import 'dotenv/config';
import fs from 'node:fs';
import * as graph from './graph.mjs';

const [start, intentHas, out] = process.argv.slice(2);
const edges = (await graph.allPaths()).filter((e) => e.intent?.includes(intentHas));
const base = `http://${start.split('/')[0]}`;
const rec = [{ action: 'goto', url: `${base}/${start.split('/').slice(1).join('/')}` }];
let cur = start;
const used = new Set();
for (;;) {
  const next = edges.find((e) => e.from === cur && !used.has(e.sig + e.to));
  if (!next) break;
  used.add(next.sig + next.to);
  for (const { tool, ...args } of next.steps) {
    rec.push({ action: tool.replace(/_(\w)/g, (_, c) => c.toUpperCase()), ...args });
  }
  if (next.to === cur) break; // 같은 화면 안의 마무리 검증
  cur = next.to;
}
fs.writeFileSync(out, JSON.stringify(rec, null, 2));
console.log(`${rec.length}단계 → ${out} (경로 ${used.size}개)`);
process.exit(0);
