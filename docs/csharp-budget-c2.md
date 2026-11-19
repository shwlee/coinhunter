# C# C2 자동 예산 검사 후보 구현

작성: 2026-11-16. [C1 제한 프로필](csharp-analysis-c1.md)을 통과한 코드에 호스트 소유 검사 코드를 삽입하고, 실제 중단 후 같은 Player 인스턴스의 재호출을 검증했다. 제품 registry·작업실/API에 연결한 정식 C# 지원은 아직 아니다.

## 변환·컴파일·호출

`BudgetRewriter`는 모든 사용자 메서드 진입과 for/while/do/배열 foreach 본문 선두에 `BudgetGuard.Poll(원본행, 원본열)`을 넣는다. 단일 문장·빈 문장 본문은 블록으로 감싸고 식 본문 메서드는 일반 본문으로 바꾼다. continue는 다음 반복의 guard를 거치며, 조건/증감식에서 호출하는 사용자 helper에도 메서드 진입 guard가 있다. 콜백·Dispose·동적 dispatch·재귀 등 C1 미승인 경로는 컴파일 전에 거절한다.

원문은 guard assembly 참조 없이 C1 검사를 먼저 받는다. 변환된 코드에만 완전 수식 guard 참조와 호스트 assembly metadata를 추가하므로 사용자 코드에서 budget 상태에 접근하는 경로를 승인하지 않는다. 원문 `#line` 등 전처리 지시문도 거절한다. guard는 호출 스레드에 연결한 host scope의 단조 시계를 확인하고, 기한 도달을 먼저 고정한 뒤 전용 예외를 던진다.

`CSharpCandidate.Prepare`에서 한 번 분석·변환·메모리 DLL 컴파일·로드한다. Construct/Initialize/GetName/MoveNext는 준비된 같은 객체를 호출하며, 매 턴 재컴파일하지 않는다. 원문 파일을 변경하지 않고 C1 분석 결과·GuardVersion·guard 위치를 유지한다. 제품용 불변 artifact/cache·소유권/회수는 C4 이후 과제다.

호출별 기본 예산은 500ms다. 실험에서만 더 짧은 예산을 넘길 수 있으며 500ms 초과 예산은 받지 않는다. 입력 배열은 호출 전 복사한다. 측정 구간은 복사 이후 reflection dispatch/JIT·사용자 메서드·반환 또는 예외 unwind까지 포함하며 순수 사용자 함수 시간으로 표시하지 않는다. 언어별 정식 시작/시계 계약은 C3에서 연결한다.

호출은 동기로 실행하고 실제 반환/예외 unwind 후에만 결과를 생성한다. host의 마지막 경과 시간 확인은 guard를 추가로 지나지 않고 늦게 반환한 값도 timeout으로 거절한다. 예외 타입만으로 timeout을 판단하지 않는다. 생성/초기화 실패 또는 일반 예외/메모리 오류가 난 후보는 재호출을 거절한다. 정상 guard timeout은 같은 객체의 부분 변경을 유지하며 롤백하지 않는다.

결과에는 instance/call/PID, 상태·반환값, BudgetMs/ElapsedMs, DeadlineReached/ExecutionSettled, 원본 guard 행/열과 오류 타입을 담는다. `ExecutionSettled=true`는 실제 호출이 끝났다는 의미다. guard 지점에 도달하지 않고 host 종료 검사에서만 마감이 확인되면 원본 위치는 null일 수 있다.

## 검증 환경과 범위

실제 사용자 서버·데이터 대신 합성 소스와 별도 `artifacts/c2-build`를 사용했다. 부모가 전용 .NET 자식을 시작하고 **R0 OS 그룹 배치 확인 뒤** stdin으로 허가한다. 분석·컴파일·사용자 DLL 로드 모두 허가 뒤 실행한다. 프로필은 메모리 768 MiB, Windows 프로세스 2개/Linux task 128개, CPU rate 10000이다. 부모 watchdog 60초와 그룹 전체 정리는 실험 실패 시 회수용이며 정상 턴 timeout 정책이 아니다.

Windows에서 149개 확인 항목을 통과했다. Linux는 이 실험에서 실행하지 않았다.

