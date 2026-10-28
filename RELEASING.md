# 릴리즈 절차

사용자는 **GitHub 릴리즈(태그)** 만 받는다. `main`에서 개발 중인 변경은 릴리즈를 만들기 전까지 사용자에게 가지 않는다.

## 1. 버전 올리기 (`main`)

1. `spike/package.json`과 `spike/extension/manifest.json`의 `version`을 같은 값으로 올린다. 예: `0.2.1`
   - 둘이 다르면 사이드패널이 "확장도 새 버전으로 바꿔야 합니다"를 계속 띄운다.
2. `CHANGELOG.md` 맨 위에 그 버전의 변경 내용을 적는다.
3. 커밋하고 `main`에 push한다.

## 2. 릴리즈 만들기 (GitHub)

```bash
gh release create v0.2.1 --target main --title v0.2.1 --notes-file <(awk '/^## 0.2.1/{f=1;next} /^## /{f=0} f' CHANGELOG.md)
```

- 웹에서 하려면 GitHub → **Releases** → **Draft a new release** → 태그 `v0.2.1`(`main`에서 생성) → 릴리즈 노트에 `CHANGELOG.md`의 그 버전 내용 → **Publish release**
- 릴리즈 노트는 사이드패널의 "변경 내용"에 그대로 보인다.
- 초안(draft)이나 사전 릴리즈(pre-release)는 업데이트 대상이 아니다(GitHub의 latest 릴리즈만 본다).

## 3. 사용자 쪽에서 일어나는 일

- 호스트가 켜질 때, 사이드패널을 열 때, 5분마다 최신 릴리즈를 확인한다. 새 버전이면 이름 옆에 "업데이트 v0.2.1"이 뜬다.
- 사용자가 **업데이트**를 누르면 호스트가 그 태그로 바꾼다. `package-lock.json`이 바뀌었으면 `npm ci`도 한다. 그다음 호스트가 다시 켜지고, 확장 새로고침을 안내한다.
- 사용자가 저장소 파일을 고쳤으면 업데이트를 멈추고 알린다. 사용자 설정은 `.env`와 확장 저장소에만 있다.

## 되돌리기

문제가 생긴 릴리즈는 GitHub에서 지우거나 이전 버전으로 새 릴리즈를 만든다(예: `v0.2.2`에 이전 내용).
특정 사용자만 되돌리려면 설치 폴더에서 `git checkout v0.2.0` 뒤 호스트를 다시 켠다.

## 주의

- 업데이트 확인은 GitHub API를 토큰 없이 읽는다(IP당 시간당 60회). 저장소가 공개여야 한다. 비공개로 바꾸면 사용자마다 읽기 토큰이 필요해진다.
- `manifest.json`의 `key`는 바꾸지 않는다. 바꾸면 확장 id가 바뀌어 모두 다시 설치해야 한다. 짝인 개인키는 레포 밖(`~/.koala/koala-extension.pem`)에 있고, `.crx`로 묶을 때만 필요하다.
