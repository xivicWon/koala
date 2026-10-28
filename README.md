# koala (koa)

브라우저 확장 사이드패널에서 자연어로 지시하면, 각자 PC의 Claude Code가 브라우저를 직접 조작하며 QA합니다.
확인한 내용은 Playwright 테스트 코드로 남겨 CI에서 반복 실행합니다.

- **등록**: AI와 사람이 화면에서 확인하며 만든다
- **동작**: 만들어진 Playwright 코드대로 반복 실행한다

> 지금은 시험판(`spike/`) 단계입니다. 확장은 개발자 모드로 설치해 씁니다.

## 구성

```
Chrome 확장(사이드패널) ⇄ 로컬 호스트(node) ⇄ Claude Code(각자 PC, 각자 계정)
                              ├─ 동기화 저장소(store/: 공용 예시, .koa/store/: 이 PC의 문서)
                              ├─ 작업 폴더(workspaces/: Claude가 읽는 지식 사본)
                              └─ 경로 그래프(PostgreSQL + Apache AGE, 선택)
```

| 폴더·파일 | 역할 |
|---|---|
| `spike/extension/` | Chrome 확장(사이드패널, 화면 조작, 네트워크·콘솔 수집) |
| `spike/host.mjs` | 확장과 Claude Code를 잇는 로컬 호스트 |
| `spike/mcp-server.mjs` | Claude가 쓰는 브라우저 도구(click, type, expect_* 등) |
| `spike/store/` | 동기화 저장소의 공용 예시(나중에 백엔드로 바뀜): 공통 지식, 태그, 예시 프로필·역할 |
| `spike/.koa/store/` | 이 PC의 동기화 문서: 대상 서비스 프로필·지식, 보낸 테스트 묶음(git 제외) |
| `spike/generate.mjs` | 기록 → Playwright 테스트 코드 |
| `spike/tests/` | 생성된 테스트와 정리 도구(git 제외) |
| `docs/` | 목표·결정 기록, 벤치마킹 |

## 준비물

| 항목 | 필수 | 비고 |
|---|---|---|
| Chrome | 필수 | 확장을 개발자 모드로 설치 |
| Node.js 20 이상 | 필수 | |
| Claude Code | 필수 | **각자 설치하고 각자 계정으로 로그인**합니다. AI 사용량도 각자 계정에서 나갑니다 |
| 대상 서버 접근 | 필수 | 테스트할 웹 서비스에 이 PC의 브라우저로 접속할 수 있어야 합니다 |
| Docker | 선택 | 경로 그래프(지나간 경로를 기억해 빠르게 재생). 없으면 재생 없이 동작 |

## 설치

### 한 줄 설치 (macOS·Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/xivicWon/koala/main/install.sh | sh
```

- 최신 GitHub 릴리즈(태그)를 `~/koala`에 받아 의존성을 설치하고, `.env`를 만듭니다.
- 사이드패널을 열면 호스트가 자동으로 켜지게 등록합니다(Chrome Native Messaging). 터미널을 열어 둘 필요가 없습니다.
- 옵션: `KOALA_HOME=다른/위치`, `KOALA_TAG=v0.2.0`(특정 버전), `KOALA_GRAPH=1`(경로 그래프 DB도 Docker로 켬)
- Windows는 준비 중입니다. 지금은 아래 "직접 설치"를 따릅니다.

설치가 끝나면 처음 한 번만:
1. `chrome://extensions` → 오른쪽 위 **개발자 모드** 켜기 → **압축해제된 확장 프로그램 로드** → `~/koala/spike/extension`
2. 툴바의 퍼즐 아이콘 → koala 고정 → 아이콘을 누르면 사이드패널이 열립니다.
3. 사이드패널 상단의 **프로필 칩**에서 대상 서비스 프로필을 고르고, 역할별 테스트 계정(아이디·비밀번호)을 입력합니다. 이 값은 내 확장에만 저장되고 공유되지 않습니다.
   - 처음에는 예시 프로필(`store/profiles/example.yaml`)만 있습니다. 대상 서비스의 프로필은 `spike/.koa/store/profiles/`에 같은 형식으로 둡니다.
4. Claude Code에 로그인되어 있지 않으면 터미널에서 `claude auth login`

### 직접 설치 (개발용)

1. 저장소를 받고 의존성을 설치합니다.
   ```bash
   git clone https://github.com/xivicWon/koala.git && cd koala/spike
   npm install
   cp .env.example .env   # Windows: copy .env.example .env
   ```
2. (선택) 경로 그래프 DB: `npm run graph:up`
3. 호스트를 켭니다: `npm start` (쓰는 동안 터미널을 열어 둡니다)
4. 확장을 불러옵니다(위 1~3과 같음, 폴더는 `koala/spike/extension`).

사이드패널 상단에 빨간 경고가 보이면 안내대로 해결합니다(호스트 꺼짐, Claude Code 없음, 로그인 안 됨).

## 사용

1. 대상 사이트를 탭에 열고 사이드패널에 확인할 흐름을 적습니다. 예: `로그인하고 회원가입 화면의 입력란이 잘 보이는지 확인해줘`
2. AI가 화면을 조작합니다. 단계 카드, 문제가 있는 요청(오류·느림), 콘솔 오류가 타임라인에 나옵니다.
   - **요청** 버튼: 요청 상세(헤더·본문·쿠키·세션). 영역을 체크해 YAML/JSON으로 복사
   - 처음 가는 경로는 **탐색**(느리게), 지나간 경로는 **재생**(빠르게)으로 진행
