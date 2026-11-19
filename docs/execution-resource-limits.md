# 실행 프로세스 자원 제한 — R0 기반 구현

작성: 2026-11-16. 현재 Windows에서 강제 제한과 실제 게임/검사 연동을 검증했다. Linux cgroup v2 어댑터와 CI 실행 경로는 작성했지만 이 Windows 환경에서 실행하지 않았다. R0 전체나 C# 지원 완료를 의미하지 않는다.

2026-11-19 후속: [C4-C/D 리뷰 수정](csharp-c4cd-review-fixes-2026-11-19.md)에서 게임 전체를 부모 scope로 유지하고 C# 호스트를 하위 Job/cgroup에 포함했다. 자식은 전역 예산을 다시 예약하지 않으며 게임 사용량에 포함된다. Windows 부모 메모리/CPU 제한 상속을 실측했다. 아래 플레이어별 독립 그룹 미구현 설명은 최초 R0 시점의 기록이다.

## 적용 경계와 수명

`CoinHunter.Infrastructure/Resources`의 `ExecutionResources`가 전체 예약량을 관리하고 `IExecutionResourceGroup` 뒤에 OS별 구현을 둔다. 실행 관리 서비스가 사용자 코드 로딩 전에 다음 순서로 연결한다.

1. 게임/검사 admission 이후 그룹의 메모리·프로세스 한도를 예약한다. 전체 한도를 넘으면 429로 거절한다.
2. OS 그룹을 생성하고 한도를 설정한 뒤 실제 값을 다시 읽어 확인한다.
3. 신뢰된 대기 호스트만 시작하고 그룹 소속을 확인한다. 게임은 아직 initialize를 보내지 않으며, 검사 호스트는 stdin의 `start`를 기다린다.
4. 그룹 배치가 확인된 뒤 사용자 코드 로딩·초기화·자식 실행기 생성을 허용한다. 자식은 그룹을 상속한다.
5. 종료·실패·취소 시 그룹 전체를 종료하고 실제 비어 있음을 확인한 다음 예약을 반환한다.

설정/배치 실패는 실행 실패다. 제한 없는 실행으로 되돌아가지 않는다. 서비스 시작 시에도 빈 검사 그룹의 생성·설정·정리를 확인하며 실패하면 readiness를 통과하지 못한다. 관측 실패가 실제 종료 시도를 건너뛰지 않도록 했다.

정리를 확인하지 못하면 예약과 실행 슬롯을 유지하고 `cleanup-unconfirmed`로 남긴다. 결과 확인 API는 503을 반환하며 정리 완료로 표시하지 않는다. 이 상태는 자동 재시도/예약 회수 대신 운영 점검·서비스 재시작이 필요한 경로다.

## 그룹과 기본 설정

현재 그룹 단위는 **게임 전체(엔진 1개와 최대 플레이어 4개)** 또는 **검사 프로세스 트리**다. 플레이어별로 독립 Job/cgroup을 생성한 것은 아니다. 한 그룹의 자원 초과가 같은 게임의 다른 플레이어에도 영향을 줄 수 있다. 향후 C# 준비/컴파일·플레이어별 호스트·예비 호스트는 별도 프로필과 예약을 연결해야 한다.

.NET 설정 키는 `Backend:Resources:*`, 환경변수는 `Backend__Resources__*`다. 실행 도구의 로컬 `.env`에도 아래 이름으로 넣을 수 있다.

| 환경변수 접미사       | Windows 기본 | Linux 기본 | 의미                                                  |
| --------------------- | ------------ | ---------- | ----------------------------------------------------- |
| `GameMemoryMiB`       | 1024         | 1024       | 게임 그룹 메모리 한도                                 |
| `ValidationMemoryMiB` | 512          | 512        | 검사 그룹 메모리 한도                                 |
| `GameProcesses`       | 5            | 256        | Windows 프로세스 / Linux 스레드 포함 task 한도        |
| `ValidationProcesses` | 3            | 128        | 검사 그룹 프로세스/task 한도                          |
| `GameCpuRate`         | 2500         | 2500       | CPU 상한, 10000이 기준 CPU 용량 전체                  |
| `ValidationCpuRate`   | 1250         | 1250       | 검사 CPU 상한                                         |
| `TotalMemoryMiB`      | 6144         | 6144       | 실행 관리 서비스의 그룹 메모리 예약 총합 상한         |
| `TotalProcesses`      | 32           | 1536       | 그룹 프로세스/task 예약 총합 상한                     |
| `CgroupRoot`          | 미사용       | 필수       | 관리자가 위임한 `/sys/fs/cgroup/` 아래 전용 하위 경로 |

