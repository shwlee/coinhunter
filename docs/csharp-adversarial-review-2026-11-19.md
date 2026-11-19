# C# 후보 실행 영역 적대적 리뷰

- 리뷰 대상: `781b5cb` — C1/C2·bounded 프로필 v2·C3 호스트·운영 부모 관리자.
- 수행: 2026-11-19. 요청에 따라 구현을 먼저 커밋하고 리뷰했다. 리뷰 당시 푸시와 지적 사항 수정은 수행하지 않았다.
- 검토: 정적 타입/API/순환 검사와 변환, 마감 판정·필드 유지, IPC·수명 식별자·취소·실제 자원 회수.
- 결과: **재현된 중간 3건. 이번 검토에서 새 높음 문제는 확인하지 못했다.** 미발견이 전체 안전성을 증명하지는 않는다. 현재 C# capability는 비활성이므로 기존 JS 게임에 이 경로가 노출되지는 않는다.
- 후속: 사용자 수정 지시에 따라 [R1~R3 수정·재현 재검증](csharp-review-fixes-2026-11-19.md)을 수행했다. 아래는 `781b5cb` 기준 최초 리뷰 기록이다.

## R1 — 중간: 표현식/foreach의 허용 타입 검사가 빠져 있다

위치: `backend/src/CoinHunter.CSharp.Analysis/PlayerAnalyzer.cs:130` 및 `:133`, `:148`.

허용 타입은 변수/필드 선언·매개변수·반환값에 적용한다. 캐스트의 대상 타입과 foreach의 반복 변수 타입에는 같은 검사를 하지 않는다. 동적 속성/인덱서는 GetSymbolInfo의 Symbol이 null이므로 현재 속성 검사도 건너뛴다.

재현한 MoveNext 본문:

```csharp
var d = new System.Collections.Generic.Dictionary<int, int>();
((dynamic)d)[0] = 1;
return 0;
```

```csharp
var a = new System.Collections.Generic.List<int>();
((dynamic)a).Capacity = 1048576;
return 0;
```

두 경우 모두 `StaticPassed=true`, 진단 없음으로 나왔다. 실제 후보 컴파일은 현재 참조 집합에 runtime binder가 없어 `CS0656`으로 실패했다. **실행 가능한 크기 제한 우회가 확인된 것은 아니다.** 그러나 미승인 코드가 정적 통과로 잘못 표시되고, 다음 단계에서는 소스 위치 없는 내부 컴파일 실패가 된다. 이후 참조 추가 때도 의도치 않게 열릴 수 있다.

또한 `foreach (object x in map) { return x == null ? 0 : 1; }`는 정적 통과와 후보 DLL 생성을 모두 통과했다. 일반 object 변수는 허용하지 않는 프로필인데 foreach에서는 같은 타입이 허용된다.

권장 수정: 의미 모델의 타입/IOperation 검사로 선언·캐스트·foreach 및 동적 member/indexer/operator 경로를 함께 집행한다. 해석할 수 없는 동적 접근은 AP001로 명시적으로 거절한다. 정상적인 숫자/배열 캐스트는 계속 허용하고 타입이 단순 이름 `dynamic`이라는 이유만으로 문자열 검사하지 않는다.

필수 회귀: 위 두 동적 접근과 object/dynamic foreach의 사전 거절, 승인된 int/long/uint/ulong 배열 길이 및 일반 배열 foreach 유지.

## R2 — 중간: null 알고리즘 이름을 정상 준비로 승인한다

위치: `backend/src/CoinHunter.CSharp.Analysis/CSharpCandidate.cs:76`, `backend/src/CoinHunter.CSharp.Host/Program.cs:60`.

```csharp
public string GetName() { return null; }
```

C1은 서명만 확인하고 CSharpCandidate.GetName은 MoveNext와 달리 반환값 검증을 하지 않는다. 호스트도 Status가 ok인지만 확인한다. 실제 부모 모듈로 이 소스를 로드했을 때 `state=ready`, 다음 판단도 `status=ok`가 되었다.

현재 화면 연결 전이지만, 필수 함수의 잘못된 결과를 준비 성공으로 승인하므로 향후 검사/게임 표시 단계가 서로 다른 판정을 할 수 있다. 값이 없는 이름은 string 반환 계약을 만족했다고 볼 수 없다.

