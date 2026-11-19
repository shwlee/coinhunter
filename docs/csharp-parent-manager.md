# C# 운영용 부모 실행 관리자

작성: 2026-11-19. C3의 시험 드라이버와 별도로 `CoinHunter.Infrastructure/Execution`에 `CSharpHostManager`와 `CSharpHostSession`을 구현하고 실행 관리 서비스에 DI/hosted service로 등록했다. 실제 Node 게임/공개 API가 이 모듈로 C# runner를 생성하는 연결은 C4 이후다. 현재 지원 언어는 JavaScript 하나다.

리뷰 후속: [이름 검증·송신 전 입력 오류 수정](csharp-review-fixes-2026-11-19.md)을 반영했다. null 이름은 invalid-name으로 거절하고 로컬 입력 거절 뒤에는 같은 세션을 유지한다. 부모 확인 수는 37개에서 42개로 확장했다.

## 책임과 API

- `CSharpHostManager.CreateAsync(launch, token)`: 신뢰된 서버의 실행 설정을 받아 자원 예약·프로세스 생성·OS 그룹 배치·허가·준비 검증을 수행한다.
- `CSharpHostSession.MoveNextAsync(map, position, items, token)`: 동시 판단을 하나로 제한하고 시작/종료를 추적한다. 입력 배열 사본을 넘기며 실제 settled 뒤에만 다음 호출을 받는다.
- `StopAsync`: 협조적 중단을 요청한 뒤 실제 프로세스 종료와 전체 OS 그룹 drain을 확인한다. 동시/반복 중단은 같은 종료 작업으로 합친다.
- manager의 `IHostedService.StopAsync`: 새 호스트 생성을 막고 생성 중/실행 중인 모든 세션의 정리를 기다린다. 외부 cancellation만으로 정리 성공을 반환하지 않는다.

부모 모듈은 사용자 assembly를 로드하거나 Roslyn 분석기를 참조하지 않는다. 별도 .NET 호스트와 stdin/stdout·private named pipe로 통신한다. 사용자 소스 경로·host assembly 경로·초기화 값과 예상 source hash는 신뢰된 서버 호출자가 지정해야 한다. 임의 사용자 경로/명령을 받는 공개 실행 API가 아니다.

OS 그룹 예약은 준비 전에 수행하고 실제 배치를 확인한 뒤 `authorize`를 보낸다. 운영/인증/키 환경변수는 자식에게 넘기지 않고 OS/.NET 실행 환경만 허용한다. source hash는 호스트의 UTF-8 원문 내용 해시(C1 기준), 프로필/guard 버전과 준비 결과를 대조한다. 파일 변경 경합을 완전히 막는 불변 artifact/소유권 경로는 C4의 과제다.

호스트는 전달한 플레이어 번호·columns·rows로 초기화한다. C3 시험용 기본값 0/3/3은 기존 시험 명령에서만 유지한다. Windows에서 프로세스와 그룹을 검증했으며 Linux는 아직 실측하지 않았다.

## 감시 정책

`CSharpWatchdogs`를 호출자가 **모두 명시**해야 한다. 모듈에 운영용 grace 기본값이나 자동 재시작 횟수를 숨겨 넣지 않았다.

| 설정                                  | 대상                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| Preparation                           | 프로세스 연결·분석/컴파일·초기화·ready까지의 인프라 준비                      |
| StartNotification                     | 전송/dispatch 후 실행 시작 통보 도착                                          |
| UnsettledExecution                    | 시작 통보 후 실제 settled가 오지 않는 인프라 장애. 반드시 500ms보다 길게 설정 |
| HeartbeatInterval / HeartbeatResponse | 별도 관리 채널의 주기·응답 기한                                               |
| StopGrace                             | stop 요청 뒤 정상 프로세스 종료를 기다리는 기한                               |
| Cleanup                               | OS 그룹 전체 종료·확인 기한                                                   |

실행 계산의 500ms는 계속 호스트 자신의 단조 시계 구간에서 판정한다. 부모의 StartNotification/UnsettledExecution은 IPC/미종료 장애 감시이며 계산 시간을 소급 보정하지 않는다. 정상 guard timeout 결과가 실제 settled로 돌아오면 같은 PID/객체를 재사용한다. 단지 deadline 메시지가 왔다는 이유로 프로세스를 종료하거나 busy를 해제하지 않는다.

호스트가 계산을 끝내지 않으면 부모가 독립적으로 전체 그룹을 종료하고 회수를 확인한다. 호출자에게는 `CSharpHostFailure`를 반환하며 사용자 정상 timeout 결과를 위조하지 않는다. 자동 재생성/재초기화/상태 복원은 하지 않는다. 반복 실패·실격·대체 호스트 정책은 게임/운영 정책에서 후속 결정한다.

## 상태와 장애

상태는 preparing → ready ↔ computing → closing → closed다. 미확인 정리는 cleanup-unconfirmed로 남긴다. 자원 회수를 확인한 세션만 manager 소유 목록에서 제거한다.

