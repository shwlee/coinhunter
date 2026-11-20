# C# GC 보호 구간 후보 검증

후속: [프로필 v4 사전 할당·전체 호스트 감시·게임 자원 admission](csharp-allocation-admission-2026-11-20.md). 아래 초기 후보의 일부 미완료 경로를 보완했으나 기본 정책 채택·엄격한 500ms 선점은 여전히 미완료다.

- 작성: 2026-11-20. 선행: [직접 호출·지원 준비](csharp-readiness-2026-11-19.md).
- 범위: 500ms 부근의 할당/GC 지연을 줄일 수 있는지 실행 코드와 실제 준비 DLL 호스트로 검증한다.
- 판정: **실험 경로 구현·검증, 기본 적용 보류**. 기존 C# 게임 후보·검사·공개 UI에 자동 적용하지 않았다. C# 공개 지원도 비활성이다.

## 구현

1. [예산 검사](../backend/src/CoinHunter.CSharp.Analysis/ExecutionBudget.cs)에 선택적인 호출별 누적 관리 할당 검사를 추가했다. guard에서 worker 스레드의 할당 증가량을 확인하며 초과는 `operation-limit/call-allocation-bytes`다. 기존 호스트는 이 제한을 설정하지 않는다.
2. [GC 구간 후보](../backend/src/CoinHunter.CSharp.Analysis/CSharpGcWindowCandidate.cs)는 SOH/LOH 예약, 실제 호출, 구간 유효성/종료를 분리한다. 예약 진입·종료 시간도 실제 왕복 비용에 포함해 측정한다. 기한은 기존과 동일하게 실제 호출별 500ms다.
3. 전체 256MiB(SOH/LOH 각각 128MiB) 예약 요청과 worker 32MiB 누적 할당을 시험했다. 이는 실제 프로세스 메모리 사용량·상주 상태·파일 크기 제한과 다르며 사용자 게임의 새 기본 제한이 아니다.
4. 전용 호스트에 내부 `ExperimentalGcWindow` launch와 `--gc-window-probe` 경로를 추가했다. 컴파일은 기존 별도 준비 프로세스에서 끝내고 호스트는 고정된 DLL을 불러온다. 계정/API 요청과 환경 설정에서 이 launch를 켜는 경로는 제공하지 않는다.
5. 호스트는 GC 구간의 모드·generation별 collection 변화와 진입/종료·worker 할당 관측을 전달한다. 부모는 launch 모드와 관측을 대조해 잘못된 결과를 거부한다. 내부 readiness도 기본 GC 시험 모드가 비활성임을 명시한다.

정상 timeout은 이전과 같이 실제 완료 확인 후 같은 PID·Player 객체·일반 필드로 다음 호출을 수행한다. 예약 실패·구간 유실·종료 실패는 `gc-reservation-unavailable`, `gc-window-lost` 등의 인프라 실패로 분리하고 같은 객체의 추가 호출을 거부한다. 사용자 코드를 실행하지 못한 경우를 사용자 timeout으로 표시하거나 자동 재시작/재시도로 숨기지 않는다.

## 검증 방법

[전용 확인 코드](../backend/tests/CoinHunter.Backend.Checks/CSharpGcWindowChecks.cs)는 두 영역을 구분한다.

- 768MiB OS 제한 자식 프로세스의 직접 후보: 예약 실패 주입, 이미 다른 소유자의 GC 구간이 있는 경우, 정상→timeout→정상 상태 유지, 종료 실패, 다른 호스트 스레드의 수집과 구간 교체를 검사한다.
- 실제 컴파일 분리 호스트: 불변 DLL/lease·관리 IPC·독립 watchdog을 그대로 사용한다. 같은 BFS를 기존/시험 각각 50회, 0/128MiB 영속 상태에서 반복 timeout과 499ms 부근 할당을 측정한다. 실제 Player의 영속 메모리는 초기화에서 만들고 호출 중 유지한다.

예약 실패나 구간 유실도 기록하며 실패한 호출을 다시 실행해 통과시키지 않는다. 짧은 경계 연산이 500ms 전에 끝나면 정상 결과를 허용한다. 기한 근처에서 시작했다는 이유만으로 timeout을 요구하지 않는다. 실제 상태와 시간의 일치는 부모가 기존 계약대로 검사한다.

## 관측과 해석

