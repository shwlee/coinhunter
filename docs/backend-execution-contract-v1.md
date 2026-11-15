# BE 내부 실행·게임 엔진 메시지 계약 v1

2026-11-15: 1단계 정의에서 실제 4~7단계 구현으로 갱신했다. [전체 구현 결과](backend-split-completion.md), [실행법](../backend/README.md).

## 통신 경계

- 운영 API ↔ 실행 관리: loopback HTTP, Bearer 내부 키. 브라우저 Origin은 내부 API에서 거부한다. 쿠키/이메일로 내부 실행 권한을 판단하지 않는다.
- 실행 관리 ↔ 경기별 Node: stdin/stdout의 4바이트 big-endian 길이 + UTF-8 JSON. 본문 최대 4MiB, JSON 깊이 64. stderr와 알고리즘 debug는 프레임으로 해석하지 않는다.
- Node 엔진 ↔ 플레이어: 주입 가능한 runnerFactory, 첫 구현은 기존 PlayerProcess/QuickJS. 이 관리 채널이 향후 모든 언어에 IPC를 강제하는 계약은 아니다.

## 실제 내부 API

| API                                       | 동작                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| GET `/internal/v1/status`, `/contracts`   | 버전 1·구현 단계 9·업무 capability/경로                                     |
| POST `/internal/v1/matches`               | 불변 실행 요청 수락. 준비 완료까지 기다린 뒤 202 실행 view                  |
| GET `/internal/v1/matches/{id}`           | state, snapshot, result, acknowledged, 내부 진단 enginePid                  |
| POST `/internal/v1/matches/{id}/start`    | prepared → running. 재시작 명령은 중복 실행하지 않음                        |
| POST `/internal/v1/matches/{id}/stop`     | requestId/reason, 중복 안전한 전체 종료                                     |
| GET `/internal/v1/matches/{id}/events`    | event: execution, 최신 전체 view 스트림                                     |
| POST `/internal/v1/validations`           | requestId, scope, source 참조. 별도 검사 프로세스, 취소/전체 기한/수락 한도 |
| POST `/internal/v1/results/{id}/ack`      | matchId/resultVersion=1. 운영 요약 반영 확인 후 영구 확인 상태 기록         |
| GET `/internal/v1/matches/{id}/recording` | 종료·복구 후 원본 JSONL 스트리밍                                            |

기존 공개 경기 생성 201 `{id}`와 snapshot `{sequence,game,logs}`는 유지한다. 기존 화면의 카운트다운 순서는 호환을 위해 그대로이며 공개 POST 내부에서 준비→시작을 수행한다. 내부 준비/시작 API와 브라우저에 별도 준비 단계를 노출하는 UI는 구분한다.

## 요청·결과

`ExecutionRequest`: contractVersion/requestId/matchId/scope/map/participants/options. scope는 user/guest와 UUID이며 OAuth sub·쿠키·이메일을 포함하지 않는다. map은 복사한 id/revision/columns/rows/tiles/settings다. 운영과 실행 영역 양쪽에서 맵/옵션을 검증한다.

participant: playerId(0부터 연속)/runId/language/source/startSlot/characterId. source는 서버 생성 UUID sourceKey·SHA-256·바이트 길이다. 실행 관리가 허용된 exchange 디렉터리에서 검증·사본 생성하고 엔진이 다시 해시를 검증한다. 원문이나 임의 물리 경로를 메시지/운영 메타데이터에 저장하지 않는다. 첫 언어는 javascript만 허용한다.

최종 `FinalExecutionResult`: contractVersion/matchId/resultVersion/outcome/reason/scores/recording/snapshot. outcome은 finished/aborted/failed. recording은 status/key/durableThroughSeq와 선택적 receiptStatus다. 실제 저장 상태는 complete/partial/failed로 구분한다. complete는 전량 종료 이벤트까지 fsync 및 파일 rename을 마친 상태이며 큐 접수와 다르다. 정상 결과와 실패의 저장 완결 상태를 별도로 해석한다.

실행 view state는 accepted/prepared/running/closed/failed다. 엔진이 정상 프로토콜로 닫힌 closed에서도 outcome은 aborted/failed일 수 있다. 예상하지 못한 프로세스 종료는 state failed다. 이전 초안의 세분화된 transient 상태/용어 대신 [manifest](../backend/contracts/engine-protocol-v1.json)의 실제 어휘를 사용한다.