3. **이 수행으로 테스트 생성** → **테스트 목록**에서 채택하고 반영한 뒤 **코드 생성**으로 Playwright 테스트 코드를 만듭니다. 로컬에서 바로 실행해 확인하고 서버로 보냅니다.
4. 데이터를 만드는 테스트는 이름 앞에 `[koa]`가 붙고, 프로필의 정리 규칙(`cleanup`)대로 끝나면 정리합니다.

## 프로필과 지식 문서

- **프로필**(`profiles/*.yaml`): 대상 주소, 역할 문서, 사이트 운영 팁, 정리 규칙, 연결된 지식 문서
- **역할 문서**(`roles/*.yaml`): 역할(관리자·일반 사용자 등)과 역할별 기본 계정. 기본 계정 값은 git 밖 `spike/.koa/server-accounts/<id>.yaml`에 둡니다
- **지식 문서**(`knowledges/*.yaml`): 공통 QA 원칙, 서비스 목적·주요 기능·중점 QA 방향
- 문서는 `spike/.koa/store/`(이 PC, git 제외)를 먼저 보고, 없으면 `spike/store/`(공용 예시)를 씁니다. 사이드패널에서 올린 변경은 `.koa/store/`에 저장됩니다. 대상 서비스 정보가 공개 저장소에 들어가지 않게 하기 위해서입니다.
- 확장은 새 버전을 자동으로 받습니다. 프로필은 사이드패널에서 고쳐 **변경 올리기**로 새 버전을 게시합니다.
- 지식 문서는 지금은 YAML 파일을 고치고 `version`을 올려 게시합니다.
- 사이드패널의 **Claude** 버튼에서 작업 폴더, 버전, 실제로 AI에게 전달되는 내용을 볼 수 있습니다.

## 데이터는 어디에 남나

| 데이터 | 위치 | git |
|---|---|---|
| 프로필 사본, 개인 계정 값, 복사 형식 | Chrome 프로필 폴더의 확장 저장소(확장 삭제 시 함께 삭제) | - |
| 타임라인, 요청 상세 | 사이드패널 메모리(패널을 닫으면 사라짐) | - |
| 기록·보관본 | `spike/recording.json`, `spike/recordings/` | 제외 |
| 작업 폴더(지식 사본) | `spike/workspaces/` | 제외 |
| 경로 그래프 | Docker 볼륨 `koala-graph` | - |
| 계정(기본값) | `spike/.env`, `spike/.koa/server-accounts/` | 제외 |
| 대상 서비스 프로필·지식, 보낸 테스트 묶음 | `spike/.koa/store/` | 제외 |
| 생성된 테스트 코드 | `spike/tests/` | 제외 |
| AI 대화 기록 | `~/.claude/projects/…/workspaces-<프로필>` | - |

## 보안 주의

- 계정 비밀번호는 지금 **평문**으로 확장 저장소와 `.env`에 있습니다(OS 키체인 적용은 보류).
- AI와 생성 코드에는 `$KOALA_PASS` 같은 **이름만** 전달되고, 실제 값은 호스트가 채웁니다.
- 요청 상세의 비밀번호·토큰은 가려지지만, **세션 쿠키는 그대로 보입니다.** 복사한 내용을 공유할 때 주의하세요.
- 호스트는 `127.0.0.1`에서만 열리고, koala 확장 출처(Origin)와 이 PC의 koala 프로세스(`spike/.koa/host-token`)의 요청만 받습니다. 다른 웹 페이지는 호스트에 접속할 수 없습니다.
- AI가 계정 값을 입력하는 것은 프로필의 대상 서버 화면에서만 허용됩니다.

## 문제 해결

| 증상 | 해결 |
|---|---|
| "호스트가 실행 중이 아닙니다" | `spike`에서 `npm start` |
| "호스트를 켜지 못했습니다" | `~/.koala/host.log` 확인. 설치 스크립트를 다시 실행하면 자동 실행 등록이 새로 됩니다 |
| "Claude Code를 찾을 수 없습니다" | Claude Code 설치. 다른 위치면 `.env`에 `CLAUDE_BIN` 지정 |
| "로그인되어 있지 않습니다" | `claude auth login` |
| 조작이 "요소 없음"으로 실패 | 대상 사이트 탭이 열려 있고 활성인지 확인 |
| 생성 테스트가 동시에 돌리면 실패 | 같은 계정 동시 로그인 제한일 수 있음. `--workers=1` 또는 로그인 공유(setup) |
| "그래프 DB에 연결할 수 없어…" | 선택 기능입니다. 쓰려면 `npm run graph:up` |
| 확장을 고쳤는데 반영 안 됨 | `chrome://extensions`에서 koala 새로고침, 호스트 재시작 |

## 업데이트

- 새 릴리즈가 나오면 사이드패널 위쪽에 **새 버전 vX.Y.Z**가 뜹니다. **변경 내용**을 보고 **업데이트**를 누르면 호스트가 새 버전으로 바뀌고 다시 켜집니다. 이어서 **확장 새로고침**을 누릅니다.
- 직접 설치(개발용)는 자동 업데이트 대상이 아닙니다. `git pull` 뒤 확장을 새로고침하고 호스트를 다시 켭니다.
- 릴리즈를 만드는 방법은 [RELEASING.md](RELEASING.md)에 있습니다.
