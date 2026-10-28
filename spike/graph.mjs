// 스파이크(버림용): 지나간 경로를 Apache AGE 그래프에 저장하고 꺼낸다
//   (:Screen {key, url, title})-[:PATH {sig, intent, steps, runs, fails, last_ok}]->(:Screen)
import pg from 'pg';
import crypto from 'node:crypto';

const GRAPH = 'koala';
// 기본값은 docker-compose.yml 의 koala-graph 컨테이너
const pool = new pg.Pool({ connectionString: process.env.KOALA_PG || 'postgres://koala:koala@127.0.0.1:5532/koala', max: 3 });

// 연결마다 AGE를 한 번 올리고 search_path를 맞춘다
async function client() {
  const c = await pool.connect();
  if (!c.ageReady) {
    await c.query(`LOAD 'age'`);
    await c.query(`SET search_path = ag_catalog, "$user", public`);
    c.ageReady = true;
  }
  return c;
}

// agtype 문자열("...::vertex" 등)을 JS 값으로
const parse = (v) => (v == null ? null : JSON.parse(String(v).replace(/::(vertex|edge|path)\b/g, '')));

async function cypher(query, params = {}, cols = ['v']) {
  const sql = `SELECT * FROM cypher('${GRAPH}', $$ ${query} $$, $1) AS (${cols.map((c) => `${c} agtype`).join(', ')})`;
  const c = await client();
  try {
    var { rows } = await c.query(sql, [JSON.stringify(params)]);
  } finally { c.release(); }
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c, parse(r[c])])));
}

// 화면 식별자: 호스트 + 경로. 숫자·UUID 같은 id 조각은 :id 로 묶는다
export function screenKey(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.split('/').map((s) => (/^\d+$|^[0-9a-f-]{16,}$/i.test(s) ? ':id' : s)).join('/');
    return `${u.host}${path}`;
  } catch { return String(url); }
}

// 같은 화면 이동이라도 조작이 다르면 다른 경로로 본다(검증 단계는 빼고 서명)
export function pathSig(steps) {
  const acts = steps.filter((s) => !s.tool.startsWith('expect')).map((s) => [s.tool, s.locator, s.key, s.option]);
  return crypto.createHash('sha1').update(JSON.stringify(acts)).digest('hex').slice(0, 12);
}

export async function upsertScreen(key, url, title = '') {
  await cypher(`MERGE (s:Screen {key: $key}) SET s.url = $url, s.title = $title RETURN s`, { key, url, title });
}

export async function recordPath(from, to, steps, intent) {
  const sig = pathSig(steps);
  // AGE 1.5는 MERGE 직후 SET에서 기존 속성을 못 읽어서, 횟수는 읽고 나서 따로 쓴다
  const [row] = await cypher(
    `MATCH (a:Screen {key: $from}), (b:Screen {key: $to}) MERGE (a)-[p:PATH {sig: $sig}]->(b) RETURN [p.runs, p.fails]`,
    { from, to, sig },
  );
  const [runs, fails] = row?.v || [];
  await cypher(
    `MATCH (:Screen {key: $from})-[p:PATH {sig: $sig}]->(:Screen {key: $to})
     SET p.steps = $steps, p.intent = $intent, p.last_ok = $now, p.runs = $runs, p.fails = $fails RETURN p.runs`,
    { from, to, sig, steps: JSON.stringify(steps), intent, now: new Date().toISOString(), runs: (runs || 0) + 1, fails: fails || 0 },
  );
  return { sig, runs: (runs || 0) + 1 };
}

export async function markFailed(from, to, sig) {
  const [row] = await cypher(
    `MATCH (:Screen {key: $from})-[p:PATH {sig: $sig}]->(:Screen {key: $to}) RETURN p.fails`, { from, to, sig });
  await cypher(
    `MATCH (:Screen {key: $from})-[p:PATH {sig: $sig}]->(:Screen {key: $to}) SET p.fails = $n RETURN p`,
    { from, to, sig, n: (row?.v || 0) + 1 });
}

// 시작 화면에서 갈 수 있는 경로들(최대 6단계)을 AI에게 줄 형태로
export async function knownPathsFrom(start, maxHops = 4, limit = 60) {
  // AGE 1.5는 목록 내포를 지원하지 않아 노드·엣지를 받아 JS에서 엮는다.
  // 화면 사이에 순환이 있으면 가변 길이 경로가 폭발하므로(7천 개 이상 관측) 길이와 개수에 상한을 둔다
  const rows = await cypher(
    `MATCH p = (a:Screen {key: $start})-[:PATH*1..${maxHops}]->(b:Screen) RETURN nodes(p), relationships(p) LIMIT ${limit}`,
    { start }, ['ns', 'es'],
  );
  return rows.map(({ ns, es }) => {
    const keyOf = Object.fromEntries(ns.map((n) => [n.id, n.properties.key]));
    return es.map((e) => ({
      from: keyOf[e.start_id], to: keyOf[e.end_id], sig: e.properties.sig, intent: e.properties.intent,
      runs: e.properties.runs, fails: e.properties.fails, steps: JSON.parse(e.properties.steps || '[]'),
    }));
  });
}

export async function allPaths() {
  const rows = await cypher(
    `MATCH (a:Screen)-[p:PATH]->(b:Screen) RETURN {from: a.key, to: b.key, sig: p.sig, intent: p.intent, steps: p.steps, runs: p.runs, fails: p.fails}`,
  );
  return rows.map((r) => ({ ...r.v, steps: JSON.parse(r.v.steps) }));
}
