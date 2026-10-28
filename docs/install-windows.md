# Windows 설치 가이드

> Windows용 한 줄 설치 스크립트는 아직 없습니다. 아래 순서대로 직접 설치합니다.
> 이 문서의 명령은 PowerShell 기준입니다. Windows에서 아직 직접 검증하지 못했으니, 막히는 곳이 있으면 이슈로 알려 주세요.

## 1. 준비물

| 항목 | 설치 방법 | 확인 |
|---|---|---|
| Git for Windows | https://git-scm.com/download/win | `git --version` |
| Node.js 20 이상 (LTS) | https://nodejs.org | `node -v` |
| Chrome (또는 Edge) | | |
| Claude Code | PowerShell에서 `irm https://claude.ai/install.ps1 \| iex` | `claude --version` |

Claude Code는 **각자 설치하고 각자 계정으로 로그인**합니다. 사용량도 각자 계정에서 나갑니다.

```powershell
claude auth login     # 브라우저가 열리면 로그인
claude auth status    # loggedIn: true 인지 확인
```

## 2. 코드 받기 (릴리즈 태그)

```powershell
cd $HOME
git clone https://github.com/xivicWon/koala.git
cd koala
# 최신 릴리즈 태그로 바꾼다(업데이트 버튼이 동작하려면 태그 상태여야 한다)
$tag = (Invoke-RestMethod https://api.github.com/repos/xivicWon/koala/releases/latest).tag_name
git -c advice.detachedHead=false checkout $tag
```

## 3. 의존성과 설정

```powershell
cd $HOME\koala\spike
npm ci
copy .env.example .env
```

`claude`를 찾지 못한다는 경고가 나오면 `.env` 끝에 실행 파일 위치를 적습니다. 위치는 `where.exe claude`로 확인합니다.

```
CLAUDE_BIN=C:\Users\<사용자>\.local\bin\claude.exe
```

## 4. 확장 불러오기

1. Chrome 주소창에 `chrome://extensions` → 오른쪽 위 **개발자 모드** 켜기
2. **압축해제된 확장 프로그램 로드** → `C:\Users\<사용자>\koala\spike\extension` 선택
3. 툴바의 퍼즐 아이콘 → koala 고정 → 아이콘을 누르면 사이드패널이 열립니다.

## 5. 호스트 켜기

사이드패널은 로컬 호스트(`127.0.0.1:8765`)와 연결해 동작합니다. 둘 중 하나를 고릅니다.

### 방법 A: 직접 켜기 (가장 간단)

```powershell
cd $HOME\koala\spike
npm start
```

쓰는 동안 이 창을 열어 둡니다. 사이드패널 상단의 빨간 경고가 사라지면 연결된 것입니다.

### 방법 B: 사이드패널이 자동으로 켜게 하기 (Native Messaging 등록)

사이드패널을 열 때 호스트가 꺼져 있으면 자동으로 켭니다. PowerShell에서 한 번 실행합니다.

```powershell
$app  = "$HOME\koala\spike"
$node = (Get-Command node).Source
$name = 'io.github.xivicwon.koala'
$extId = node "$app\scripts\extension-id.mjs"
$dir  = "$HOME\.koala"
New-Item -ItemType Directory -Force $dir | Out-Null

# 1) 실행기: Chrome이 부르는 배치 파일
"@echo off`r`n`"$node`" `"$app\native-launcher.mjs`" %*" | Set-Content -Encoding ascii "$dir\koala-native.cmd"

# 2) Native Messaging 등록 정보
@{
  name = $name
  description = 'koala 호스트 실행기'
  path = "$dir\koala-native.cmd"
  type = 'stdio'
  allowed_origins = @("chrome-extension://$extId/")
} | ConvertTo-Json | Set-Content -Encoding utf8 "$dir\$name.json"

# 3) 레지스트리에 등록(현재 사용자만). Edge도 쓰면 두 번째 줄도 실행
New-Item -Force "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$name" -Value "$dir\$name.json" | Out-Null
New-Item -Force "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$name" -Value "$dir\$name.json" | Out-Null
```

Chrome을 완전히 껐다 켠 뒤 사이드패널을 열면 호스트가 켜집니다. 호스트 기록은 `%USERPROFILE%\.koala\host.log`에 남습니다.

등록을 지우려면:

```powershell
Remove-Item "HKCU:\Software\Google\Chrome\NativeMessagingHosts\io.github.xivicwon.koala"
Remove-Item "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\io.github.xivicwon.koala" -ErrorAction SilentlyContinue
```

## 6. 처음 설정

1. 사이드패널 상단의 **프로필 칩**에서 대상 서비스 프로필을 고릅니다. 처음에는 예시 프로필만 있습니다.
   - 대상 서비스의 프로필은 `spike\.koa\store\profiles\<id>.yaml`에 둡니다. 형식은 `spike\store\profiles\example.yaml`을 참고합니다.
2. 프로필 시트의 **역할과 계정**에서 역할별 테스트 계정을 입력합니다. 이 값은 내 확장에만 저장됩니다.

## 업데이트

- 새 릴리즈가 나오면 사이드패널 이름 옆에 **업데이트 vX.Y.Z**가 뜹니다. 누르면 호스트가 새 태그로 바뀌고 다시 켜집니다. 이어서 확장도 새로고침됩니다.
- 방법 A(직접 켜기)를 쓰면 호스트가 다시 켜질 때 창이 닫힐 수 있습니다. 그때는 `npm start`를 다시 실행합니다.

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| "호스트가 실행 중이 아닙니다" | 방법 A: `npm start` 창이 열려 있는지. 방법 B: 레지스트리 경로와 `%USERPROFILE%\.koala\koala-native.cmd`가 있는지, Chrome을 완전히 다시 켰는지 |
| "Claude Code를 찾을 수 없습니다" | `where.exe claude`로 위치를 찾아 `.env`의 `CLAUDE_BIN`에 적기 |
| "로그인되어 있지 않습니다" | `claude auth login` |
| `npm ci` 실패 | Node.js 버전(20 이상), 회사 프록시 설정(`npm config set proxy …`) |
| 스크립트 실행이 막힘 | PowerShell 실행 정책: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| 이름 옆에 "호스트 불일치" | 다른 폴더의 호스트가 켜져 있습니다. 그 창을 닫거나 작업 관리자에서 `node`(host.mjs)를 끝냅니다 |
