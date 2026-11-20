# C# 사전 할당 검사·게임 단위 GC 예산 검증

- 작성: 2026-11-20. 선행: [GC 보호 구간 후보](csharp-gc-window-candidate-2026-11-20.md).
- 범위: guard 사이의 주요 할당 경로 보완, worker 외 호스트 할당 감시, 여러 GC 실행기의 게임 전체 자원 admission.
- 상태: 후보 프로필 v4 구현. GC/누적 할당 제한은 기본 비활성이고 C# 공개 지원은 계속 비활성이다. 실제 서비스의 게임 메모리 기본값을 늘리지 않았다.

## 할당 전에 검사하는 경로

[Rewriter](../backend/src/CoinHunter.CSharp.Analysis/BudgetRewriter.cs)와 [host 연산](../backend/src/CoinHunter.CSharp.Analysis/CheckedOperations.cs)을 보완했다.

| 경로                                          | 변경                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `new T[n]`                                    | 요소 크기와 header/alignment의 보수적 상한을 이용해 할당 전에 잔여 예산 검사                                     |
| `new T[n]{...}`, `new T[]{...}`, `new[]{...}` | 배열 생성 및 initializer 평가 전에 검사. 원래 상수 크기 규칙·값 평가 순서를 유지                                 |
| `T[] a={...}`                                 | 명시적인 생성 표현으로 변환해 같은 검사를 적용. 필드 초기화도 포함                                               |
| 컬렉션 생성/확장                              | 생성 요청과 실제 capacity를 확인하고 성장 가능 시 보수적 예산 검사. 거절된 Add/Enqueue는 원본 상태를 바꾸지 않음 |
| 문자열 연결·debug 숫자 출력                   | generic host bridge를 이용해 인자 전달 단계의 boxing을 피하고 host 내부 formatting/boxing/buffering 전에 검사    |

배열 initializer에서 호출하는 사용자 함수가 거절 전에 실행되지 않는지, 정상 코드의 평가 순서/반환값과 null·여러 스칼라 타입이 유지되는지 검사했다. header 64bytes, 컬렉션의 여유 배수 등은 보수적인 검사 추정이며 실제 allocator의 정확한 객체 크기나 수학적 상한 증명이 아니다.

프로필은 [v4 명세](../backend/contracts/csharp-bounded-profile-v4.json)의 `csharp-restricted-c1-v4`, analyzer `c1-5`, guard `c2-poll-bounded-v4`다. 과거 v3 자료는 당시 기록으로 보존한다. 새 toolchain/reference fingerprint로 이전 DLL/검사 결과와 구분하며 공개 언어 선택을 활성화하지 않는다.

## 전체 호스트의 관리 할당

기존 worker 스레드의 시험 한도 32MiB 외에, 현재 시험 정책에는 프로세스 전체 관리 할당 증가 한도 64MiB를 둔다. guard에서 빠른 카운터를 확인하고 구간 종료 시 정확한 카운터로 다시 확인한다. 마지막 사용자 guard 이후 다른 호스트 스레드가 할당하는 경우도 검사한다.

전체 호스트 예산 초과는 `gc-host-allocation-budget` 인프라 실패다. 사용자 timeout/사용자 코드 규약 위반으로 바꾸지 않고 해당 객체의 추가 호출을 거부한다. 예약/구간 유실에 대한 기존 실패 처리도 유지한다. 이 값은 시험 정책이며 일반 게임의 새 사용자 메모리 제한이 아니다. source 파일 크기 제한을 추가하지 않았다.

관리 할당 카운터는 native 메모리가 아니며 빠른 프로세스 카운터의 반영 지연과 검사 사이의 다른 스레드 할당은 남는다. OS 자원 제한과 실제 GC 구간 유효성 검사를 계속 병행한다.

## 게임 전체 자원 admission

[CSharpGcGameAdmission](../backend/src/CoinHunter.Infrastructure/Execution/CSharpGcGameAdmission.cs)은 GC 시험 실행기에서만 사용하는 불변 계획이다.

- 실제 부모 OS scope의 메모리/CPU/프로세스 한도와 전달받은 설정을 대조한다.
- 엔진과 모든 실행기의 OS 메모리/프로세스 한도를 합산해 부족하면 프로세스를 띄우기 전에 거절한다. 단순히 GC 예약량만 더하지 않는다.
- 부모의 기존 전역 예약 안에서 자식 scope를 만든다. GC/자식 예약을 전역 예산에 중복 합산하지 않는다.
- 엔진 scope를 먼저 확보하고, 참여자별 launch는 게임 수명 동안 한 번만 소비한다. 중복 사용·다른 scope/한도·정지한 객체의 조용한 재시작을 거부한다.
- admission은 예약 성공에 필요한 조건이며 CLR의 단편화/실제 heap 상태까지 보장하지 않는다. 실패하면 기존 실제 종료·lease/자원 회수 규칙을 적용한다.