| 원인                                                | 분류 예                            |
| --------------------------------------------------- | ---------------------------------- |
| 준비/연결/ready 실패                                | preparation-failed                 |
| 시작 통보 누락                                      | start-notification-missing         |
| 시작했지만 실제 종료 없음                           | execution-unsettled                |
| 관리 응답 없음                                      | control-unresponsive               |
| generation·instance·call·hash·프로필·결과 검증 실패 | protocol-failure                   |
| 프로세스/데이터 채널 종료                           | process-exited / data-disconnected |
| stop 뒤에도 미종료                                  | stop-unsettled                     |
| 실제 회수 확인 실패                                 | cleanup-unconfirmed                |

준비의 Construct/Initialize/GetName 호출 순서, generation·instance·PID·call ID, 500ms 예산/경과 시간·마감 상태, 방향값과 실제 settled를 검사한다. 다른 세션의 결과나 늦은/중복 결과를 현재 판단으로 받지 않는다. 출력/control frame 크기와 JSON 깊이를 제한하고 진단 stderr는 고정 버퍼로 버리며 원문/자격 증명을 로그에 복제하지 않는다.

호스트 종료와 호출 결과 도착이 경합하면 이미 실제 settled로 확인된 결과와 이후 세션 종료를 구분한다. 호출 취소는 해당 세션 전체의 중단/정리를 수행하고, 회수가 확인된 뒤 취소를 완료한다. 정리를 확인하지 못하면 단순 취소 성공 대신 cleanup-unconfirmed를 보고한다.

`CSharpHostClosure`는 종료 원인·강제 정리 여부·CleanupConfirmed를 제공한다. `CSharpHostFailure`도 확인 여부를 보존한다. Dispose/서비스 종료가 미확인 회수를 성공으로 표시하지 않는다. Cleanup failure 시 자원 예약과 세션을 유지하며 새 호출을 거절한다. 실제 OS 권한 오류로 정리를 실패시키는 시험은 이번에 수행하지 않았다.

## 검증

합성 코드·별도 `artifacts/parent-build`·임시 데이터/포트와 실제 Windows OS 그룹으로 부모 모듈 확인 37개를 수행했다. 시험용 watchdog 값은 준비 15초·시작 1초·미종료 900ms·heartbeat 50/500ms·stop 700ms·cleanup 5초이며 일부 장애 시험에서 응답/준비 시간을 더 줄였다. 이 값은 운영 정책 확정값이 아니다.

- timeout→정상 호출 3회에서 PID/generation/instance·필드 보존, 중첩 거절.
- 시작 통보 누락·계산 무기한 정지·관리 채널 무응답·준비 정지·잘못된 generation을 서로 구분하고 실제 프로세스 회수.
- 한 호스트 정지가 다른 호스트를 막지 않음, 늦은 방향을 정상 값으로 수락하지 않음.
- 실행 중 취소·정지한 실행 취소·준비 취소와 source hash 불일치, 프로세스 crash 회수.
- manager 종료와 계산 경합, 반복 Stop의 동일 결과, 종료 후 새 생성 거절.
- 모든 확인된 종료 후 예약 메모리/프로세스와 manager 소유 세션 수 0.

[시험 원본](benchmarks/csharp-parent-manager-2026-11-19.json)에 timeout 관측을 보관한다. 기존 C3의 fault injection은 신뢰된 시험 코드만 설정하는 internal launch 값으로 전달한다. 사용자 코드의 Thread/Sleep/프로세스 접근을 허용한 것은 아니다.

최종 전체 BE 회귀: C1 52건·C2/정책 211개 확인·C3 30개 확인·부모 모듈 37개 확인·기존 .NET 59건·BE 통합 13그룹·프로토콜 5건 통과. 빌드 경고/오류는 0개다. 기존 Node legacy 파일 잠금 EPERM은 이번 변경으로 해결했다고 표시하지 않는다.

재현:

```powershell
$env:COINHUNTER_BUILD_ROOT='artifacts/parent-build'
node scripts/backend.js build
dotnet artifacts/parent-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-manager
```

일반 BE 회귀에도 연결했다. 현재 사용 중인 서버와 실제 계정/알고리즘 파일은 변경하지 않았다.

## 남은 일

1. 운영 사양에서 watchdog/grace·반복 실패 정책을 확정하고 실제 OS별 시계·부모 장애·누적 부하를 검증한다. 절대 500ms 선점 보장이 생긴 것은 아니다.
2. C4에서 불변 source/artifact·허용 경로·owner·hash·lease/캐시와 분리된 준비 프로세스를 연결한다. 현재 host는 준비와 실행을 같은 격리 프로세스에서 수행한다.
3. Node runner/preparer 어댑터와 계정 검사/저장 API를 연결한다. 엔진/플레이어 그룹별 프로필·전체 admission도 실제 혼합 경기에 맞춰 검증한다.
4. native/GC·문자열 등 잔여 중단 관문, Linux cgroup/외부 부모 감독·배포 권한을 검증하고 C5에서 지원 여부를 판정한다.

운영 부모 모듈 등록만으로 C# capability를 활성화하지 않았다. 현재 게임 규칙·JS timeout·사용자 화면의 언어 선택은 그대로다. 커밋/푸시는 수행하지 않았다.
