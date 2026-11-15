# 공통 알고리즘 실행 계약 v1

2026-11-15, [게임 엔진·언어별 실행기 계획](game-engine-language-runners-plan.md)의 1단계 산출물. 이 계약은 엔진과 플레이어 실행기 사이의 계약이며 C# 실행 관리↔Node 엔진의 [프레임 v1](backend-execution-contract-v1.md)과 별도로 버전 관리한다.

- [JSDoc 타입](../backend/node/src/runtime/contracts/types.js)
- [입출력/결과 검증](../backend/node/src/runtime/contracts/validation.js)
- [수명 검증 모델](../backend/node/src/runtime/contracts/lifecycle.js)
- [언어 중립 manifest](../backend/contracts/runner-contract-v1.json)
- [검사](../test/runner-contract.test.js), [현 JS 기준선](runner-stage1-results.md)

**현재 구현:** 1단계의 타입·구조/상태 검증·JS 기준선에 이어 [2단계 JS 어댑터/registry](runner-stage2-results.md)를 Match와 코드 검사에 연결했고, [3단계 엔진 수명·독립 진행](runner-stage3-results.md)을 완료했다. 다른 언어는 4단계 이후다. 아래 기존 구현 대응표는 1단계 시점의 비교 자료이며 manifest의 candidateLanguages는 지원 목록이 아니다.

## 1. 두 인터페이스와 소유권

```text
인가된 SourceReference + 서버가 승인한 profileId
  → AlgorithmPreparer.prepare(request, {signal})
  → 불변 PreparedArtifact
  → RunnerFactory(context)
  → AlgorithmRunner.initialize({playerNumber, columns, rows})
  → RunnerInfo
  → move(request) 반복
  → close(reason) → CloseReceipt
```

`AlgorithmPreparer`는 파일 참조 검사·사전 준비/컴파일·산출물 반환을 담당한다. 실제 저장/컴파일/캐시는 5단계다. `AbortSignal`은 준비 작업 취소 요청이며 자식 작업과 임시 파일을 정리하기 전에 취소 완료로 간주하지 않는다. 사용자가 compiler 명령/경로/임의 옵션을 지정하지 않고 서버의 profileId를 선택하는 계약이다.

`AlgorithmRunner`는 준비한 산출물에서 플레이어를 로드/생성하고 게임 동안 같은 객체를 호출한다. initialize가 사용자 initialize/getName까지 실행한 뒤 이름/실행기 정보를 반환한다. 사용자 알고리즘의 기존 initialize/getName/moveNext 함수는 변경하지 않는다. 공통 runner의 move는 사용자 moveNext에 대응한다.

factory는 호출마다 다른 플레이어의 runner를 생성한다. 같은 불변 산출물을 여러 게임에서 참조할 수 있지만 가변 객체·모듈/global 상태를 참가자끼리 재사용하지 않는다. 소유권/파일 접근 권한은 운영/준비 계층에서 검사한다. 구조 검증기가 인가·파일 hash·컴파일 안전성을 대신하지 않는다.

## 2. 식별자와 산출물

UUID는 공백 없는 소문자 canonical UUID이며 empty UUID를 거부한다. gameId는 기존 matchId와 같은 값이다. playerId는 0~3, runId는 게임의 해당 참가자 수명이다. callId는 **move 호출만** run별 1부터 증가하는 안전한 정수이며 재사용하지 않는다. 호스트 IPC command 순번과는 별개다.

instanceId는 실제 생성한 Player 객체, hostId는 그 객체를 호스팅하는 실행 호스트의 수명을 식별한다. 실제 객체/호스트 생성 시 한 번 발급하고 timeout 뒤에도 동일해야 한다. PID만으로 재사용을 증명하지 않으며 PID는 별도 진단 값으로 사용할 수 있다. 2단계 worker가 실제 UUID를 발급하며, 발급 전인 1단계 기준 측정에는 이를 소급해 넣지 않는다.

