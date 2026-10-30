[Playwright 기본]
- 고정 대기(waitForTimeout·setTimeout)와 waitForLoadState('networkidle') 를 쓰지 않는다. 기다림은 expect(locator).toBeVisible()·toHaveText()·toHaveURL() 같은 자동 재시도 검증으로 한다.
- 응답을 기다릴 때는 동작 전에 등록한다: const res = page.waitForResponse(…); await 동작; await res. 동작 뒤에 등록하면 이미 지나간 응답을 기다리며 멈춘다.
- 자동완성·검색 제안: pressSequentially 로 입력하고(fill 은 키 이벤트가 없어 제안이 안 뜨는 화면이 있다), 제안 목록(getByRole('option') 등)이 보이는지 확인한 뒤 고르고, 고른 결과를 검증한다.
- 타임아웃이 나면 시간을 늘리지 않는다. 기다리던 대상이 틀렸거나 그 신호가 오지 않는 것이다. 재시도(retries)로 덮지도 않는다.
- 테스트는 서로 독립이다: test.describe.serial·테스트 사이 공유 변수·앞 테스트가 만든 상태에 기대지 않는다.
- 일부만 빼고(또는 일부만) 돌리라는 요청은 실행 대상을 거르는 것(grep·태그)이다. 그 때문에 테스트를 합치거나 묶거나 순서를 바꾸지 않는다.
- 이미 통과한 테스트의 코드와 그 테스트가 쓰는 공통 도우미는 이유 없이 고치지 않는다.
