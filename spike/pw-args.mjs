// playwright 를 띄울 때의 인자. 파일 인자는 ASCII 꼬리 정규식이라 따옴표가 필요 없다.
// shell 을 거치는 Windows 에서 나머지 인자(--grep 등)는 공백·특수문자가 있으면 따옴표로 감싼다(cmd 의 %변수%는 따옴표 안에서도 풀리므로 id·태그에 % 를 쓰지 않는다는 전제)
import path from 'node:path';

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

const SEP = '[\\\\/]'; // 정규식에서 / 와 \\ 둘 다
const esc = (t) => t.replace(REGEX_SPECIAL, '\\$&');

// Playwright 는 파일 인자를 정규식으로 쓰고, Windows 에서는 역슬래시 경로·퍼센트 인코딩된 file URL 에 건다.
// 그래서 데이터 폴더 앞부분(공백·한글이 들어갈 수 있다)은 빼고 ASCII 뿐인 꼬리 sets/<id>/tests/code/<이름>.spec.ts 만 구분자 무관 정규식으로 준다
// (왼쪽을 구분자로 막아 'mysets/…' 에, id 와 이름을 통째로 써서 다른 세트 파일에는 걸리지 않는다)
// 이 모양이 아니면 spike 안은 상대 경로, 밖은 절대 경로로 준다
export function specArg(file, cwd) {
  const tail = String(file).split(/[\\/]/).slice(-5);
  if (tail.length === 5 && tail[0] === 'sets' && tail[2] === 'tests' && tail[3] === 'code' && /^[\w.-]+$/.test(tail[1]) && /^[\w.-]+\.spec\.ts$/.test(tail[4])) {
    return `${SEP}${tail.map(esc).join(SEP)}$`;
  }
  const rel = path.relative(cwd, file);
  const use = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
  return use.split(/[\\/]/).map(esc).join(SEP);
}

// shell 을 거칠 때(Windows) 한 인자를 안전하게 감싼다
export function shellQuote(arg) {
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  return `"${String(arg).replace(/"/g, '""')}"`;
}

export function playwrightArgs(file, { cwd, list = false, grep = null, headed = false, win = false } = {}) {
  const args = ['playwright', 'test', specArg(file, cwd), '--project=suites', '--workers=1',
    ...(grep ? ['--grep', grep] : []),
    ...(list ? ['--list', '--reporter=json'] : ['--reporter=json,./pw-progress-reporter.cjs', ...(headed ? ['--headed'] : [])])];
  return win ? args.map(shellQuote) : args;
}