`SourceReference`는 기존과 같은 sourceKey/sha256/byteLength다. byteLength는 0 이상의 안전한 정수이며 64KiB 같은 새 코드 크기 제한을 두지 않는다. SHA-256은 소문자 64자리다. 실제 bytes/hash 검증은 파일 저장/준비 계층에서 수행한다.

`PreparedArtifact` 필드:

| 필드                         | 의미                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| contractVersion / artifactId | runner 계약 버전·불변 산출물 ID                                                           |
| language / profileId         | 후보 언어 ID·서버가 승인한 준비 프로필                                                    |
| source                       | 원문 파일 참조·hash·길이                                                                  |
| content                      | artifactKey/hash/byteLength, 실제 실행 bytes의 참조                                       |
| format                       | 실행 형태 식별자. 이 단계에서는 native/managed/Wasm 등을 선택하지 않음                    |
| toolchain / runtime          | name/version. 실제 확인한 버전을 사용하고 wrapper 패키지 버전과 엔진 버전을 혼동하지 않음 |
| adapterVersion / target      | 어댑터 버전·대상 os/architecture                                                          |
| optionsHash                  | 승인된 준비 옵션의 fingerprint. 임의 명령/비밀을 포함하지 않음                            |

준비 응답은 요청의 language/profileId와 원문 sourceKey/hash/길이가 모두 같아야 한다. `assertPreparationResult`로 다른 소스/프로필의 캐시 결과가 섞이는 것을 거부한다. 실제 캐시 키는 5단계에서 이 메타데이터와 정책/버전으로 구성한다.

현재 JS는 초기화 중 원문을 QuickJS에 로드/컴파일한다. 산출물 캐시나 QuickJS 바이트코드 export가 이미 구현됐다고 해석하지 않는다. 타입/시험의 `javascript-source`는 원문 참조를 산출물로 사용할 수 있는 표현 예이며 실제 preparer를 등록한 것이 아니다.

## 3. 생성/초기화와 입력

`RunnerContext`는 contractVersion/gameId/playerId/runId/language/artifact/limits다. context language와 artifact language는 일치한다. limits.turnMs는 현재 500으로 고정한다. algorithmMemoryBytes는 해당 어댑터가 실제 적용하는 알고리즘 한도이며 미확정/구분 불가능할 때 null이다. null이 무제한 실행 허가를 의미하지 않으며 상위 호스트 자원 정책은 별도로 필요하다.

initialize 입력은 playerNumber/columns/rows다. playerNumber는 playerId와 일치하고 시작 위치를 뜻하지 않는다. 현재 맵 범위 4~40열·4~30행을 사용한다. 이름은 기존 JS처럼 40 UTF-16 code unit 이내 문자열이며 빈 문자열을 새로 금지하지 않는다.

`RunnerInfo`는 context의 게임/참가자/run/language, 실제 instanceId/hostId, name/runtime/adapterVersion을 반환한다. 준비 descriptor와 runtime/adapter 버전이 일치해야 한다. 수명 모델은 검증된 metadata의 깊은 사본을 동결해 보관한다.

move 입력은 contractVersion/gameId/playerId/runId/callId/map/myPosition/items다.

- map은 columns×rows 길이의 밀집 정수 배열. 값은 -1/0/10/30/100/200/500.
- myPosition은 이 snapshot에서 현재 플레이어의 0 기반 일차원 index다.
- items는 신발/망치/x2/랜덤점프 순서의 길이 4 배열. 없으면 -1, 있으면 map index이며 출현 중인 위치는 중복되지 않는다.
- 엔진이 판단을 요청할 때 현재 상태의 사본을 전달한다. 다른 참가자의 응답을 기다려 공통 snapshot 시점을 만들지 않는다.
- 어댑터는 guest의 입력 변경이 엔진/다른 참가자에게 전파되지 않게 한다. 검사 함수는 입력을 수정하거나 복사하지 않으며 격리/복사 책임을 대신하지 않는다.
- 임의 필드·희소 배열/인덱스 getter·array의 별도 속성을 거부한다. 계약 검증은 JSON 데이터 경계용이며 같은 프로세스의 악성 Proxy 실행을 격리하는 sandbox가 아니다.

