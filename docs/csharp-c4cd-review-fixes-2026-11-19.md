# C4-C/D 적대적 리뷰 3건 수정

작성: 2026-11-19. 기준 커밋은 `451b4db`, 발견 당시 원인은 [적대적 리뷰](csharp-c4cd-adversarial-review-2026-11-19.md)에 보관했다. **H1·M1·M2를 수정하고 동일 조건의 회귀 검증을 추가했다.** C# 공개 지원은 계속 비활성이며 실제 사용자 데이터/서버는 변경하지 않았다.

## H1 — 게임 전체의 자원 범위

`IExecutionResourceGroup.CreateChild`로 게임의 하위 실행 범위를 만들고 C# 호스트 생성 시 `ParentResources`를 전달한다. 게임용 호스트는 검사용 독립 예약을 재사용하지 않는다.

```text
게임 전체 예약 1개 / 부모 OS scope
  ├─ Node 엔진 + 기존 JS 실행기
  ├─ C# 플레이어 하위 scope → Player 프로세스
  └─ 다른 C# 플레이어 하위 scope → 독립 Player 프로세스

컴파일러·사전 실행 검사 → 별도의 검사 자원 예약
```

- 부모의 메모리·CPU·프로세스/태스크 한도에 모든 실행기가 포함된다. 게임의 사용량 조회도 부모의 전체 회계 값을 사용한다.
- 자식 범위에는 전역 예약을 추가하지 않는다. 부모가 확보한 게임 예산 안에서 배치한다.
- C# 하위 메모리는 게임 한도와 768 MiB 중 작은 값, 프로세스/태스크는 게임 한도와 플랫폼별 호스트 한도 중 작은 값을 사용한다. 부모 한도를 넘는 자식 설정은 거절한다.
- Windows는 부모 Job에 먼저 배치한 뒤 자식 Job에 배치하며 승인 전에 소속을 확인한다. 자식 CPU rate 10000은 **부모 CPU 허용량을 전부 사용할 수 있다는 뜻**이다. 부모가 1000인데 자식도 1000으로 설정해 부모 허용량을 다시 10%로 줄이지 않는다. 부모의 전체 hard cap은 그대로 적용된다. [중첩 Job](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs), [중첩 CPU 비율](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information).
- Linux는 새로 소유한 scope 내부에만 controller를 활성화하고, 엔진/실행기는 `main` leaf에 배치한다. 부모 cgroup은 비워 두고 하위 범위의 메모리/CPU/pids를 합산한다. 관리자가 위임한 root의 controller/권한을 변경하지 않는다. `pids.current`로 스레드 포함 사용량을 보고하며 재시작 회수는 소유한 하위 디렉터리를 비운 뒤 제거한다. [cgroup v2의 controller·내부 프로세스 제약](https://docs.kernel.org/admin-guide/cgroup-v2.html).
- 종료가 시작된 부모에는 새 자식 생성/프로세스 배치를 허용하지 않는다. 자식 실제 종료와 범위 반환을 확인한 뒤 부모 예약을 반환한다. 회수 확인 실패는 기존처럼 예약/lease를 유지한다.

Windows 실제 회귀에서 C# PID의 부모 Job 소속, 게임 예산의 단일 전역 예약, 프로세스 한도 1에서 추가 C# 호스트 진입 거절을 확인했다. 별도 중첩 Job 시험은 부모가 보유한 80 MiB와 자식 native 할당을 합산해 메모리를 제한하는지, 자식이 부모 CPU hard cap을 받는지를 확인한다. Linux는 코드/빌드 반영이며 실제 위임·권한·중단/복구는 이 Windows 환경에서 실행하지 않았다.

## M1 — 검사 시도별 결과 갱신

계정 메타데이터에 내부 `validationAttempt`를 추가했다. 원문 파일·저장 revision과 별개로, 서버가 검사 시도를 예약할 때 UUID를 만든다.

1. `BeginValidation`은 owner/language/revision/sourceKey/sourceHash를 확인한 뒤 새 시도를 원자적으로 예약한다.
2. 정상 결과·실패·취소·큐 포화·종료 finally의 상태 갱신은 같은 시도 ID가 현재 값일 때만 허용한다.
3. 수동 검사는 계정별 gate 안에서 시도를 예약하고 결과를 반영한다. 백그라운드 검사는 큐 입장에서 예약한 시도에만 결과를 반영하며, 이미 대체된 작업은 시작 전에도 확인한다.
4. 중복 큐 요청은 같은 소스 작업으로 구분해 새 시도로 덮어쓰지 않는다. 새 저장·stale/pending 복구에서는 이전 시도 ID를 무효화한다.
5. 수동 검사 취소/환경 실패는 여전히 현재 시도일 때 `unverified`로 정리한다. 이후 오래된 작업이 passed로 되돌릴 수 없다.

시도 ID는 `JsonData.Metadata`에서 제거하므로 목록·편집기·소스 메타데이터 헤더에 추가하지 않는다. 코드 원문은 파일에 유지한다. 계정 DB로 전환할 때는 기존 코드 버전 조건과 **시도 ID 조건을 같은 원자적 갱신**에 포함해야 한다.

이전 재현처럼 오래된 백그라운드 쓰기를 저장소 진입 전에 지연한 뒤 최신 수동 실패를 저장해도, 이전 쓰기는 거절되고 최신 checkedAt/진단이 유지되는 것을 확인했다. 취소된 최신 시도도 pending으로 남거나 과거 통과로 복구되지 않는다.

## M2 — 실제 종료와 private 파일 정리 분리

게임 종료는 실제 Node/C# 자원이 모두 회수됐는지로 판정한다. 그 후 private 파일 삭제가 실패해도 이미 확인한 프로세스 종료나 경기 슬롯 반환을 되돌리지 않는다.

- 내부 게임 상태에 `privateCleanupPending`을 보관한다. 삭제 실패를 성공으로 숨기지 않는다.
- 하나의 유지 작업이 1초 간격으로 종료된 경기의 삭제를 재시도하고 상태를 저장한다. 실행 중이거나 자원 회수가 미확인인 경기는 삭제 대상이 아니다.
- 시작 복구에서도 잠긴 파일은 정리 대기로 기록하고 서버 진입을 막지 않는다. 잠금 해제 후 다시 삭제한다.
- 유지 작업과 종료/ack가 같은 status 파일을 동시에 오래된 내용으로 덮지 않도록 저장을 직렬화했다. 유지 작업은 writer lease를 반환하기 전에 중단한다.
- 종료된 게임의 C# 중계 참조는 제거한다. 미확인 회수의 참조/lease는 유지한다.

Windows에서 private 파일을 삭제 공유 없이 연 채 stop을 호출해 **closed, 호스트 0, 슬롯 반환, 정리 대기**를 확인했다. 파일이 잠긴 동안 다른 4경기 준비가 가능했고, 잠금 해제 후 파일·정리 대기 상태가 사라졌다. 실행 관리자 재기동 시에도 잠긴 잔여 파일을 보존하고 나중에 삭제하는 것을 확인했다.

## 검증

[최종 수정 회귀 원본](benchmarks/csharp-c4cd-review-fixes-2026-11-19.json).

- 세 결함 회귀 20건: 실제 C# Job 소속/예약/프로세스 한도, 검사 시도 경합·취소·원문 보존, 파일 잠금·4경기 진입·재시작 정리.
- OS 자원 검증 7건: 기존 5건에 중첩 메모리·CPU 확인 2건을 추가했다.
- 기존 C1 62·C2 223·C3 30·부모 42·C4-A 33·C4-B 53·C4-C 40·C4-D 30건, .NET 계약 35·업무 19건, BE 통합 13그룹·프로토콜 5건의 최종 전체 회귀가 통과했다.
- 최종 빌드 경고·오류는 0개다. Linux 실제 실행과 기존 Node 레거시 파일 잠금 EPERM은 이번 수정으로 해결한 것으로 표시하지 않는다. Node 소스는 변경하지 않았다.

```powershell
$env:COINHUNTER_BUILD_ROOT='artifacts/c4-fixes-build'
node scripts/backend.js test
# 빌드 후 수정 3건만:
dotnet artifacts/c4-fixes-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . c4-review-fixes
```

IPC 중계 비용·native/GC 중단·Linux 배포/부모 장애 감독·정식 언어 활성화 관문은 그대로 남는다. 커밋 상태와 최신 작업 범위는 [진행 결과](progress.md)에서 확인한다.