예: `Backend__Resources__GameMemoryMiB=1024`. 예약은 설정된 그룹 한도 전부를 계산하는 admission 장부이며 물리 메모리를 미리 확보하지 않는다. 운영 API·실행 관리 서비스 자체·FE·OS·파일 캐시의 여유 메모리는 별도로 산정해야 한다. CPU는 상한이며 전용 코어 할당이나 게임별 최소 성능 보장이 아니다. Linux CPU 환산은 실행 서비스의 `Environment.ProcessorCount`를 사용하므로 컨테이너/부모 cgroup의 제약과 함께 검증해야 한다.

기존 QuickJS의 플레이어별 32 MiB guest heap 한도는 별도다. Node/V8·엔진·native allocation 등 프로세스 전체 자원은 이번 그룹 한도로 관리한다. CPU 상한은 호출별 500ms 경과 시간 검사와 별개이며 독립 턴 정책을 변경하지 않는다.

## OS 어댑터

### Windows — 실제 검증

이름 없는 비상속 Job handle에 `JOB_OBJECT_LIMIT_JOB_MEMORY`, `ACTIVE_PROCESS`, `KILL_ON_JOB_CLOSE`와 CPU hard cap을 적용한다. 그룹 소속과 설정 readback을 확인하고 자손 수가 0이 될 때까지 종료를 확인한다. 실행 관리 프로세스가 비정상 종료해 마지막 Job handle이 닫혀도 자손을 종료한다.