## 4. 결과와 실패

`MoveResult`는 context 식별자와 instanceId/callId, status/direction/completion/logs/droppedLogs/timings다. engine의 현재 run/instance/call과 일치하지 않는 응답은 적용하지 않는다.

| status         | direction  | completion  | 의미                                                          |
| -------------- | ---------- | ----------- | ------------------------------------------------------------- |
| ok             | -1/0/1/2/3 | returned    | 정상 반환. -1도 이번 턴 제자리 패널티지만 runtime 오류는 아님 |
| timeout        | -1         | interrupted | 500ms 예산 초과, 실행이 실제로 중단돼 반환됨                  |
| exception      | -1         | returned    | 사용자 호출 예외로 종료                                       |
| invalid-result | -1         | returned    | 사용자 반환값이 유효한 방향 정수가 아님                       |

0/1/2/3은 왼쪽/위/오른쪽/아래다. timeout의 executionMs는 500 이상, 그 외는 500 이하여야 한다. 무한 루프의 결과를 버린 상태나 취소 요청을 발행한 상태는 interrupted가 아니다. 이 표의 데이터 검증은 어댑터가 보고한 사실의 일관성을 확인할 뿐 실제 중단을 증명하지 않으며 런타임/동일 인스턴스 재호출 시험이 별도로 필요하다.

debug는 호출별 30줄·줄당 1024 UTF-16 code unit 이내와 droppedLogs(생략한 줄 수)다. 기존 JS 제한을 유지한다. 디버그 출력에는 사용자 값이 포함될 수 있으므로 기존 로그의 소유권/조회 정책을 적용한다.

인프라 문제는 `RunnerFault`로 호출을 reject한다. unavailable, initialization-failed, host-exited, unresponsive, protocol-error, memory-limit, preparation-failed, cancelled와 prepare/initialize/move/close 단계를 구분한다. 내부 명령·경로·비밀·원본 exception을 공통 fault 메시지에 넣지 않는다. 게임에서 참가자/전체 실패로 처리하는 정책은 3단계에서 연결하며 이를 일반 -1 성공으로 숨기지 않는다.

현재 QuickJS의 메모리 할당 실패는 항상 별도 원인을 안정적으로 식별하는 형태가 아니다. 현재 결과의 exception을 메모리 초과라고 추정 변환하지 않는다. memory-limit은 호스트가 그 원인을 확인했을 때 사용하는 인프라 분류다. QuickJS heap 32MiB와 Node/Wasm의 전체 메모리를 구분한다.

## 5. 호출 시간과 500ms 경계

| 값                   | 경계/처리                                                                 |
| -------------------- | ------------------------------------------------------------------------- |
| executionMs          | 현재 500ms 판정에 사용하는 실행 구간. 경계 ID로 의미를 명시               |
| executionBoundary    | 현재 JS는 `quickjs-call-v1`                                               |
| roundTripMs          | 어댑터 호출 시작→응답 수신/완료의 caller 구간. 직접 경로에는 없을 수 있음 |
| inputPreparationMs   | 엔진의 해당 입력 snapshot 준비. 미측정은 null                             |
| responseProcessingMs | 어댑터 응답 처리의 독립 구간. 미측정은 null                               |
| engineApplyDelayMs   | 결과 사용 가능→실제 액션 시작. 미측정은 null                              |

기존 JS의 500ms는 `AlgorithmSandbox.run()` 시작부터다. guest JSON.parse/dispatch, 사용자 함수, guest의 primitive 방향 검사를 포함한다. 바깥 Node의 JSON.stringify·QuickJS 문자열 생성·IPC·결과 handle 해제는 이 예산 밖이다. `initialize/getName`과 로드 과정도 기존 run별 제한을 유지하며 준비 작업 전체 시간 제한과 구분한다.

1단계는 이 경계를 바꾸지 않는다. 다른 언어는 대응 구간과 경계 ID를 4단계에서 검증하고 동일 조건으로 비교한다. 순수 사용자 함수 시간이라고 표시하거나 IPC를 보상하기 위해 결과를 지연시키지 않는다.

