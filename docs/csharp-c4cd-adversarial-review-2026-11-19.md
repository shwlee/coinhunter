# C4-C/D 적대적 리뷰 — 계정 검사·Node/C# 게임 연결

작성: 2026-11-19. 대상 커밋: `451b4db` (`feat: connect C# account validation and private Node game runners`). 사용자 요청에 따라 작업 내용을 먼저 커밋한 후 리뷰했다. 이전 stage4 실험 도구와 package.json의 미커밋 실험 명령은 커밋/리뷰 대상에서 제외했다. 푸시는 요청하지 않았다.

**수정 전 커밋의 결과: 높음 1건·중간 2건을 재현했다.** 아래 항목은 공개 C# 지원이 비활성이어도 후보 구현에서 해결해야 하는 결함이다. 원래부터 남겨 둔 native/GC 중단·Linux·IPC 비용 관문을 새 결함으로 중복 집계하지 않았다.

후속: 사용자의 수정 요청으로 [H1/M1/M2 수정·회귀 검증](csharp-c4cd-review-fixes-2026-11-19.md)을 진행했다. 아래 원인·수정 전 관측값은 대상 커밋의 리뷰 기록으로 유지한다.

## H1 — C# 실행기가 게임별 자원 그룹 밖에서 검사용 한도로 실행됨

- 위치: `backend/src/CoinHunter.Execution.Host/Services/CSharpValidationService.cs:32`, `:41`; `ExecutionManager.cs:153`, `:209`.
- 원인: `PreparePlayer`는 검사용 `profile`을 그대로 `CSharpPreparedLaunch`에 전달한다. C# 호스트는 전역 자원 관리자의 별도 그룹에만 배치된다. 게임의 `ResourceGroup`에는 Node만 배치하며 C# 호스트를 포함하는 부모 자원 scope를 연결하지 않는다.
- 영향: `Backend:Resources:GameProcesses`, `GameMemoryMiB`, `GameCpuRate`가 게임 전체에 적용되지 않는다. C#은 플레이어마다 768 MiB/CPU rate 10000 프로필을 사용하고 기존 JS는 엔진의 게임 그룹 한도를 함께 사용한다. 게임 사용량 조회도 별도 C# 호스트 사용량을 포함하지 않는다. 전역 예약과 개별 C# 한도는 작동하지만 게임별 설정·측정 및 언어 간 자원 조건이 다르다.

재현은 게임 프로세스 한도를 1, 게임 CPU rate를 1000으로 설정한 별도 실행 루트에서 C# 1인 후보 게임을 준비했다. 게임은 `prepared`가 됐고 Node 엔진과 C# 호스트가 별도 프로세스로 존재했다. Windows의 `IsProcessInJob`으로 **실제 C# PID가 해당 게임 Job에 속하지 않음**을 확인했다. C# 프로필은 계속 CPU rate 10000이다. 실제 CPU 점유율·RSS 초과를 실측한 주장은 아니며 OS 그룹 멤버십과 설정 전달의 누락을 확인한 것이다.

수정 방향: 게임 전체를 소유하는 자원 scope와 플레이어별 하위 scope를 연결한다. Windows는 부모/하위 Job, Linux는 게임 cgroup/플레이어 leaf에 해당하는 구조가 필요하다. 전체 예산과 하위 예산의 예약을 중복 차감하지 않도록 관리하며, 게임 사용량도 전체 실행기를 포함해 보고한다. 개별 한도를 단순히 더 높이거나 IPC 시간 보정으로 해결할 문제가 아니다.

검증해야 할 회귀: 1프로세스 게임 한도에서 추가 C# 호스트 진입 거절, 혼합 게임 전체 메모리/CPU 한도, 여러 게임의 예약/회수, 기존 JS와 동일한 게임 자원 정책 적용. 정식 공개 활성화 전 필수 수정이다.

## M1 — 같은 코드 버전의 오래된 검사 결과가 최신 검사 결과를 덮어씀

- 위치: `backend/src/CoinHunter.Operations.Api/Services/AlgorithmValidationService.cs:79`, `:143`; `AccountService.cs:88`.
- 원인: 백그라운드 `Check(... updateStored:false)`는 계정별 검사 gate를 반환한 뒤 finally에서 `SetJobState`로 최종 상태를 기록한다. CAS는 owner/language/revision/sourceKey/sourceHash를 확인하지만 **검사 시도 자체의 순서/식별자**는 확인하지 않는다.
- 영향: 코드가 변경되지 않은 상태에서 수동 검사가 새 결과를 적용한 후, 더 오래된 백그라운드 결과가 늦게 쓰이면 새 상태·진단이 사라진다. JS와 C#이 공유하는 저장 갱신 경로다. 게임 진입의 별도 재검사나 C# 실행 허가 false를 우회하는 취약점으로 해석하지 않는다.

