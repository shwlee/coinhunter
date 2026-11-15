# 실행기 3단계 — 게임 엔진의 독립 진행과 수명

2026-11-15. 선행 2단계는 `61f92f2`로 커밋했다. **3단계 구현·검증 완료, 리뷰 대기.** 추가 화면 수정과 함께 보관한다. [전체 계획](game-engine-language-runners-plan.md), [공통 실행 계약](algorithm-runner-contract.md).

추가 플레이 피드백으로 [턴 경계 전달·화면 보간 수정](game-motion-fix.md)을 반영했다. 아래 42표본/소스 hash는 해당 추가 수정 전의 3단계 원시 기준선이며 그대로 보관한다. 최신 검증은 추가 수정 문서를 함께 확인한다.

## 책임과 주입 경계

| 구성             | 책임                                                                  | 관련 소스                                                   |
| ---------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| GameState        | 이동/대체 액션, 충돌·코인·아이템·랜덤 기믹·종료 규칙                  | [state.js](../backend/node/src/game/state.js)               |
| Match            | 준비/실행/종료 수명, 독립 플레이어 진행, 공통 runner 호출과 응답 적용 | [match.js](../backend/node/src/game/match.js)               |
| MatchOutput      | 전량 이벤트 enqueue, 최근 디버그 40건, 화면 snapshot 조립             | [match-output.js](../backend/node/src/game/match-output.js) |
| Match clock      | 단조 시각과 기본 20ms timer, 테스트의 수동 시간 제어                  | [match-clock.js](../backend/node/src/game/match-clock.js)   |
| JavaScriptRunner | 같은 Player 객체의 실제 호출/500ms 중단, 호스트 수명                  | [2단계 결과](runner-stage2-results.md)                      |

`new Match(map, sources, options, dependencies)`의 네 번째 인자는 내부 주입 경계다. clock(now/setInterval/clearInterval), random, runnerFactory, record와 준비 중단 시험용 artifacts 경계를 제공한다. 화면/API에서 임의 실행기·clock·경로를 받는 기능은 아니다. 이전 내부 도구의 options.runnerFactory/options.record도 호환한다.

게임 옵션은 복사해 전달하며 gameId/participants와 factory/기록 함수는 GameState 옵션에서 제외했다. GameState는 저장소·IPC·타이머를 호출하지 않는다. 실행기 이름과 결과는 공통 계약으로 검증한다. 다른 run/instance/call의 응답은 적용하지 않는다.

기록 sink는 **동기 enqueue**만 수행한다. 파일 append/sync는 기존 collector/storage가 담당하고 엔진은 매 턴 저장 완료를 기다리지 않는다. Promise를 반환하는 직접 저장 sink는 계약 위반으로 처리한다. 이벤트 payload와 화면 로그 사본을 분리해 sink나 구독자가 엔진의 맵·점수·디버그 버퍼를 바꾸지 못하게 했다. 이 경계는 신뢰된 호스트 객체용이며 악성 JS 객체를 격리하는 sandbox는 아니다.

## 독립 턴과 상태

```text
created → preparing → ready → running → stopping → closed
             ↓                     ↘              ↘
           failed                 stopping        failed
```

준비 실패는 해당 prepare/start 호출을 reject하고 이미 만든 runner들을 정리한다. 실제 자원 정리를 확인할 수 없는 종료 실패는 failed이며 closed 이벤트를 보내지 않는다. 준비 실패 후 호스트가 stop으로 전체 수명을 마무리할 수 있지만 같은 게임을 다시 초기화/시작할 수는 없다.

- prepare/start는 진행 중인 동일 작업을 재사용한다. stop은 첫 요청 때 종료 Promise를 예약하며 중복·동기 재진입도 같은 Promise를 받는다.
- 다른 참가자의 initialize 완료는 **준비 단계에서만** 기다린다. 게임 중에는 플레이어별 `판단 → 즉시 액션 → 액션 완료 감지 → 다음 판단`을 독립 진행한다.
- 같은 플레이어의 pending 판단·thinking·진행 중 액션을 검사해 중첩 호출을 차단한다. 결과가 도착한 뒤 다음 tick까지 기다리지 않고 바로 액션을 시작한다.
- 액션 완료 감지는 기존 20ms tick이다. 동일 tick의 완료 액션은 플레이어 번호 순서로 확정해 같은 코인/벽의 중복 획득·파괴를 방지한다. 다른 판단의 완료를 기다리는 장벽이나 시간 보정은 추가하지 않았다.
- -1/timeout/예외/잘못된 반환은 이번 턴의 제자리 액션이다. 다음 턴에 추가 패널티를 예약하지 않는다. 정상 timeout의 실제 중단은 JS 어댑터가 담당한다.
- 랜덤점프는 플레이어/게임 상태가 처리하며 runner 호출과 callId 증가를 생략한다. 따라서 게임 턴과 알고리즘 callId는 다를 수 있다.

