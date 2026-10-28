// playwright 를 띄울 때의 인자. 시험 파일 경로는 spike 폴더 기준 상대 경로(안쪽일 때)로, 아니면 절대 경로로 준다.
// Playwright 는 파일 인자를 정규식으로 쓰므로 특수문자를 막고, Windows(shell) 에서는 공백·특수문자 인자를 따옴표로 감싼다
import path from 'node:path';

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

export function specArg(file, cwd) {
  const rel = path.relative(cwd, file);
  const use = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
  return use.split(path.sep).join('/').replace(REGEX_SPECIAL, '\\$&');
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
