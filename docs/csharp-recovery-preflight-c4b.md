# C# C4-B 준비 작업 복구·산출물 실행 검사

작성: 2026-11-19. [C4-A 준비/캐시](csharp-preparation-c4a.md) 다음 작업이다. **준비 작업의 재시작 복구, DLL 기반 공통 실행 검사와 검사 결과 파일 어댑터까지 구현했다.** 계정 revision 갱신·운영 API·Node 게임 연결은 남아 있으며 실제 지원 언어는 계속 JavaScript 하나다.

후속 [C4-C](csharp-account-validation-c4c.md)에서 계정 revision/검사 worker와 내부 후보 검사 요청을 연결했다. 아래 계정 연결의 미완료 설명은 C4-B 완료 당시 상태이며 Node 게임·공개 C# 기능과 정식 채택 관문은 계속 남는다.

## 준비 작업 복구

준비 루트의 단일 writer를 확보한 뒤 `RecoverAsync`로 회수한다. 첫 Prepare/Acquire도 복구를 요구하므로 미완료 작업을 정상 캐시로 읽지 않는다.

```text
work/{job-guid}/
  ownership.json       # c4-work-v2, owner/sourceHash/artifactKey; 원문 사본보다 먼저 flush
  source.cs
  process.json         # PID + UTC 시작 시각 + job; OS 그룹 배치 후 authorize보다 먼저 기록
  active.lock          # 컴파일러가 소스 처리부터 종료까지 독점 보유
  output/
    artifact.dll
    manifest.json
```

회수는 다음 조건을 모두 확인한다.

1. 작업 경로가 전용 루트 안에 있고 이름이 GUID이며, 알려진 파일/디렉터리만 존재한다. reparse point나 알 수 없는 하위 경로는 보존한다.
2. 소유 기록의 프로토콜·owner·해시가 유효하다. 기록이 없거나 손상된 이전 작업은 임의로 지우지 않는다.
3. 프로세스 기록이 있으면 PID와 시작 시각을 함께 확인한다. 같은 프로세스가 살아 있거나 상태를 확인할 수 없으면 보존한다. PID가 재사용됐다는 이유로 현재 프로세스를 종료하지 않는다.
4. `active.lock`을 독점 획득할 수 있어야 한다. 조건을 통과한 작업 디렉터리만 제거하며 게시된 `objects`와 원본 알고리즘 파일은 유지한다.

프로세스 기록이 없으면 승인 전에 중단된 작업이다. 컴파일러는 `authorize` 전 사용자 소스를 처리하지 않으며 승인 전에 PID 기록을 내구 저장한다. 복구 함수는 이전 PID에 종료 명령을 보내지 않는다.

`Removed`와 `Retained`를 반환한다. 보존된 작업이 있으면 새 준비/획득을 막고 운영자의 확인을 요구한다. **현재 writer가 정리 확인에 실패한 상태는 자동 정상화하지 않는다.** 자원 예약·writer lease를 보존하며 해당 그룹의 실제 종료 확인과 서비스 재시작이 필요하다. Linux 부모 장애 감독과 실제 배포 권한 검증은 별도 관문이다.

## 공통 DLL 실행 검사

`scripts/backend-content.js`가 기존 JavaScript의 `preflight-scenarios.js`에서 `backend/contracts/generated/algorithm-preflight.json`을 생성한다. 별도의 수동 C# 맵을 유지하지 않는다. fixture 버전은 `2.0.0`이며 실제 JSON의 SHA-256도 결과에 기록한다.

| 시나리오                      | 플레이어/호출                     |
| ----------------------------- | --------------------------------- |
| crossroads, four-courtyards   | 각 4명 × 3회                      |
| 목표 없음, 도달 불가능한 코인 | 각 1명 × 3회                      |
| 40×30 희소/밀집 코인          | 각 1명 × 3회                      |
| 합계                          | 12개 독립 인스턴스, MoveNext 36회 |

각 시나리오/플레이어는 `CSharpHostManager.CreatePreparedAsync`로 새 객체를 만들고 같은 객체에서 3회 호출한다. 두 번째 호출은 아이템을 제공하고 세 번째는 코인을 제거한다. `-1`은 정상적인 제자리 반환으로 인정한다. Initialize/GetName도 실제 실행하며 각 호출에는 기존 호스트의 독립적인 500ms 제한을 적용한다. 매 턴 컴파일하지 않는다.

외부 artifact lease는 검사 전체 동안 유지하며 각 실행 세션도 자체 lease를 갖는다. 정상 종료·실패·취소 후 실제 그룹 정리를 확인하고 반환한다. 준비 단계의 사용자 오류도 부모가 원래 단계/시간/위치를 보존한다.