메모리 수치는 Job의 **private committed memory**다. 작업 관리자의 working set/RSS와 같은 값으로 해석하면 안 된다. 한도 도달 시 할당 실패 등으로 나타날 수 있으므로 원인 불명 종료를 메모리 초과로 추정하지 않는다. [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [메모리 제한 구조](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information), [CPU rate 제어](https://learn.microsoft.com/en-us/windows/desktop/api/winnt/ns-winnt-jobobject_cpu_rate_control_information).

### Linux — 구현 후보, 실측 관문 미통과

위임된 cgroup v2 subtree 아래 `coinhunter-{ExecutionRoot 해시}-{GUID}` 그룹을 만들고 `memory.max`, `memory.swap.max=0`, `memory.oom.group=1`, `pids.max`, `cpu.max`를 설정·확인한다. `cgroup.kill` 지원이 필수이며 생성/이동/종료/삭제 권한이 없으면 시작을 거부한다. 애플리케이션이 mount root의 controller나 권한을 변경하지 않는다.

정상 정리는 `cgroup.kill` 이후 `populated 0`을 확인한다. 재시작은 ExecutionRoot의 exclusive writer lease 아래 같은 해시와 GUID 형식에 맞는 잔존 그룹만 정리한 뒤 새 요청을 받는다. 타 ExecutionRoot의 그룹은 회수하지 않는다.

`pids.max`는 스레드도 세므로 Windows와 숫자를 맞추지 않는다. `memory.peak`가 없으면 `memory.current`를 반환하고 accounting 이름으로 구분한다. **`oom_kill` 증가를 확인한 경우에만** 게임 종료 원인을 `resource-memory-limit`로 분류한다. 신뢰된 호스트를 이동하기 전에 할당한 페이지가 원래 cgroup에 과금될 수 있으므로 프로세스 전체 RSS와 정확히 같은 한도라고 주장하지 않는다. [커널 cgroup v2 문서](https://www.kernel.org/doc/html/v6.7/admin-guide/cgroup-v2.html).

Linux cgroup은 부모 서비스 종료만으로 즉시 자손이 죽는 Windows kill-on-close 보장을 제공하지 않는다. 현재 Node 호스트의 채널 단절 처리와 재시작 시 고아 회수 경로가 있지만, **native C# 활성화 전 systemd/컨테이너 등 외부 수명 감독과 부모 장애 시 전체 종료를 실제 검증해야 한다.** 이 부분을 구현 완료로 간주하지 않는다.

GitHub Actions의 Linux BE job에 격리된 CI VM용 cgroup 준비를 추가했다. 이 작업에서 해당 workflow를 실행하지 않았다. CI의 sudo 실행은 테스트 준비용이며 운영 서비스를 root로 실행하는 배포 지침이 아니다. 운영에서는 전용 서비스 계정과 위임 설정을 준비해야 한다.

## 내부 관측과 실패

- 내부 Bearer 인증이 필요한 `GET /internal/v1/resources`: 어댑터·예약 합계/상한·프로세스 단위. 공개 사용자 API가 아니다.
- 내부 게임 조회의 `resourceUsage`: 종료 직전 관측값·메모리 accounting·한도·CPU rate. 관측 실패 시 null이며 종료 확인과 분리한다.
- 전체 예약 초과: 429. 정리 미확인: `resource-cleanup-unconfirmed` 및 확인 요청 503. 확인된 Linux OOM kill: `resource-memory-limit`.
- 위 두 인프라 실패는 정상 경기 히스토리로 반영하지 않는다. 부분 JSONL 회수는 기존 경로를 유지한다.

이 계층은 파일·네트워크·자격 증명을 차단하는 보안 sandbox가 아니다. 향후 native 언어에는 최소 권한, 파일/네트워크 접근 통제와 컴파일 격리가 별도로 필요하다. 기존 JS의 QuickJS capability 경계는 유지한다.

## 검증과 재현

실제 사용자 데이터·이미 실행 중인 서버는 유지하고 합성 코드/별도 데이터·빌드/포트에서 검증했다.

| 검증                   | 결과                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| .NET 계약/업무/OS 검사 | 35 + 19 + 5 = 59건 통과                                                                                                                  |
| Windows OS 직접 시험   | 예약 초과 거절, native 메모리 할당 거절, 추가 프로세스 생성 제한, 자손 상속/전체 종료, CPU hard cap 통과                                 |
| 분리 BE / 프로토콜     | 13그룹 / 5건 통과                                                                                                                        |
| 저장·검사 / lifecycle  | 6그룹 / 3그룹 통과                                                                                                                       |
| 실제 자원 admission    | 내부 인증·게임/검사 중첩 예약·검사 종료와 게임 종료 후 예약 0 확인                                                                       |
| 동시 부하/장애         | 4게임·16실행기, 엔진 장애, 실행 관리 재시작, Windows 부모 강제 종료 시 엔진 1개·실행기 4개 종료 확인                                     |
| Node 회귀              | 직렬 실행 291건 중 290건 통과. 기존 다중 프로세스 계정 파일 잠금의 EPERM 1건 재현. 해당 테스트·새 gate 시험 포함 분리 재실행은 28건 통과 |

Node 동시 실행 수 2의 첫 전체 회귀에서는 같은 파일 잠금 오류와 기존 AI timeout 시험이 실패했다. 분리 재실행은 통과했지만 전체 직렬 회귀의 파일 잠금 오류가 남아 있어 전체 Node 회귀 성공으로 표시하지 않는다. 이번 자원 제한과 무관한 기존 경로이며 별도 수정이 필요하다.

CPU 시험은 이 16 logical CPU Windows PC에서 낮은 Job cap 아래 2초 wall time 중 약 0.6초 CPU 사용을 확인했다. 이 수치를 사내 서버의 처리량 보장으로 사용하지 않는다. [R0 부하 원본](benchmarks/resource-limits-r0-2026-11-16.json)에 관측 조건과 결과를 보관한다.

재현 명령: `npm run backend:test`, `npm run backend:test:resources`, `npm run backend:test:validation-lifecycle`, `node scripts/backend-load-smoke.js`. 서버 DLL 잠금이 있으면 `COINHUNTER_BUILD_ROOT=artifacts/r0-build`처럼 별도 산출 경로를 지정한다. Linux 실행에는 먼저 위임된 `Backend__Resources__CgroupRoot`가 필요하다.

## 남은 순서

1. Linux 실제 OS 제한/동시 부하/부모 장애/고아 회수 관문과 운영 위임·외부 감독 검증.
2. C# C1 Roslyn 규약 분석기·승인 API 프로필, 별도 제한된 준비/컴파일 경로.
3. C2 자동 예산 검사와 동일 객체 재호출 검증, C3 시간 계약·정리 유예/교체 정책 확정.
4. 채택된 언어만 공통 검사/저장·실행 registry에 연결.

이번 변경은 C# 사용자 소스를 실행하거나 새 언어를 등록하지 않는다. 정상 JS timeout에서 프로세스를 유지하는 기존 정책과 빠른 계산이 바로 액션으로 이어지는 규칙도 유지한다.