권장 수정: 이름 반환값에 대한 검증/정규화 정책을 공통 후보 호출 결과에 적용하고 호스트/검사 경로가 함께 사용하도록 한다. null 거절과 빈 값/공백·최대 표시 길이의 처리 규칙을 구분한다. 잘못된 이름은 사용자 코드 진단으로 돌려주고 일반 인프라 장애로만 덮지 않는다.

필수 회귀: null·정상 한글·빈 이름 정책, 실패 이름에서 ready 미발행 및 부모 자원 회수.

## R3 — 중간: 전송 한도 초과 입력이 정상 호스트를 종료시킨다

위치: `backend/src/CoinHunter.Infrastructure/Execution/CSharpHostSession.cs:104`, `:112`, `:124`.

MoveNextAsync는 busy/pending 상태를 먼저 만든 다음 직렬화·frame 길이 검사를 수행한다. 이 로컬 검사에서 발생한 예외까지 같은 catch가 받아 `start-notification-missing`으로 분류하고 전체 그룹을 강제 종료한다.

재현: 정상 준비한 세션에 `new int[600000]`, position 0, 정상 items를 넘겼다. 실제 전송 전 길이 검사를 넘지 못했고 `CSharpHostFailure(reason=start-notification-missing)`와 `state=closed`가 반환됐다. 호스트가 시작 통보를 누락한 것이 아니며 이 세션으로 정상 입력을 다시 호출할 수도 없다.

현재 호출자는 신뢰된 서버이고 게임 어댑터 연결 전이므로 외부 사용자가 이 API를 직접 호출하는 취약점으로 판정하지 않는다. 하지만 입력/인프라 오류 분류를 어기고 불필요한 상태 손실·프로세스 교체를 유발한다.

권장 수정: 전송 전 입력/직렬화 검증과 dispatch 후 실패를 나눈다. 로컬 입력 오류는 ArgumentException 등으로 반환하고 세션 상태/인스턴스를 유지한다. validation 중 다른 호출과의 경합을 막고, 송신 시작 후 실패는 별도 인프라 종료 경로로 처리한다.

필수 회귀: 과대 frame 거절 후 같은 PID/generation/instance에서 정상 판단 성공, 전송되지 않은 요청의 pending 잔존 없음, 실제 IPC 시작 통보 누락에 대한 기존 강제 정리 유지.

## 재현 방법과 한계

저장소 제품 파일은 수정하지 않았다. `artifacts/adversarial-review`에 별도 개발자 프로브를 만들고 `artifacts/review-build`로 빌드했다. 정책 확인은 분석/emit만 수행했고, 실제 사용자 코드 실행은 기존 부모 모듈의 768 MiB OS 그룹에서 null 이름/전송 거절을 확인했다. 실제 사용자 서버·계정·알고리즘은 유지했다.

관측 출력:

```text
dynamic-set static=True diagnostics=[]
dynamic-set emitted=false Generated compilation failed: CS0656
dynamic-capacity static=True diagnostics=[]
dynamic-capacity emitted=false Generated compilation failed: CS0656
foreach-object static=True diagnostics=[]
foreach-object emitted=true
null-name static=True diagnostics=[]
null-name emitted=true
null-name parent ready=ready
null-name move=ok
oversized frame=CSharpHostFailure reason=start-notification-missing state=closed
```

이 리뷰에서 Linux 실측·실제 OS 권한에 의한 정리 실패를 새로 시험하지 않았다. 기존 전체 BE 회귀의 성공과 이번 부정 사례의 실패를 구분한다.

## 기존 미해결 관문 — 신규 발견과 구분

- GC/native/문자열 등 암묵적 연산의 엄격한 500ms 선점은 미해결이며 이번 프로필로 보장하지 않는다.
- 운영 watchdog/grace/반복 실패 정책, Linux 부모 장애 감독·권한 검증이 남는다.
- C4 immutable artifact/cache/소유권·Node runner/공개 API 연결은 아직 구현하지 않았다.
- 기존 Node legacy 파일 잠금 EPERM은 이 변경의 수정 범위 밖이다.

위 항목은 이미 문서에 남긴 지원 관문이다. 이번 새 버그 3건과 합쳐서 정식 C# 지원을 활성화하기 전에 처리해야 한다.
