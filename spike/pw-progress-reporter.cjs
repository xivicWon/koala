// 로컬 실행 진행 상황을 한 줄씩 내보내는 Playwright 리포터. 호스트가 읽어 사이드패널에 바로 보여 준다
const out = (ev) => process.stdout.write(`KOA ${JSON.stringify(ev)}\n`);
const GWT = /^(Given|When|Then|And|But)\b/;

class ProgressReporter {
  onBegin(config, suite) { out({ ev: 'begin', total: suite.allTests().length }); }
  onTestBegin(test) { out({ ev: 'test', title: test.title }); }
  onStepEnd(test, result, step) {
    if (step.category === 'test.step' && GWT.test(step.title)) out({ ev: 'step', test: test.title, title: step.title, status: step.error ? 'failed' : 'passed' });
  }
  onTestEnd(test, result) {
    out({ ev: 'done', title: test.title, status: result.status === 'timedOut' || result.status === 'interrupted' ? 'failed' : result.status, ms: result.duration });
  }
  printsToStdio() { return false; }
}
module.exports = ProgressReporter;
