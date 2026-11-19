# C# C1 정적 규약 분석기

작성: 2026-11-16. `CoinHunter.CSharp.Analysis`에 Roslyn 기반의 제한 프로필 분석기를 구현했다. **로컬 분석 후보이며 C# 게임 실행은 아직 활성화하지 않았다.** 현재 서비스의 검사 API나 저장 경로에서 사용자 C#을 받지 않는다.

후속: [C2 자동 예산 검사 후보](csharp-budget-c2.md)의 변환/컴파일·실제 호출 실험을 추가했다. 아래 C1 설명과 별개인 개발자용 OS 제한 프로세스에서 실행하며 제품 연결은 아직 하지 않았다.

2026-11-19 갱신: 현재 활성 후보는 [bounded 프로필 v2](csharp-builtins-profile-v2.md)다. 아래 초기 승인 목록에 객체 크기 한도·검색 변환·사전 인덱서 변경 거절을 추가했다. C2 검증 수는 기존 149개에서 211개 확인으로 확장했다.

리뷰 후속: [의미 타입 검사·이름 반환 계약 수정](csharp-review-fixes-2026-11-19.md)으로 분석기를 c1-3으로 갱신했다. 현재 분석 62건, 예산/정책/이름 223개 확인이다. 아래 52건은 초기 C1 검증 기록이다.

## 구현과 진단

`PlayerAnalyzer.Analyze(source, cancellationToken)`는 단일 문자열을 구문·의미 분석한다. 사용자 DLL을 생성하거나 로드/실행하지 않는다. 참조는 현재 호스트 .NET 런타임의 CoreLib·Runtime·Collections metadata로 고정한다. 제출자가 참조 경로·NuGet·컴파일 옵션을 지정할 수 없다. SDK에 동봉된 Roslyn을 빌드 참조하므로 외부 패키지 다운로드가 추가되지 않는다. 빌드 SDK가 바뀌면 분석기 재검증이 필요하다.

구문은 명시한 허용 집합만 받고, 호출/속성/필드는 의미 모델의 실제 심볼을 검사한다. 별칭, `global::`, 승인 Math의 `using static` 호출도 같은 규칙으로 판정한다. 사용자 메서드 호출 그래프는 overload를 구분하고 각 시작점에서 도달 가능한 순환을 반복 탐색한다. [Roslyn 의미 모델](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/work-with-semantics)을 사용한다.

결과는 원문 SHA-256, 정책/프로필/분석기/Roslyn/런타임 버전, `StaticPassed`, `ExecutionAllowed`, 오류 코드·원본 행/열을 포함한다. 행/열은 1부터 시작한다. `ExecutionAllowed`는 항상 false다. 무한 반복 코드도 정적 규약에 맞으면 `StaticPassed=true`일 수 있으며, 종료 보장은 C2와 실제 실행 검사에서 검증한다.

| 코드  | 현재 처리                                          |
| ----- | -------------------------------------------------- |
| AX001 | 구문 오류 또는 C# 컴파일 의미 오류                 |
| AR002 | 승인하지 않은 타입·메서드/생성자·속성·필드         |
| AR003 | 사용자 static 선언                                 |
| AR004 | async/await                                        |
| AR009 | 확정된 직접/상호 재귀 호출                         |
| AR010 | goto                                               |
| AR011 | 사용자 try/catch/finally                           |
| AR013 | Player 구조·필수 서명 위반                         |
| AP001 | 허용 집합 밖의 구문/한정자·지원하지 않는 호출 경로 |

Task/Thread·sleep·파일/환경 접근 등은 승인 API 검사에서 AR002 또는 metadata 부족에 따른 AX001로 거절될 수 있다. 이 후보에서 공통 AR004~AR008의 세분화 진단을 모두 구현했다고 표시하지 않는다. 사용자 소스 오류와 분석기 인프라 예외는 구분한다. 취소는 OperationCanceledException으로 호출자에게 전달된다.

## 첫 허용 프로필

전역 `public class Player` 하나를 사용한다. 아래 PascalCase 서명을 C# 후보 계약으로 정했다.

```csharp
public void Initialize(int myNumber, int column, int row)
public string GetName()
public int MoveNext(int[] map, int myPosition, int[] items)
```

입력/방향 의미는 기존 게임과 같다. 필드·const·일반 인스턴스 helper 메서드·overload·식 본문 메서드, 분기/반복/break/continue·배열 foreach를 지원한다. 명시적 생성자·추가 helper 클래스·상속/인터페이스·제네릭 사용자 메서드는 첫 프로필에서 지원하지 않는다.