알 수 없는 값은 null이고 0은 실제 측정된 0이다. 같은 단조 시계에서 잰 duration을 사용한다. 서로 다른 프로세스의 timestamp를 그대로 빼지 않는다. caller total−executionMs는 복수 경계 밖 비용의 관찰값이며 정확한 IPC 구간이 아니다. 20ms tick/GC/스케줄링은 게임의 실제 총 경과 시간에 남으며 소급 보정하지 않는다.

## 6. 수명 검증과 종료

```text
created → initializing → ready → computing → ready → ...
                         ↓          ↓
                      closing ← closing
                         ↓
                       closed
실패 → failed → closing → closed
```

- initialize는 한 번만 수행한다. ready인 runner에만 move를 요청하고 callId는 증가한다.
- computing은 해당 호출의 실제 반환/중단 확인 전까지 유지한다. cancel 요청만으로 ready로 바꾸지 않는다.
- 엔진의 acting과 runner의 ready는 다르다. runner가 준비됐더라도 액션이 끝나기 전에 엔진이 다음 move를 요청하면 안 된다. [3단계](runner-stage3-results.md)에서 엔진의 pending 판단·thinking·진행 중 액션을 확인하고 종료 시 늦은 결과 생산자를 drain한 후 기록을 seal한다.
- 잘못된 run/instance/call의 응답을 거부해도 pending call을 풀지 않는다. 어댑터가 protocol fault와 실제 자원 정리를 처리해야 한다.
- close는 초기화/판단 중에도 요청 가능하다. 뒤늦게 정상 초기화/판단이 끝나도 closing에서 ready로 돌아가지 않는다.
- fail도 active call이나 자원이 실제 해제됐다고 간주하지 않는다. 실패 후 close/cleanup이 필요하며 새 객체로 재초기화해 계속하지 않는다.
- CloseReceipt는 contractVersion/runId/resourcesReleased:true다. 어댑터는 host/context/대기 요청을 정리한 뒤에만 반환한다. close의 반복 요청에는 같은 정리 작업/settlement를 사용한다.
- `RunnerLifecycle.beginClose()`는 이미 closing/closed일 때 false를 반환한다. `confirmClosed()`는 첫 실제 종료 확인에서만 호출한다. 이 모델 자체가 프로세스를 종료하거나 시간을 제한하지 않는다.

## 7. 기존 구현 대응과 2단계 작업

| 공통 계약                | 현재 JS/게임 구현                                                 | 연결할 부분                                                    |
| ------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| factory(context)         | `Match.sources.map(() => runnerFactory())`                        | 참가자 context/언어·artifact를 전달하는 registry               |
| prepare                  | 별도 정식 preparer 없음, 파일 참조를 초기화 때 로드               | 사전 준비/캐시의 실제 구현은 5단계                             |
| initialize(input) → info | PlayerProcess.initialize(source, number, columns, rows), name/pid | 기존 함수 호출을 유지하는 어댑터와 실제 UUID/version info      |
| move(request) → result   | PlayerProcess.move(map, position, items)                          | call/run correlation, value→direction, timing 경계/상태 정규화 |
| completion interrupted   | QuickJS interrupt handler와 동기 invoke 반환                      | 실제 종료 확인을 새 result에 연결, timeout 재생성 금지         |
| close → receipt          | worker close/context dispose와 process exit 기다림                | 수명 검증·기한/실패 정리·명시적 release 확인                   |
| engineApplyDelay         | Match가 결과 후 beginAction, 액션 완료는 tick                     | 실제 계측과 개선은 3/7/8단계                                   |

`assertLegacyMoveResult`는 기존 value/elapsedMs/logs/droppedLogs 및 있는 경우 pid/roundTripMs를 검사한다. 새 식별자나 미측정 값을 만들어 붙이지 않는다. 이를 신규 계약 어댑터나 production 기능 연결이 완료된 것으로 해석하지 않는다.
