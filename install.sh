#!/bin/sh
# koala 설치·재설치 (macOS / Linux)
#   curl -fsSL https://raw.githubusercontent.com/xivicWon/koala/main/install.sh | sh
#   옵션(환경변수): KOALA_HOME=설치 위치(기본 ~/koala)  KOALA_TAG=v0.2.0(기본 최신 릴리즈)  KOALA_GRAPH=1(경로 그래프 DB도 켬)
#   시험용: KOALA_REPO=받을 저장소  KOALA_GITHUB_API=릴리즈 API 주소  KOALA_NM_DIRS=Native Messaging 등록 폴더(줄바꿈으로 여러 개)  KOALA_LAUNCHER=실행기 경로
# 하는 일: 최신 GitHub 릴리즈 태그를 받고 → 의존성 설치 → .env 준비 → 사이드패널이 호스트를 자동으로 켜도록 등록
set -eu

GITHUB_REPO=xivicWon/koala
GITHUB_API=${KOALA_GITHUB_API:-https://api.github.com}
REPO=${KOALA_REPO:-https://github.com/$GITHUB_REPO.git}
DEST=${KOALA_HOME:-$HOME/koala}
NM_NAME=io.github.xivicwon.koala

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. 준비물 ──
command -v git >/dev/null || die "git이 필요합니다."
command -v node >/dev/null || die "Node.js 20 이상이 필요합니다. https://nodejs.org 에서 설치한 뒤 다시 실행하세요."
NODE=$(command -v node)
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || die "Node.js 20 이상이 필요합니다(지금 $("$NODE" -v))."
# 기본 설치 위치를 먼저 본다. PATH의 claude는 터미널 프로그램이 끼워 넣은 임시 경로일 수 있다
if [ -x "$HOME/.local/bin/claude" ]; then CLAUDE="$HOME/.local/bin/claude"; else CLAUDE=$(command -v claude || true); fi
if [ -z "$CLAUDE" ]; then
  warn "Claude Code를 찾지 못했습니다. 설치(https://claude.com/claude-code)하고 로그인해야 AI 기능이 동작합니다. 설치는 계속합니다."
elif ! "$CLAUDE" auth status >/dev/null 2>&1; then
  warn "Claude Code에 로그인되어 있지 않습니다. 설치 뒤 터미널에서 'claude auth login'을 실행하세요."
fi

# ── 2. 받을 릴리즈 ──
if [ -n "${KOALA_TAG:-}" ]; then
  TAG=$KOALA_TAG
else
  TAG=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$GITHUB_API/repos/$GITHUB_REPO/releases/latest" 2>/dev/null \
    | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).tag_name||"")}catch{}})') || true
  [ -n "$TAG" ] || die "GitHub에서 릴리즈를 찾지 못했습니다(https://github.com/$GITHUB_REPO/releases). 인터넷 연결을 확인하세요."
fi
say "koala $TAG 를 $DEST 에 설치합니다"

# ── 3. 코드 받기(태그 체크아웃) ──
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --quiet --tags origin
  [ -z "$(git -C "$DEST" status --porcelain --untracked-files=no)" ] || die "$DEST 에 고친 파일이 있습니다. 정리한 뒤 다시 실행하세요(git -C $DEST status)."
else
  [ -e "$DEST" ] && die "$DEST 가 이미 있지만 git 저장소가 아닙니다. 다른 위치를 KOALA_HOME 으로 지정하세요."
  git clone --quiet "$REPO" "$DEST"
fi
git -C "$DEST" -c advice.detachedHead=false checkout --quiet "$TAG"
APP="$DEST/spike"

# ── 4. 의존성·설정 ──
say "의존성을 설치합니다(npm ci)"
(cd "$APP" && npm ci --no-audit --no-fund --loglevel=error)
if [ ! -f "$APP/.env" ]; then
  cp "$APP/.env.example" "$APP/.env"
  # 사이드패널이 켜는 호스트는 터미널 PATH를 모르므로 Claude 위치를 적어 둔다
  [ -n "$CLAUDE" ] && printf '\nCLAUDE_BIN=%s\n' "$CLAUDE" >> "$APP/.env"
fi

# ── 5. 사이드패널이 호스트를 자동으로 켜도록(Chrome Native Messaging) ──
EXT_ID=$("$NODE" "$APP/scripts/extension-id.mjs")
LAUNCHER="${KOALA_LAUNCHER:-$HOME/.koala/koala-native}"
mkdir -p "$(dirname "$LAUNCHER")"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$NODE" "$APP/native-launcher.mjs" "\$@"
EOF
chmod +x "$LAUNCHER"
case "$(uname -s)" in
  Darwin) NM_DIRS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts
$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
  *) NM_DIRS="$HOME/.config/google-chrome/NativeMessagingHosts
$HOME/.config/chromium/NativeMessagingHosts
$HOME/.config/microsoft-edge/NativeMessagingHosts" ;;
esac
[ -n "${KOALA_NM_DIRS:-}" ] && NM_DIRS=$KOALA_NM_DIRS
echo "$NM_DIRS" | while IFS= read -r d; do
  [ -d "$(dirname "$d")" ] || continue # 그 브라우저가 없으면 건너뜀
  mkdir -p "$d"
  cat > "$d/$NM_NAME.json" <<EOF
{
  "name": "$NM_NAME",
  "description": "koala 호스트 실행기",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
done

# ── 6. (선택) 경로 그래프 DB ──
if [ "${KOALA_GRAPH:-}" = 1 ]; then
  if command -v docker >/dev/null; then (cd "$APP" && docker compose up -d) || warn "경로 그래프 DB를 켜지 못했습니다(선택 기능)."
  else warn "Docker가 없어 경로 그래프 DB는 건너뜁니다(선택 기능)."; fi
fi

say "설치를 마쳤습니다 · koala $TAG"
cat <<EOF

남은 일(처음 한 번):
  1. Chrome 주소창에 chrome://extensions → 오른쪽 위 '개발자 모드' 켜기
  2. '압축해제된 확장 프로그램 로드' → 이 폴더 선택:
       $APP/extension
  3. 툴바의 퍼즐 아이콘 → koala 고정 → 아이콘을 누르면 사이드패널이 열리고 호스트가 자동으로 켜집니다.

업데이트는 사이드패널 위쪽에 '새 버전'이 뜨면 누르면 됩니다.
EOF