| 대상             | 승인 범위                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| 값/배열          | int, long, double, bool, char, string, void(반환); 해당 값 타입의 1차원 배열                              |
| Math             | Abs, Min, Max, Clamp, Sqrt, Pow, Floor, Ceiling 중 승인 scalar 매개변수 overload                          |
| 정수 컬렉션 생성 | Queue/List/HashSet/Dictionary/PriorityQueue의 모든 타입 인자가 int. 기본 생성자 또는 단일 int 용량 생성자 |
| Queue            | Enqueue, Dequeue, Peek, Clear, Contains                                                                   |
| List             | Add, Remove, RemoveAt, Clear, Contains, IndexOf                                                           |
| HashSet          | Add, Remove, Clear, Contains                                                                              |
| Dictionary       | Add, Remove, Clear, ContainsKey                                                                           |
| PriorityQueue    | Enqueue, Dequeue, Peek, Clear                                                                             |
| 속성/필드        | 위 컬렉션 Count/Item, Array/string Length, 승인 scalar의 상수와 Player 필드                               |

컬렉션 메서드도 ref/out과 비scalar 매개변수 overload는 거절한다. 사용자 comparer, Sort, LINQ, delegate/lambda, local function, iterator, using/Dispose, 사용자 속성/연산자, dynamic, reflection, unsafe, extern, 전처리 지시문은 미승인이다. 일반 using namespace/alias는 사용할 수 있지만 import 자체로 API가 승인되지 않는다.

이 범위는 **정적 승인 후보**다. 긴 표준 함수·할당/GC·컬렉션 호출의 500ms 중단 안전성이 증명된 것은 아니다. 이 타입/API 집합을 C2 실측 결과에 따라 줄이거나 확장한다. debug 출력 API도 실행기 소유 binding이 준비된 후 추가한다.

## 검증·재현

- C# 분석 전용 52건: 실제 BFS 샘플, 배열/정수 컬렉션/Math/별칭/overload, 필수 서명, 금지 구문·외부 접근·재귀·콜백/Dispose 경로·취소·진단 위치 검증.
- .NET 기존 계약/업무/Windows OS 검사 59건, BE 13그룹·프로토콜 5건 통과. 분석기 추가 후 전체 BE 검증을 수행했고 최종 `using static` 처리/식 본문 추가는 빌드 및 분석 52건으로 재검증했다.
- 별도 빌드 경로 `artifacts/c1-build`, 경고/오류 0개. 사용자 서버와 실제 데이터는 유지했다.
- 앞선 Node legacy 파일 잠금 EPERM은 이 단계의 수정 대상이 아니며 여전히 별도 미해결이다.

솔루션을 빌드한 뒤 검사 실행 파일로 개발자용 분석을 수행할 수 있다. 아래 명령은 저장소 루트 기준이다.

```powershell
$env:COINHUNTER_BUILD_ROOT='artifacts/c1-build'
node scripts/backend.js build
dotnet artifacts/c1-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-analysis
dotnet artifacts/c1-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . analyze-csharp backend/examples/csharp/nearest-coin.cs
```

마지막 명령은 JSON 결과를 출력한다. 종료 코드 0은 정적 프로필 통과이며 실행 허가가 아니다. 실제 샘플은 [nearest-coin.cs](../backend/examples/csharp/nearest-coin.cs)에 보관했다.

## 후속 관문

1. C2 자동 예산 검사 삽입·호스트 소유 중단 상태·동일 객체 재호출 검증. 위 후보 API의 긴 builtin/할당·예외 변형도 측정한다.
2. C1 분석/컴파일 자체를 R0 자원 그룹을 적용한 준비 프로세스에 연결한다. 현재 로컬 개발자 명령은 강제 시간/메모리 격리를 제공하지 않으므로 공개 업로드에 연결하면 안 된다. cooperative cancellation은 강제 중단을 대신하지 않는다.
3. C3 실행 시작/마감/정리 완료 계약과 복구 정책을 확정한다. Linux 자원·부모 장애 관문도 여전히 남는다.
4. C4에서 검사/저장/API·registry에 연결하고 사용자 화면에 C#을 노출한다.

공통 규약이 목표로 삼은 helper 타입·더 넓은 기본 컬렉션 API·상세 진단은 추가 프로필 과제다. 이번 C1 후보 구현으로 해당 전체 범위를 완료 처리하지 않는다.