검사 HTTP 응답은 제어 가능한 transport로 만들고, 실제 `FileAccountStore`의 원자적 변경 앞에서 이전 최종 쓰기만 지연했다. 최신 수동 결과가 `failed`와 새 `checkedAt`으로 저장된 것을 확인한 뒤 이전 쓰기를 재개했다. 최종 저장 상태는 **오래된 `checkedAt`의 passed로 되돌아갔다.** 원문·revision·sourceKey·hash는 바꾸지 않았다. 저장소 내부 원자적 변경의 직렬화는 유지한 채 검사 결과 제출 순서만 제어한 재현이다.

수정 방향: 검사 시작 시 저장 버전과 별개로 attempt ID/증가 순번을 예약하고 pending/최종 결과에 같은 식별자를 CAS한다. 최종 반영까지 계정별 직렬화 범위 안에 넣되, 취소/실패 finally의 오래된 쓰기도 최신 시도를 덮지 못하도록 해야 한다. 단순 checkedAt 표시나 source revision 비교만으로 충분하지 않다.

검증해야 할 회귀: 백그라운드→수동 검사, 수동→수동 검사, 저장/재검사/취소가 겹쳐도 가장 최신 시도만 반영되고 원문은 보존됨.

## M2 — 임시 인증 파일 삭제 실패를 프로세스 회수 실패로 처리해 경기 슬롯이 고정됨

- 위치: `backend/src/CoinHunter.Execution.Host/Services/ExecutionManager.cs:273`, `:284`.
- 원인: Node 그룹 dispose와 모든 C# 세션 회수가 끝난 후, private snapshot 삭제까지 성공해야 `resourcesReleased=true`가 된다. `File.Delete` 실패도 같은 catch에서 `cleanup-unconfirmed`로 처리하고 `record.Closed`를 완료하지 않는다. 임시 파일 삭제를 다시 시도하는 경로도 없다.
- 영향: 실제 프로세스·자원 예약이 이미 0이어도 stop 요청이 timeout하고 경기는 활성 슬롯을 계속 차지한다. 파일 잠금을 해제해도 자동으로 종료 상태가 되지 않는다. 이 상태가 반복되면 4경기 제한을 소진할 수 있다. private 파일 삭제가 필요 없다는 의미는 아니다.

Windows에서 준비된 C# 후보 게임의 `csharp-runners.private.json`을 삭제 공유 없이 읽기 핸들로 연 뒤 stop을 호출했다. 관측 결과는 다음과 같다.

```text
Stop: TimeoutException
State: cleanup-unconfirmed
Closed: false
Managed C# hosts: 0
Reserved memory/processes: 0 / 0
파일 잠금 해제 후 Closed: false
```

수정 방향: 실행 자원의 실제 회수 확인과 private 파일 삭제/보유 정리를 분리한다. 자원 회수는 확인된 시점에 종료/슬롯 반환을 완료하고 파일 삭제 실패는 별도의 정리 대기 상태·재시도/운영 지표로 남긴다. 파일 삭제를 성공한 것으로 표시하거나 예외를 무조건 숨겨서는 안 된다.

검증해야 할 회귀: 파일 잠금/일시 I/O 오류에도 프로세스 회수·슬롯 반환이 완료되고, 잠금 해제 후 private 파일이 삭제되며 미확인 프로세스 회수는 여전히 fail-closed로 유지됨.

## 재현 자료와 범위

[재현 관측값](benchmarks/csharp-c4cd-review-2026-11-19.json)에 합성 계정/파일만 사용한 결과를 보관했다. 로컬 임시 재현 프로젝트는 `artifacts/review-451b4db/Review.csproj`이며 원문 코드/사용자 인증정보는 관측 JSON에 포함하지 않는다. 이 프로젝트는 artifacts 정책에 따라 Git 대상에서 제외된다.

```powershell
dotnet build artifacts/review-451b4db/Review.csproj
dotnet artifacts/review-451b4db/bin/Debug/net10.0/Review.dll . game-quota
dotnet artifacts/review-451b4db/bin/Debug/net10.0/Review.dll . receipt-order
dotnet artifacts/review-451b4db/bin/Debug/net10.0/Review.dll . private-file-lock
```

재현은 대상 커밋과 같은 `artifacts/c4d-build`의 실행 assembly를 참조했다. 각 시험은 `artifacts/review-451b4db/run-{GUID}`의 새 저장소와 자신이 생성한 프로세스만 사용했으며 모두 실제 호스트를 정리했다. 실제 사용자 서버/데이터는 수정하지 않았다. 파일 잠금 재현은 Windows 대상이다. 검사 순서 재현의 응답은 제어한 시험 결과이며 실제 AI/외부 서비스 응답을 이용하지 않았다.

일반 경로의 C# 비활성, owner/source/fixture/report 바인딩, 정상 timeout 객체 재사용과 엔진 crash 회수는 기존 검증/코드와 대조했다. 이번 리뷰만으로 모든 오류 경합이나 보안 문제가 없음을 보증하지 않는다. 알려진 레거시 Node 파일 잠금 EPERM, native/GC·Linux·IPC 경로 비용·정식 활성화 관문은 기존 미완료 항목으로 유지한다.

수정 우선순위는 **H1 → M1 → M2**로 제시했다. 리뷰 당시 제품 코드는 수정하지 않았으며, 사용자의 후속 요청으로 진행한 수정 결과는 위의 별도 문서에 보관한다.
