# 실행기 2단계 — JavaScript 어댑터·registry 연결

2026-11-15. 선행 1단계는 `81f3a94`로 커밋했다. [10단계 계획](game-engine-language-runners-plan.md), [공통 계약 v1](algorithm-runner-contract.md).

## 구현 구조

```text
C# 실행 관리 → 게임별 Node engine-host
  → Match: 참가자의 gameId/playerId/runId·독립 callId
  → RunnerRegistry.create(context): javascript만 활성
  → JavaScriptRunner: 계약/수명·결과/오류 정규화
  → PlayerProcess: 명령 상관관계·IPC·호스트 수명
  → player-worker: 실제 hostId/instanceId 발급
  → 동일 QuickJS Player 객체에 initialize/getName 후 moveNext 반복
```

- [registry](../backend/node/src/runtime/runner-registry.js)는 알 수 없는 언어를 JS로 대체하지 않는다. 후보 언어 목록과 실제 지원 목록은 별개다.
- [JS 어댑터](../backend/node/src/runtime/javascript-runner.js)는 공통 initialize/move/close를 제공한다. 같은 플레이어의 중첩 호출·재초기화와 다른 run/instance/call의 응답을 거부한다. source 원문/경로는 공통 context/result에 넣지 않는다.
- [세션별 source binding](../backend/node/src/runtime/javascript-artifacts.js)은 기존 문자열 또는 내부 파일 참조를 연결한다. C#이 전달한 sourceKey/hash/길이와 실제 bytes를 대조하고 worker가 로드할 때 다시 검증한다. 물리 경로는 내부 resolver에만 보관한다. 원문 파일 저장을 유지하며 새 코드 크기 제한을 추가하지 않았다.
- descriptor의 `javascript-source`는 기존 원문 로드를 표현한다. 디스크 산출물 캐시·바이트코드 export·정식 컴파일 preparer는 5단계다. QuickJS 패키지 버전과 native QuickJS 버전을 동일하다고 주장하지 않는다.
- [Match](../backend/node/src/game/match.js)는 factory에 context를 전달하며 생성 직후 추적한다. 일부 factory/초기화가 실패해도 앞서 만든 모든 runner의 close를 시도한다. 준비는 single-flight이고 준비 중 stop도 최종 정리를 기다린다.
- 계산 결과의 `direction/timings.executionMs`만 기존 GameState 액션 DTO의 `value/elapsedMs`로 바꾼다. 게임 규칙·화면 snapshot·결과 통계는 유지한다. 랜덤점프는 호출을 건너뛰므로 알고리즘 callId와 게임 턴 번호는 다를 수 있다.

## 중단·장애·종료

- **정상 500ms timeout:** 기존 QuickJS interrupt가 실제로 호출을 중단하고 `timeout/-1/interrupted`를 반환한다. 같은 PID/hostId/instanceId와 필드를 유지한다. 프로세스 종료/재시작을 사용하지 않는다.
- **사용자 예외·잘못된 반환:** 이번 턴의 -1 결과로 정규화한다. 정상 -1과 상태를 구분하며 다음 호출이 가능하다.
- **인프라 장애:** 연결 단절·예상하지 않은 IPC 응답·장시간 미응답은 RunnerFault로 reject한다. 이를 정상 -1 결과로 숨기거나 실행기를 재생성하지 않는다. 기존 게임의 전체 runtime-failure 종료 정책을 유지했다.
- 호스트 대기 기한은 초기화 30초, move 응답 5초다. 이것은 500ms 게임 규칙을 늘린 값이 아니라 인터럽터/호스트 자체의 실패를 감지하는 별도 watchdog이다. 입력 직렬화 등 동기 host 작업을 선점할 수 있는 OS 제한을 의미하지 않는다.
- close는 같은 Promise를 재사용한다. 정상 종료를 3초 기다린 뒤 필요하면 실패한 호스트를 강제 종료하며 실제 child `close`까지 확인한다. 강제 종료 후에도 자원이 닫히지 않으면 추가 대기에 상한을 두고 실패로 보고하며 resourcesReleased를 반환하지 않는다. 준비 정리 실패도 숨기지 않는다.
- 알고리즘 child와 코드 검사 worker에는 OS 실행에 필요한 환경만 전달한다. OAuth/내부 키·NODE_OPTIONS 등 부모 서비스 설정을 상속하지 않는다.

## 코드 검사와 호환

[코드 검사](../backend/node/src/runtime/preflight-worker.js)도 같은 registry/JS 어댑터/QuickJS 정책으로 실행한다. 기존 구문·제한·미선언 이름 검사와 2개 샘플 맵×4명×3회의 24호출을 유지한다. 검사 전용 diagnostics 옵션으로만 bounded 사용자 오류·디버그 출력과 소스 위치를 제공하며 공통 MoveResult/일반 게임 fault에는 원문 예외를 붙이지 않는다.

검사는 별도의 disposable 세션이다. 취소 시 실행 중인 runner를 닫은 후 검사 worker를 닫으며, 검사 전체가 응답하지 않는 경우의 최종 강제 종료를 정상 게임 턴 timeout과 구분한다. 검사는 샘플 입력 실행이며 모든 경로의 무오류를 보증하지 않는다.

기존 `PlayerProcess` 직접 사용 도구/시험의 value/elapsedMs/pid는 호환 유지한다. 새 게임의 `algorithm-result.result`는 contractVersion:1의 direction/timings·run/instance/call을 사용한다. JSONL envelope와 저장된 과거 로그는 변경하지 않으며 과거 value/elapsedMs 형식과 구분해 읽어야 한다. 화면/API 경기 snapshot 형식은 유지한다.

## 검증

```sh
node --test --test-concurrency=2 test
node scripts/verify-runtime.js
node scripts/backend.js test
npm run format:check
```

- 신규 어댑터/장애 검사 15건: timeout/예외/잘못된 반환 후 같은 객체 재호출, 독립 참가자 진행, 입력/디버그 격리, source 교체 거부, 초기화/호출 중 close, 잘못된 응답, 미응답/단절/강제 종료 실패, 부분 생성 실패, 준비 중 stop, 취소와 환경 경계.
- Node 전체 259건 통과. 결과 통계 시험의 가짜 runner를 새 계약 형식으로 변경했다.
- C# 계약/업무 검사 44건, 프로토콜 상호운용 5건, 분리 BE HTTP/SSE·실제 게임·전량 JSONL/receipt·복구 13개 그룹 통과. 테스트 전용 데이터/서비스를 사용하고 종료했다.
- 정식 registry/JS 어댑터의 정상→timeout→정상 확인 도구도 통과했다.

## 리뷰와 다음 범위

검토 중 발견한 부분 factory 실패의 추적 누락, 종료 무기한 대기, 준비 중 stop 경쟁, 환경 상속과 진단 메시지의 호출 간 잔존을 보완했다. 종료 실패는 성공 receipt로 바꾸지 않는다.

지원 언어는 JavaScript 하나다. C#/C++/Python 설치·호스팅 선정/지원, 사전 컴파일 캐시와 세부 성능 최적화는 수행하지 않았다. 독립 턴과 현재 20ms tick·500ms 계측 경계를 유지했다. 다음 3단계는 게임 엔진의 독립 진행·수명/규칙 회귀를 더 체계적으로 분리하는 작업이다. 이번 단계만으로 이후 단계의 통합/부하·운영 격리 검증을 완료 처리하지 않는다.