최종 전체 BE 검증에서도 C1 52건·C2 149개 확인, 기존 .NET 계약/업무/OS 59건, BE 통합 13그룹·프로토콜 5건을 통과했다. 빌드 경고/오류는 0개다. 최종 관측 최대 마감 초과는 약 1.68ms, 40회 반복 구간의 retained memory 차이는 12,560바이트였다. 이 수치들은 해당 실험의 관측값이다. 기존 Node legacy 파일 잠금 EPERM은 이번 수정 범위 밖의 미해결 사항으로 유지한다.

- 9개 루프 형태: 빈 while·빈 for·do/continue·분기/continue·배열 foreach·중첩·void 식 본문 helper·조건 helper·매우 긴 유한 반복.
- 각 500ms timeout 뒤 동일 PID/InstanceId, 순차 CallId·필드 보존과 정상 방향 반환.
- 컬렉션 변경과 큰 배열 할당/GC 반복 중 timeout 뒤 정상 호출·컬렉션 불변 조건 확인.
- 초기화·이름 조회의 무한 반복 중단, 실패 초기화 재사용 차단, 잘못된 방향과 일반 예외 구분.
- 10ms 예산으로 40회 timeout/정상 호출 반복, 관측된 retained memory 차이 기록. 이 측정은 일반적인 누수 없음의 증명이 아니다.
- 실제 BFS 샘플의 방향 매핑, 입력 배열 소유권, 금지 소스·guard 접근·미승인 Sort/Dispose/재귀 경로 거절.
- 신뢰된 host fault injection으로 마감 후 정상 값 반환·중단 예외 감싸기/대체·deadline 없는 전용 예외 위조를 시험했다. 사용자에게 catch/comparer/Dispose를 허용해서 시험한 것은 아니다. 예외 변형이 있으면 timeout 판정과 객체 재사용 가능성을 별도로 취급한다.

[실측 원본](benchmarks/csharp-c2-2026-11-16.json)에 호출별 예산·시간·guard 위치·PID/instance/call과 메모리 차이를 보관한다. 개발 PC의 정상 부하에서 얻은 관측치이며 운영 지연 상한이 아니다.

재현:

```powershell
$env:COINHUNTER_BUILD_ROOT='artifacts/c2-build'
node scripts/backend.js build
dotnet artifacts/c2-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-budget
```

일반 `node scripts/backend.js test`에도 이 검증을 연결했다. 별도 프로세스 테스트이므로 검사기 오류로 무한 루프가 남더라도 부모가 그룹 전체를 종료한다.

## 아직 보장하지 않는 경계

**guard 사이에서 실행하는 긴 builtin·할당·GC를 500ms 시점에 강제 선점하지 못한다.** 해당 구간에서 늦게 끝나면 반환값은 거절하지만 물리적 중단은 늦어진다. 이 제한은 이번 구현으로 해결됐다고 표시하지 않는다. 엄격한 실제 중단을 요구하는 API는 한도 있는 대체 구현·허용 범위 축소·추가 런타임 방식 등을 더 검증해야 한다. 사용자 try 금지만으로 모든 경로의 중단을 보장하지 않는다.

Dispose는 같은 후보의 진행 중 호출과 직렬화되며 임의의 .NET 실행을 강제 중단하는 API가 아니다. 수집 가능한 AssemblyLoadContext의 Unload는 보안 격리나 강제 중단을 제공하지 않는다. [공식 AssemblyLoadContext 설명](https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-runtime-loader-assemblyloadcontext), [협조적 unload 설명](https://learn.microsoft.com/en-us/dotnet/standard/assembly/unloadability).

이번 OS 그룹은 개발자용 검증 부모에서 적용한다. CSharpCandidate 자체가 자동으로 프로세스를 생성/격리하지 않으므로 운영 API 프로세스에 직접 로드하면 안 된다. 파일/네트워크/자격 증명 격리, 분석·컴파일의 운영 준비 경로는 후속이다.

## 다음 작업

1. C3 전용 실행 호스트·IPC·독립 감시, 시작/마감/정리 완료의 시간 계약과 관리 채널 구현/검증.
2. guard 사이 긴 builtin의 허용 프로필 조정과 C2 남은 중단 관문. 유예/강제 교체·상태 복원은 미확정이며 이번 구현으로 정책을 바꾸지 않았다.
3. Linux 자원·부모 장애 감독 검증과 C4 준비/컴파일·검사/저장·artifact 수명 연결.
4. 혼합 게임·고아 회수·부하 등 C5 최종 판정 후에만 C# 지원 노출.
