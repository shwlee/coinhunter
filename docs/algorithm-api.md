# JavaScript 알고리즘 API — 첫 구현

- 기준일: 2026-09-27
- 구현: `src/runtime/`, 예제: `examples/nearest-coin.js`.

## 파일 형식

최대 64 KiB의 단일 JavaScript 파일이다. 클래스를 `module.exports`로 내보내고 세 메서드를 구현한다.

```javascript
module.exports = class Player {
  initialize(myNumber, column, row) {
    this.number = myNumber;
    this.column = column;
    this.row = row;
  }
  getName() { return '내 알고리즘'; }
  moveNext(map, myPosition, items) {
    debug.print('현재 위치', myPosition);
    return 2;
  }
};
```

initialize는 경기 시작 전 한 번 호출된다. 번호는 0부터 시작하며 좌상·우상·좌하·우하 순이다. getName은 문자열을 반환하며 화면에 최대 40자까지 표시한다.

## 이동 입력·반환

- map: 행 우선 1차원 배열. 인덱스 = `y * column + x`. 벽 -1, 빈칸 0, 코인 10/30/100/200/500.
- myPosition: 현재 플레이어의 확정 위치 인덱스.
- items: `[신발, 망치, x2, 랜덤점프]` 위치. 맵에 없으면 -1.
- 두 배열은 호출 시점 사본이며, 수정해도 게임 상태가 변경되지 않는다.
- 반환값: 정수 0 왼쪽, 1 위, 2 오른쪽, 3 아래, -1 이번 턴 제자리 패널티.
- 기존 두 인자 moveNext도 호출할 수 있으나 새 아이템 위치를 사용하지 않는다.
- 랜덤점프 효과 중에는 moveNext를 호출하지 않는다.

## 작성 제한

기존 게임의 built-in만 사용·외부 라이브러리 금지·비동기/병렬 금지·대기 금지·web/socket 금지·단일 파일 규칙을 유지한다.

첫 구현은 AST 검사로 async, await, generator, import, 클래스 static을 거부한다. generator 제한은 동기 단일 결과 계약을 단순화하기 위한 구현 제약이다. eval, Function 생성자, Promise, WebAssembly, WeakRef, FinalizationRegistry를 제공하지 않는다. Node.js의 require/process, 파일·네트워크·타이머·스레드 API도 제공하지 않는다.

Math·배열·객체·문자열·Map·Set 등의 일반적인 동기 built-in을 사용할 수 있다. 기존 호스트에서 우연히 접근 가능했던 외부 API를 지원하는 계약은 아니다.

## 호출 결과와 시간

| 상태 | 뜻 | 게임 처리 |
| --- | --- | --- |
| ok / 0~3 | 정상 방향 | 이동 또는 벽 액션 |
| ok / -1 | 명시적 패널티 | 이번 턴 제자리 |
| timeout | 500ms 제한 경과 | 이번 턴 제자리 |
| exception | 실행 예외·guest 자원 오류 | 이번 턴 제자리 |
| invalid-result | 문자열·객체·허용되지 않은 숫자 등 | 이번 턴 제자리 |

반복 오류라도 프로세스를 자동 재시작하지 않는다. 시간 초과 후 동일 인스턴스의 필드 상태를 유지한다. 예외 객체는 사용자 정의 getter 실행을 피하기 위해 호스트에서 임의로 펼치지 않으며 첫 버전은 일반 오류 분류를 표시한다.

## 디버그 출력

`debug.print(...values)`는 호출당 최대 30개 메시지를 수집한다. 메시지당 인자는 최대 8개, 인자당 512자, 합산 메시지는 1024자로 제한한다. 객체·함수는 내용을 직렬화하지 않고 `[object]`, `[function]`으로 표시하므로 필요한 숫자·문자열을 직접 전달한다.

생략된 출력 개수와 플레이어·턴·실행 시간·오류 상태를 실행 로그에 표시한다. 로그는 현재 경기 메모리에만 유지하며 영구 저장하지 않는다.
