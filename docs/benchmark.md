# 벤치마킹 (2026-10-27)

자료 대부분이 업체 자체 비교 페이지나 2차 요약이라 수치·주장은 참고용이다.

## 1. 비교 대상 — 네 갈래

| 갈래 | 대표 | 형태 | koala와의 관련 |
|---|---|---|---|
| A. 브라우저 확장형 AI 에이전트 | Nanobrowser(오픈소스), Claude in Chrome, Codex for Chrome | 사이드패널 채팅 → AI가 현재 탭을 조작 | **형태가 가장 가까움**. 다만 범용 자동화용이고 QA 전용은 아님 |
| B. 확장형 QA 소형 도구 | QAgentExt, Exploratory Testing Agent, QA.AI, QA Vision AI | 확장에서 자연어 명령 실행, PASS/FAIL 기록, 크롤링 | 아이디어는 koala와 같음. 사용자 수가 거의 없어 검증된 사례는 아님 |
| C. AI QA SaaS | Momentic, Octomind, mabl, QA Wolf, testRigor | 클라우드에서 자연어 테스트 작성·실행, CI 연동 | QA 기능의 기준점. 확장 형태는 아님 |
| D. 개발자용 에이전트 프레임워크 | browser-use, Stagehand, Playwright MCP | 코드·CLI·MCP로 브라우저 제어 | 내부 동작 방식 참고용 |
| (보조) 버그 리포트 확장 | Jam.dev | 클릭 한 번으로 화면 녹화, 콘솔·네트워크 로그, 재현 단계 수집 → Jira 등으로 전송 | **QA 결과물의 품질 기준** |

## 2. 기능별 관찰

| 기능 | 어디서 봤나 | 메모 |
|---|---|---|
| 자연어 지시 → AI가 클릭·입력 | A, B, C 전부 | 핵심 |
| 사이드패널 채팅 + 실시간 진행 상태 | Nanobrowser | 확장형 UX의 표준 |
| Planner / Navigator 다중 에이전트 | Nanobrowser | 막혔을 때 스스로 방향을 고침 |
| 모델 선택, 본인 API 키 사용, 로컬 모델(Ollama) | Nanobrowser, QA Vision AI | 비용·보안 관련 |
| PASS/FAIL 판정 + 실행 로그 | Exploratory Testing Agent, C 전부 | QA 도구라면 필수 |
| 테스트 케이스 저장·재실행(회귀) | C 전부 | 같은 테스트를 반복해서 돌리는 기능 |
| 셀렉터 자동 복구(self-healing) | QAgentExt, mabl, Stagehand | UI가 바뀌어도 테스트가 덜 깨짐 |
| Playwright 코드로 내보내기 | Octomind, Exploratory Testing Agent, QA Wolf | 결정적인 CI 회귀 테스트로 옮겨 감 |
| URL만으로 탐색 → 테스트 자동 생성 | Octomind, QA.AI(30페이지 크롤링) | 탐색형 QA |
| 화면 녹화, 콘솔·네트워크 로그, 스크린샷 | Jam | 버그 재현 근거 |
| Jira, Slack 등으로 이슈 전송 | Jam, QA.AI | 결과를 팀 흐름에 연결 |
| 접근성 점검, 시각 회귀 | QAgentExt, mabl | 부가 기능 |
| 동작마다 권한 확인 | Codex for Chrome | 안전장치 |
| CI 연동, 대시보드, 팀 관리 | C | 플랫폼급 기능 |

## 3. 업계 공통 결론

- AI 에이전트의 과업 성공률은 약 75~78%, 사람이 작성한 Playwright 스크립트는 약 98%(WebVoyager 기준, 방법론 미검증).
- 그래서 **탐색·작성은 AI, 반복 회귀는 결정적 스크립트**로 나누는 구성이 일반적이다.

## 4. 1차 분류 (Claude의 추정, 사용자 확인 전)

전제: 자회사 웹서비스, 일반 QA, 목업 데이터 환경, 확장 형태.

**꼭 필요해 보이는 것**
- 자연어 시나리오 → AI가 현재 탭에서 실행
- 단계별 PASS/FAIL 판정과 실패 이유
- 실패 시 증거 수집: 스크린샷, 콘솔 에러, 네트워크 에러
- 진행 상황이 보이는 사이드패널

**나중에 검토할 것**
- 시나리오 저장·재실행
- 버그 리포트 내보내기(Jira 등)
- Playwright 코드 내보내기
- 탐색형 자동 테스트

**과해 보이는 것 (초기 기준)**
- 다중 에이전트 구조, 여러 LLM 공급자 지원
- 셀렉터 자동 복구 엔진
- CI 연동, 대시보드, 팀 관리
- 시각 회귀, 접근성 감사
- 클라우드 실행 인프라

## 출처

- [Nanobrowser 요약](https://jimmysong.io/ai/nanobrowser), [DEV 소개글](https://dev.to/githubopensource/nanobrowser-your-free-ai-powered-web-automation-assistant-45j0)
- [QAgentExt](https://extensionauditor.com/scan/qagentext-qa-testing-agent-fmabdhbonhmnomjogiehbhadalondhch), [QA Vision AI](https://extensionauditor.com/scan/qa-vision-ai-joidknhkgaldcdfbenhdedjkcmghiecg), [Exploratory Testing Agent](https://chromewebstore.google.com/detail/fjepfiofhphhfglmmllnnchenacbjmbi), [QA.AI](https://chromewebstore.google.com/detail/nploledajpehijlpoomkdglbekljfldg), [Codex for Chrome](https://www.eigent.ai/pl/blog/codex-for-chrome)
- [AI QA 도구 비교(fast.io)](https://fast.io/resources/best-ai-qa-testing-tools/), [Momentic vs Octomind](https://www.testsprite.com/use-cases/en/compare/momentic-vs-octomind), [Momentic vs mabl](https://www.testsprite.com/use-cases/en/compare/momentic-vs-mabl), [Momentic 대안](https://bug0.com/knowledge-base/momentic-alternatives)
- [Stagehand vs Browser Use vs Playwright](https://www.nxcode.io/it/resources/news/stagehand-vs-browser-use-vs-playwright-ai-browser-automation-2026), [Playwright CLI vs MCP](https://bug0.com/blog/playwright-cli-vs-playwright-mcp-ai-browser-testing-2026)
- [Jam](https://jam.dev/), [Jam Chrome 웹스토어](https://chrome.google.com/webstore/detail/jam/iohjgamcilhbgmhbnllfolmkmmekfmci)