최종 표본·확인 수·전체 회귀는 [검증 JSON](benchmarks/csharp-gc-window-2026-11-20.json)에 보관한다. 현재 PC 한 대의 Windows 표본이며 지연 상한이나 운영 처리량 보장이 아니다.

- 실제 DLL 호스트에서 정상→500ms timeout→정상 호출의 PID·instance·필드를 유지했다.
- 실제 DLL 호스트의 동일 BFS는 기존/시험 각각 50회 모두 정상 반환했다. 예약의 진입·종료를 포함한 왕복 비용도 함께 집계했다.
- 일부 499ms 할당 시험은 새 worker 누적 할당 한도로 먼저 끝났다. 이를 같은 알고리즘에서 timeout만 개선한 결과로 해석하지 않는다. 기존 경로의 해당 32MiB 제한은 여전히 꺼져 있다.
- 컴파일러가 같은 프로세스에 남은 직접 후보에서는 실제 예약 실패와 GC 구간 유실도 관측했다. 실제 준비 DLL 호스트 결과와 분리한다.
- 보호 구간이 유지된 호출에서 GC collection 변화가 0이어도 500ms를 조금 넘기는 timeout 표본은 남는다. native 할당/복사·JIT·스케줄링까지 정확히 선점하는 구현은 아니다.

32MiB 검사는 guard에 도달했을 때의 누적 관리 할당이다. 다음 guard 전 단일 연산의 증가, 명시적/암묵적 초기화 경로, 다른 호스트 스레드와 native 메모리를 모두 사전 차단하는 구현으로 취급하지 않는다. 구간 유효성 확인은 실패를 발견하는 장치이며 그 실패 자체를 예방한다는 보장이 아니다.

## 기본 적용 전에 남은 일

1. 배열 initializer·boxing·문자열/컬렉션 성장 등 guard 사이의 할당 경로와 전체 호스트 할당을 검토한다. 필요하면 사전 예약이나 재사용 allocator를 비교한다.
2. 복잡한 알고리즘에 합당한 누적 할당 정책과 진단/패널티·상태 재사용 규약을 정한다. 현재 시험 한도를 일반 사용자 규칙으로 간주하지 않는다.
3. 플레이어별 GC 예약을 게임 전체 메모리 admission과 함께 측정한다. 1개 호스트에서의 256MiB 예약 성공이 기본 1GiB 게임 scope 안의 C# 4명 예약 성공을 뜻하지 않는다.
4. CPU 제한·다른 게임 부하·장시간 반복에서 진입 실패/구간 유실 빈도와 실제 왕복 분포를 검증한다. 평균 지연만으로 채택하지 않는다.
5. Linux 실제 cgroup/파일·네트워크 격리와 외부 감독, 최종 언어 채택 후 공개 계정 경기·이전 기록·UI 연결을 진행한다.

현재 공개 기능으로 켜지 않았고 강제 종료나 프로세스 재시작을 정상 timeout 처리로 도입하지 않았다. 파일 원문 저장·운영 DB/로그 책임 분리·기존 게임 규칙을 유지한다.

## 재현

```powershell
$env:COINHUNTER_BUILD_ROOT='artifacts/csharp-gc-build'
node scripts/backend.js build
dotnet artifacts/csharp-gc-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-gc
node scripts/backend.js test
```

원본은 `artifacts/csharp-gc-window-report.json`, `artifacts/csharp-prepared-gc-report.json`, 회귀 출력은 `artifacts/csharp-gc-regression.log`에 생성한다. 실제 사용자 서버/계정/코드 설정은 바꾸지 않았다.

근거 API: [TryStartNoGCRegion](https://learn.microsoft.com/en-us/dotnet/api/system.gc.trystartnogcregion?view=net-10.0)은 런타임과 다른 스레드의 할당까지 필요한 SOH/LOH 공간을 확보해야 하며 성공 후에도 종료 성공을 가정할 수 없다. [GetAllocatedBytesForCurrentThread](https://learn.microsoft.com/en-us/dotnet/api/system.gc.getallocatedbytesforcurrentthread?view=net-10.0)는 현재 스레드의 누적 관리 할당이며 살아남은 객체 크기나 native 할당을 뜻하지 않는다. 이 실험의 추가 감시/실패 처리는 해당 API가 자동 제공하는 보장과 구분한다.
