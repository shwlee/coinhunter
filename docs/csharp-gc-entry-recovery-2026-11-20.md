# C# GC 진입 복구: 원인 분석·수정·검증

- 대상: [실제 게임 부하](csharp-gc-actual-games-2026-11-20.md)에서 약 96~97초에 발생한 `gc-reservation-unavailable`.
- 범위: 동일 메모리 한도에서 진입 정책 비교, 명시적인 1회 복구 후보 구현, 실제 게임 재검증. C# 공개 지원과 GC 기본 설정은 계속 비활성이다.
- 계약: [GC 진입 v2](../backend/contracts/csharp-gc-entry-recovery-v2.json). [원시 측정·최종 회귀](benchmarks/csharp-gc-entry-recovery-2026-11-20.json).

## 확인한 원인과 근거

호스트 OS 한도를 늘리지 않고 같은 준비 DLL·128MiB 영속 상태·턴당 64KiB 할당을 사용했다. 비교 모드마다 새 호스트를 시작하며, 각 모드 안에서는 같은 인스턴스를 유지한다.

기존 `TryStartNoGCRegion(..., true)` 제어군은 약 1,550회에서 예약이 실패했다. 문서상 추가 전체 수집을 허용하는 `false` 인자로 재시도해도 실패했다. 이때 관리 메모리 추정량은 약 290MiB에서 129MiB로 줄었지만, 마지막 GC의 커밋 메모리는 약 569MiB로 관측된 가용 한도 576MiB 근처에 남았다. 따라서 살아 있는 사용자 객체의 증가만으로 설명할 수 있는 문제가 아니다.

압축과 decommit을 요청한 별도 비교군에서는 마지막 GC의 커밋 메모리가 약 129MiB였고 같은 예약으로 계속 진행했다. 반복 NoGC 진입·할당과 hard limit 아래의 커밋 영역 보유/공간 배치가 예약 실패에 관여한다는 실측 근거다. 정확히 어느 세그먼트가 실패했는지 덤프로 입증한 결과나 모든 CLR/OS에 대한 원인 증명으로 확대하지 않는다.

`GetTotalMemory(false)`는 현재 관리 메모리 추정이고 `GetGCMemoryInfo`의 heap/commit 값은 마지막 GC 시점이다. 서로 다른 시점의 값이며 OS RSS와도 다르다. 실패한 일반 수집 비교와 성공한 압축·반환 비교는 각각 새 프로세스에서 측정했다.

[TryStartNoGCRegion](https://learn.microsoft.com/en-us/dotnet/api/system.gc.trystartnogcregion?view=net-10.0)의 예약/수집 옵션, [Aggressive 수집](https://learn.microsoft.com/en-us/dotnet/api/system.gccollectionmode?view=net-10.0)의 메모리 반환 요청, [GC 한도 설정](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/garbage-collector)을 참고했다. [런타임 구현](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/gc/gc.cpp)은 NoGC용 SOH/LOH 공간 확장·커밋 경로를 확인하는 보조 자료이며 측정한 10.0.12 바이너리의 정확한 소스 대응을 주장하지 않는다.

## 구현한 정책

1. 기존 방식으로 예약한다. 성공하면 곧바로 알고리즘을 호출한다.
2. 예약이 `false`이고 내부 복구 옵션이 켜져 있으면 활성 NoGC 구간이 없는지 다시 확인한다.
3. `GC.Collect(MaxGeneration, Aggressive, blocking:true, compacting:true)`를 명시적으로 한 번 요청한 뒤, 예약을 한 번만 더 시도한다.
4. 예약 성공 뒤에만 알고리즘을 한 번 호출한다. 두 번째 실패나 진입 예외는 인프라 실패로 끝낸다. 사용자 코드 재실행·프로세스 재시작·보호 없는 대체 실행은 없다.

“1회 복구”는 명시적인 복구 요청 횟수다. 런타임의 실제 수집은 진입 전체에서 여러 번 관측될 수 있으며 세대별 차이를 그대로 기록한다. 알고리즘 실행 구간 안의 수집 차이는 계속 0이어야 한다.

`entryMs`에 예약·압축·반환 비용을 포함하고, 실제 요청 왕복과 액션 시작 지연에도 그 비용을 남긴다. 500ms는 알고리즘 호출 판정 구간이고 전체 요청 시간이 아니다. 진입이 오래 걸리면 기존 부모 시작 감시가 인프라 장애로 종료한다. 다른 플레이어를 기다리게 하거나 시간을 보정하지 않는다.

실행 시 내부 설정 `Backend:CSharpGameCandidate:GcEntryCollection=true`와 기존 GC 후보 설정이 모두 필요하다. 기본값은 false다. 수락할 때 설정을 고정하고 호스트 readiness·부모 판정·Node 관측에서 같은 정책인지 대조한다. 일반 게임·preflight는 변경하지 않았다.

## 검증

- 실제 준비 DLL 반복 호출: 제어군은 예약 실패를 재현했고 복구군은 10,000회와 정상→timeout→정상 상태 유지를 확인했다. 초기 비교에서는 복구 6회, 약 21ms 진입 비용을 관측했다.
- 실제 최대 맵 40×30의 게임 2개(C# 4명·JS 2명): 기존과 같은 호스트/게임 메모리 예산으로 180초 목표를 통과했다. 약 182.96초 동안 15,972턴·GC 관측 10,583개·진입 복구 4회를 남겼고 최대 복구 진입 시간은 약 22.33ms였다.
- 예외·할당 한도 초과는 종료하고 정상 timeout은 같은 객체를 유지했다. 복구로도 예약할 수 없는 낮은 호스트 한도 조건에서는 인프라 사유를 JSONL/최종 결과에 보존하고 실제 자원을 회수했다.
- 복구 실패/진입 예외에서 사용자 코드를 실행하지 않는지, 성공 시 한 번만 호출하는지, 불완전한 실패 관측을 정상 관측과 구분하는지 별도 검사한다.
- 전체 BE/Node·GC 후보/실제 DLL 회귀와 최종 체크 수는 검증 JSON에 보관한다. 이전 레거시 파일 잠금의 간헐 EPERM은 별도 기존 문제이며 이번 수정으로 해결했다고 표시하지 않는다.

로컬 반복 예약 문제를 해결한 후보이며, 분 단위 시험만으로 운영 장시간 용량이나 정확한 500ms 선점을 보장하지 않는다. Linux 격리·배포 부하·공개 계정/경기/UI 연결은 후속이다.

## 재현

```powershell
$env:COINHUNTER_BUILD_ROOT='artifacts/csharp-gc-recovery-build'
node scripts/backend.js test
dotnet artifacts/csharp-gc-recovery-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-gc-recovery
dotnet artifacts/csharp-gc-recovery-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-gc-recovered-games
```

과거 실패 측정은 이전 문서/JSON에 그대로 남긴다. 이번 결과와 관련 누적 구현은 작업 커밋에 포함하고 커밋 후 별도 적대적 리뷰를 실시한다. 사용자 서버·계정·로컬 설정은 변경하지 않았다.