GameState.start는 ready 상태에서만 가능하며 finish는 처음 정해진 종료 이유를 유지한다. 자연 종료 직후 뒤늦은 stop이 coins-collected를 다른 이유로 바꾸지 않는다. 통계는 종료 전에 정상 적용된 결과/완료 액션만 반영하며 취소된 액션과 늦은 응답을 점수에 반영하지 않는다.

## 종료와 실패 처리

1. stop을 예약하고 새 판단과 timer 진행을 막는다. 논리적인 게임은 즉시 finished로 전환해 최종 화면을 발행한다.
2. 초기화/판단 중인 실행기를 포함해 close를 요청한다. 준비 작업은 추가 생성을 중단하고 자신이 만든 자원도 정리한다. factory가 stop에 동기 재진입한 뒤 반환한 runner도 회수한다.
3. 실행기 정리 완료와 준비 작업을 확인하고, 진행 중이던 엔진 판단 작업의 후속 처리까지 기다린다.
4. 늦은 정상 결과는 late-result, 늦은 실패는 late-failure로 기록한다. 액션·점수·통계·다음 판단은 만들지 않는다.
5. 생산자가 모두 종료된 뒤 output을 seal하고 closed를 알린다. 그 후 collector.finish가 전량 로그를 flush/완결할 수 있다.

판단 작업 내부에서 자신을 기다리는 stop을 await하지 않는다. tick/event 경로의 종료 실패는 관찰해 unhandled rejection을 막고, 명시적으로 stop을 호출한 호스트에는 실패 Promise를 그대로 돌려준다. 종료 구독자 하나가 throw해도 나머지 구독자에게 종료를 알린다.

| 상황                                | 처리                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| 정상 500ms timeout                  | 현재 턴 패널티, 실제 중단 확인 후 같은 인스턴스 재사용       |
| 사용자 exception/invalid-result     | 현재 턴 패널티, 다음 판단 가능                               |
| runner/host 단절·미응답·손상된 결과 | 기존 정책대로 **전체 게임** runtime-failure 종료             |
| 동기 기록 enqueue 실패              | recording-failure로 종료하고 자원 정리 유지                  |
| 화면 구독자의 동기 예외             | transport-failure로 종료하고 자원 정리 유지                  |
| 준비/액션/판단 중 사용자 취소       | 첫 종료 이유 유지, 새 판단 금지, 진행 중 자원/후속 작업 정리 |
| close 실패                          | 실패 reject, closed/성공 자원 해제 상태를 만들지 않음        |

게임 finished와 자원/후속 생산자가 모두 정리된 closed는 다르다. 정상 timeout 처리에 프로세스 종료를 사용하지 않으며, 전체 종료/호스트 장애의 최종 회수는 2단계 어댑터의 기한/강제 종료 정책을 따른다. 엔진이 임의 언어의 실행을 중단할 수 있게 된 것은 아니다. 후속 언어는 실제 중단·재사용·정리 계약을 검증해야 한다.

## 20ms tick과 호출 지연 측정

전량 이벤트에 다음 정보를 추가했다. 기존 화면 snapshot과 공통 runner MoveResult 형식, 500ms 예산 경계는 유지한다.

- action-completed.timing: 예정된 action.endsAt에서 실제 tick이 완료를 감지한 시각까지의 지연.
- turn-requested.scheduling: 완료 감지에서 엔진이 다음 턴을 접수한 시각까지의 지연. 최초 턴은 null이다.
- algorithm-dispatched.scheduling: snapshot 준비·turn-requested enqueue 후 **실제 runner.move 호출 직전** 시각으로 측정한 지연. 랜덤점프는 이 이벤트를 만들지 않는다.
- completionDetectionDelayMs, completionToDispatchMs, acceptanceToDispatchMs, actionToDispatchMs를 구분한다. 마지막 값은 액션 예정 종료에서 다음 runner 호출까지이며 다음 알고리즘의 실행 시간은 포함하지 않는다.