| 결과               | 의미                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| passed             | 36회가 정상 반환됨. 모든 입력에서의 성공 보장이나 C# 활성화 허가는 아님 |
| failed / AR012     | 실제 사용자 호출 시간 초과                                              |
| failed / AR013     | 잘못된 방향 또는 null 이름 등 잘못된 반환                               |
| failed / AX002     | 사용자 코드 실행 예외                                                   |
| failed / AX003     | 확인된 컬렉션 등 연산 한도 초과                                         |
| unverified / AX004 | 취소·자원 포화·호스트 불가·정리 미확인 등 검사 환경 장애                |

진단에는 단계, 시나리오, 0부터 시작하는 플레이어 번호, 1부터 시작하는 턴, 확인 가능한 call ID·소요/제한 시간·원본 행/열을 기록한다. 임의의 사용자 예외 문자열을 운영 결과에 그대로 저장하지 않는다. fixture 손상이나 최초 artifact 획득 실패는 호출자에게 예외로 전달하며 상위 검사 서비스에서 인프라 실패로 처리해야 한다.

이번 큰 맵 검사에서 분할 전달되는 stdin 명령의 시작 통보가 누락되는 문제를 발견했다. 호스트 명령 입력을 `Console.In`의 동기화 래퍼에서 전용 표준 입력 StreamReader로 변경했고, 40×30 맵을 포함한 실제 IPC 36회 검사로 확인했다.

## 메타데이터 어댑터

`ICSharpPreflightReportStore`의 현재 구현은 `FileCSharpPreflightReportStore`다.

```text
report-root/{owner-guid}/{artifact-key}/{fixture-hash}.json
```

보고서에는 owner, artifact/source/toolchain 해시, 검사 프로필 `csharp-artifact-preflight-v1`, fixture 버전/해시, 결과·성공 호출 수·진단만 저장한다. 코드 원문과 DLL은 기존 파일 저장소에 남는다. owner/key/버전·키 조합과 결과 일관성을 검증하고 원자적으로 기록한다. 다른 owner 또는 다른 fixture의 결과를 재사용하지 않는다.

**계정 알고리즘 저장소의 revision CAS 연결은 아직 아니다.** 같은 내용의 다른 저장 revision을 자동 승인하지 않으며 보고서의 `ExecutionAllowed`는 항상 false다. 계정 검사 worker 연결 시 알고리즘 ID/revision·owner/source·검사 프로필/fixture·toolchain을 함께 확인해 현재 revision만 갱신해야 한다. 실패한 코드도 파일에 보관하는 기존 원칙은 유지한다.

## Windows 검증

새 확인 53개를 통과했다. [검증 원본](benchmarks/csharp-c4b-2026-11-19.json)에 코드 원문 없이 결과와 진단을 보관한다.

- 소유 기록만 남은 작업, 살아 있는 PID, PID 시작 시각 불일치, 독점 lock, 소유 기록 없는 작업의 회수/보존.
- **실제 부모 crash:** 별도 시험 부모가 작은 코드를 게시한 뒤 큰 코드의 실제 컴파일러 lock 획득을 확인한다. 시험 부모만 강제 종료하고 Windows Job의 kill-on-close로 컴파일러가 종료되는지 확인한다. 새 writer의 임시 작업 회수·기존 artifact cache hit·원본 파일 보존을 확인했다. 제품 코드에 시험용 정지 옵션을 추가하지 않았다.
- BFS와 합법적인 제자리 코드 각각 36회 통과. 루프 timeout/원본 위치, 잘못된 방향, 실행 예외, 초기화 timeout, null 이름, 연산 한도를 분리했다.
- 자원 포화·진행 중 취소·정지한 manager는 코드 오류로 기록하지 않는다.
- owner/fixture별 결과 파일 재조회, 불완전한 passed 보고서 거절, 세션·자원 예약 0.

전체 회귀는 C1 62·C2 223·C3 30·부모 42·C4-A 33·C4-B 53, 기존 .NET 계약/업무/OS 59건, BE 통합 13그룹·프로토콜 5건이다. Linux에서 위 부모 crash 시험을 통과한 것으로 간주하지 않는다.

```powershell
$env:COINHUNTER_BUILD_ROOT='artifacts/c4b-build'
node scripts/backend.js test
# 빌드 후 C4-B만 다시 실행하려면:
dotnet artifacts/c4b-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-preflight
```

## 다음 순서

1. 계정 알고리즘의 language/artifact 참조·revision CAS와 백그라운드 검사 서비스 연결. 정식 언어 활성화와 구분해 구현한다.
2. 실행 관리 서비스의 준비/검사 내부 계약과 Node C# 어댑터·게임 snapshot 연결. 호출마다 운영 HTTP/컴파일을 수행하지 않는다.
3. 캐시/임시 원문 볼륨 quota·여유 공간·보유/삭제·백업 정책, 운영 watchdog/grace/반복 실패 정책 확정.
4. native/GC·문자열 등의 중단 한계, Linux 강제 제한·권한·부모 장애 감독, 실제 혼합 언어 부하·공정성 관문을 통과한 뒤에만 C# 지원 여부를 결정한다.

사용자 서버와 실제 계정/알고리즘 데이터는 변경하지 않았다. C4 변경은 아직 커밋하지 않았다.