## 프레임·수명·중복

envelope: contractVersion=1, matchId, messageId, 선택적 correlationId, type, payload object. 지원 type은 initialize/prepared/start/snapshot/stop/closed/failed/recording-status/ack다. recording-status는 예약된 확장이고 현재 수집 상태는 최종 결과/receipt로 전달한다.

분할·병합 입력을 지원하고 잘못된 길이/버전/필드/UTF-8/중간 EOF를 거부한다. Node decoder iterator는 chunk를 모두 소비한 뒤 다음 chunk를 넣는다. C#/Node 실제 바이트 상호운용 검사를 수행한다.

수락은 동일 matchId/동일 요청 내용에 기존 실행을 반환한다. 다른 내용의 동일 ID나 다른 경기에서 사용한 requestId는 409다. 공개 API의 선택적 UUID `Idempotency-Key`는 소유자 범위에서 같은 게임을 반환하며 상충 본문은 409다. 시작/중단은 상태 전이로 중복 실행을 막는다. correlationId는 prepared/start ack 진단에 사용하며 원본 명령의 재전송 ledger로 사용하지 않는다.

제어 큐는 32개, 화면은 미전송 최신 snapshot 하나로 병합한다. 원본 로그는 이 큐를 거치지 않는다. 관리자의 stdin 쓰기 기한 2초, 준비 대기 20초, 시작하지 않은 준비 게임 30초 만료, 정상 종료 5초와 fallback 정리 기한을 둔다. 정상 500ms 턴 제한에 전체 프로세스 kill을 사용하지 않는다.

플레이어의 계산 완료 즉시 액션을 시작하고 액션 완료 후 다음 판단을 요청한다. 같은 플레이어 호출은 겹치지 않는다. 기존 20ms 엔진 tick의 액션 완료 감지를 유지하며 공통 턴 장벽·고정 판단 지연·논리 시간 보정은 추가하지 않았다. 계산 시간과 IPC 포함 roundTripMs는 별도 수집한다.

## 전량 기록·복구

`EventCollector` → 교체 가능한 storage 계약 → `FileJournalStorage`. 원본 seq는 1부터 연속이고 준비/입력 참조·판단/시간·액션 시작/완료·실제 랜덤 배치가 반영된 world 변경·늦은 응답·종료를 기록한다. 코드 원문을 중복 저장하지 않는다. debug 내용은 소유자만 조회할 수 있는 실행 데이터다.

8MiB 큐에 아직 sync 중인 바이트도 포함한다. 포화/append/sync 실패는 명시적 recording-failure로 경기를 종료한다. 접수한 모든 이벤트를 보존했다고 가장하거나 무제한 큐/침묵 드롭으로 숨기지 않는다. 저장 I/O 완료를 매 턴 기다리는 장벽은 없다.

엔진은 마지막 sync·JSONL rename 후 최종 결과 receipt를 fsync/rename한 뒤 closed를 보낸다. 실행 관리가 요청/status outbox를 보관하고, 운영은 최종 결과 hash와 요약/이전 코드 사본을 멱등 반영한 뒤 ack한다. ack 실패는 운영의 미확인 목록에서 다시 시도한다.

운영 API 재시작은 엔진을 중지하지 않으며 요약을 재반영한다. 실행 관리 재시작은 살아 있던 경기를 자동 재개하지 않는다. 부모 채널 단절 시 엔진은 정리하며, 새 관리자는 완결 receipt가 있으면 같은 결과를 회수한다. 없으면 실패/부분 기록을 확정한다. partial 파일의 완전한 JSONL/연속 seq prefix를 스트리밍 검사하고 불완전 tail을 잘라 sync한다. 메모리 큐에만 있던 이벤트의 호스트 장애 무손실은 보장하지 않는다.

원문/저널의 보유·사용자 전체 삭제·백업 만료와 원격 서비스 인증/TLS는 실제 배포 및 마지막 개인정보 운영 준비에서 확정한다. 파일 어댑터의 로컬 OS 잠금은 다중 호스트 파일 공유 writer 계약이 아니다.