```sh
npm run engine:scheduling
```

[측정 도구](../scripts/measure-engine-turn-scheduling.js)는 외부 서비스/계정 데이터 없이 4명의 실제 JS 실행기로 재현한다. 0번은 매 호출 500ms 무한 루프, 나머지는 -1을 반환하며 액션은 모두 200ms다. 최소 40개 표본을 요청하며 한 tick에서 여러 참가자가 진행해 보관 실행에서는 42개가 수집됐다. [원시 측정 자료](benchmarks/engine-turn-scheduling-2026-11-15.json).

2026-11-15T10:42:08Z, Windows 10.0.26200 x64 / Node 18.20.2 / i7-10700F의 한 로컬 실행, 단위 ms:

| 측정                         |    p50 |    p95 |    max |
| ---------------------------- | -----: | -----: | -----: |
| 완료 감지 지연               | 14.077 | 18.182 | 18.388 |
| 감지 → runner 호출           |  0.731 |  1.067 |  1.314 |
| 턴 접수 → runner 호출        |  0.012 |  0.031 |  0.054 |
| 액션 예정 종료 → runner 호출 | 14.680 | 19.066 | 19.095 |

느린 참가자는 4회의 timeout 결과를 처리하는 동안 빠른 참가자는 각각 13회의 결과를 처리했다. 종료 직전에 새로 요청된 판단은 late-result/late-failure 경로로 정리하며 정상 적용 통계에는 넣지 않는다. 최종 pending 엔진 작업 0개, 모든 실행 호스트의 close를 확인했다.

20ms는 timer 설정이지 지연의 최대 보장이 아니다. OS 스케줄링·GC·기록/화면 사본 작업 등에 따라 20ms보다 길 수 있다. 다른 로컬 실행에서 더 큰 값이 나올 수 있으며 이 자료로 언어 간 공정성·서비스 수용량을 보증하지 않는다. 스케줄링 최적화는 계획의 8단계다.

## 검증과 리뷰 범위

- [신규 수명/독립 진행 검사](../test/match-lifecycle.test.js) 20건. 제어된 clock/random·교체 runner와 실제 JS를 함께 사용한다. 초기화 중 취소, 일부 생성 실패, 늦은 응답/예외, reentrant stop, 부정확한 결과, 기록/구독 오류, 정리 실패를 검사한다.
- -1/timeout·벽 충돌/망치·신발 만료·x2/효과 교체·랜덤점프 성공/실패와 호출 생략을 엔진 경로에서 대조했다. 기존 GameState/통계 시험도 유지했다.
- Node 전체 279건 통과. C# 검사 44건, 프로토콜 5건, 분리 BE HTTP/SSE·실제 게임·JSONL/receipt/복구 13그룹 통과.
- [부하·장애 도구](../scripts/backend-load-smoke.js)로 4개 게임·총 16개 플레이어 실행기·동시 SSE/코드 검사/업로드/맵 조회와 수락 한도, 엔진 강제 종료 후 자식 회수/partial 로그, 실행 관리 서비스 재시작 복구를 확인했다.
- 부하 도구의 구형 pid/value/elapsedMs 로그 의존을 공통 계약의 instanceId/direction/timings로 변경했다. 프로세스 자원 표본은 격리된 테스트 엔진의 OS 자식만 조회한다. Windows CIM 조회에는 환경 권한이 필요하며 제한된 sandbox에서는 이 조회가 거부될 수 있다.

주요 명령:

```sh
node --test --test-concurrency=2 test
node scripts/backend.js test
node scripts/backend-load-smoke.js
npm run engine:scheduling
npm run format:check
```

이번 범위는 3단계까지다. 사용자 리뷰 후 후속 단계를 결정한다. 4단계 언어별 호스팅 선정/설치, 5단계 컴파일 캐시, 7단계 전체 자원/언어별 계측, 8단계 최적화·10단계 최종 운영 부하는 완료로 표시하지 않는다. FE 변경·실제 배포·실제 Google 접속도 수행하지 않았다.