## 실측 조건과 결과

[전용 검증](../backend/tests/CoinHunter.Backend.Checks/CSharpGcGameAdmissionChecks.cs)은 엔진 역할의 scoped Node fixture와 실제 준비 DLL을 사용하는 C# 호스트 4개를 실행한다. 게임 규칙/화면까지 포함한 새로운 GC 경기 모드를 구현한 시험은 아니다. 각 알고리즘은 초기화에서 128MiB의 영속 배열을 만들고 유지한다.

| 조건                                      | 관측                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 부모 1GiB, 엔진 256MiB + C# 4×512MiB 계획 | 합산 예산 부족으로 사전 거절. 이때 컴파일/Player 호스트는 시작하지 않음                           |
| 부모 2,304MiB, 엔진 256MiB + C# 4×512MiB  | 호스트 생성은 가능했으나 모두 `gc-reservation-unavailable`. 사용자 결과로 위장하지 않고 실제 회수 |
| 부모 3,328MiB, 엔진 256MiB + C# 4×768MiB  | GC 호출 동시 진행. 한 명의 500ms timeout 중 나머지 3명은 독립 진행, 같은 객체로 후속 호출 유지    |

후자의 큰 예산은 시험 조건이며 배포 권장 용량·서비스 기본값 변경이 아니다. 실패 조건도 최종 JSON에 보존한다. 런타임의 실제 메모리 사용과 GC 예약 가용성은 OS/부하/배치에 따라 달라진다. 원시 관측·검사 수와 최종 회귀는 [검증 JSON](benchmarks/csharp-allocation-admission-2026-11-20.json)을 참고한다.

Windows 중첩 Job의 원시 `ActiveProcesses` 관측에는 실제 참여 PID 5개보다 큰 값이 나타났다. 이를 고유한 실제 프로세스 수로 해석하지 않는다. 별도로 Node 1개·C# 4개의 서로 다른 PID가 동시에 살아 있는지 확인하고, 부모에 여섯 번째 실제 프로세스를 넣었을 때 OS가 quota 오류(1816)로 거절하는지 검증했다. 종료 후 실제 drain·전역 예약 0도 확인했다. 원시 카운터를 운영 지표로 제공할 때는 의미를 추가 정리해야 한다. [Windows 중첩 Job의 집계 설명](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)을 참고하되, 이번 카운터 차이의 원인을 문서만으로 확정하지 않는다.

| 최종 검증                                      | 결과                                               |
| ---------------------------------------------- | -------------------------------------------------- |
| 전체 BE 회귀                                   | 통과. 운영/실행 통합 13그룹·프로토콜 통합 5건 포함 |
| C# budget                                      | 287건 통과. 새 사전 할당/평가 순서 검사 54건 포함  |
| GC 후보 / 실제 준비 DLL·IPC                    | 각각 170건 / 236건 통과                            |
| 게임 단위 admission·동시 호출·OS process quota | 110건 통과                                         |
| Node 실행기 관련 회귀                          | 43건 통과                                          |
| 마지막 빌드                                    | 경고·오류 0개                                      |

전체 회귀 이후 추가한 검사는 실제 PID/OS process quota 대조이며 제품 코드 변경은 없다. 해당 검사는 다시 빌드한 최종 assembly로 별도 통과했다. 모든 검증은 격리된 `artifacts` 경로에서 수행했다.

## 남은 판정

- 위 경로 보완을 모든 native/JIT/암묵적 할당의 선점 보장으로 해석하지 않는다. GC 없이도 실제 완료가 500ms를 약간 넘는 기존 한계는 남는다.
- 추정 예산에 따른 거절과 실제 할당 한도·사용자 진단/상태 재사용 정책을 평가해야 한다. 큰 입력/정교한 알고리즘과 장시간 혼합 게임 부하에서도 검증한다.
- Node 직접 턴 채널을 포함한 실제 GC 게임/기록 계약, 메모리 사양별 admission 정책과 배포 자원 계획을 정리한다. 현재는 내부 호스트/IPC 시험 경로다.
- Linux cgroup·파일/네트워크 격리·외부 감독과 공개 C# 계정/기록/UI 연결은 미완료다.

## 재현

```powershell
$env:COINHUNTER_BUILD_ROOT='artifacts/csharp-allocation-build'
node scripts/backend.js test
dotnet artifacts/csharp-allocation-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-gc
dotnet artifacts/csharp-allocation-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-gc-admission
```

사전 할당/평가 순서 검사는 C# budget의 OS 제한 자식에도 포함한다. 실제 사용자 서버·계정·코드 설정은 변경하지 않았다.

참고: [Queue.EnsureCapacity](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.queue-1.ensurecapacity?view=net-10.0), [HashSet 구현](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Collections/Generic/HashSet.cs). host가 capacity 0 조회로 현재 backing capacity를 확인하며 사용자 프로필에 해당 API를 새로 허용한 것은 아니다.
