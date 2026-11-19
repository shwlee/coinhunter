# C# C3 전용 호스트·IPC·감시 후보

작성: 2026-11-19. [C2 guard](csharp-budget-c2.md)에 전용 .NET 호스트와 독립 관리 채널을 연결한 개발자용 후보 실험이다. 실제 게임 registry·작업실/API의 지원 언어는 여전히 JavaScript 하나다.

## 배치와 채널

`CoinHunter.CSharp.Host` 실행 파일은 플레이어 하나를 소유한다. 부모 시험 드라이버가 R0 그룹을 만들고 프로세스를 배치한 뒤 stdin으로 `authorize`를 보낸다. 그 전에는 원문 읽기·컴파일·사용자 assembly 로드를 수행하지 않는다. `authorize`는 실행 순서 gate이며 외부 사용자 인증 토큰이 아니다.

- stdin/stdout: 판단 명령과 ready·execution-started·deadline-reached·execution-settled·closed 이벤트. 계산은 전용 스레드 하나에서 직렬 실행한다.
- 별도 named pipe: ping/stop 제어. 무작위 pipe 이름과 CurrentUserOnly 옵션을 사용하며 공개 TCP 포트를 만들지 않는다.
- 별도 감시 task: 활성 host budget을 관측한다. 계산 스레드가 멈춰도 deadline 통보·관리 채널은 계속 진행할 수 있다.

실험 부모는 OS/.NET 실행에 필요한 환경변수만 자식에게 전달한다. host에는 계정/OAuth 키나 다른 서비스 설정을 전달하지 않는다. 파일/네트워크 접근 통제 자체를 구현한 것은 아니다.

원문 경로와 pipe 이름은 신뢰된 부모가 실행 인자로 지정한다. 이 인터페이스는 소유권 검사를 하는 공개 업로드 API가 아니다. 샘플 초기화는 3×3으로 고정되어 있으며 임의 경기의 정식 초기화 계약·준비 artifact 참조는 C4 이후 연결한다.

## 호출과 시간 계약

부모의 IPC 송신부터 500ms를 재지 않는다. host가 입력 배열 복사를 마치고 C2 실행 scope에 진입할 때 단조 시계의 StartedTicks와 callId를 발급한다. 범위는 reflection dispatch/JIT·관측 callback·사용자 실행·정리까지다. 시작 통보 callback은 출력 channel에 이벤트를 넣으며 부모 수신을 기다리지 않는다. 각 이벤트에 host ticks를 포함한다.

generation은 프로세스 수명 UUID, InstanceId는 Player 후보 인스턴스 UUID, CallId는 Construct/Initialize/GetName/MoveNext에 걸친 순차 번호다. 부모 요청 ID는 같은 프로세스 수명에서 재사용하지 않는다. 출력은 해당 요청·generation·instance/call을 연결한다.

| 통보              | 의미                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| execution-started | host가 예산 구간에 진입함. 부모 전송 시각과 다름                                                   |
| deadline-reached  | 활성 호출의 마감을 독립 감시자가 관측함. 호출 종료를 뜻하지 않음                                   |
| execution-settled | 실제 호출 반환/예외 unwind와 host의 최종 시간 판정이 끝남                                          |
| stop-requested    | 중단 요청을 수락함. 정리 완료를 뜻하지 않음                                                        |
| closed            | worker가 끝나고 후보 Dispose 경로를 거침. 부모는 추가로 프로세스 종료·그룹 비어 있음을 확인해야 함 |

마감과 실제 완료가 가까우면 독립 감시 통보보다 settled가 먼저 올 수 있다. settled의 host 소유 DeadlineReached 판정이 최종 결과다. deadline 통보 유무만으로 정상 값을 승인하지 않는다. 출력 전달은 별도 task가 수행한다.

busy는 실제 결과가 생성될 때까지 유지한다. 중첩/중복 요청은 거절한다. settled 발행과 슬롯 반환을 같은 lock 안에서 처리해, 부모가 결과를 받고 곧바로 다음 요청을 보내도 불필요하게 busy로 거절되지 않도록 했다. 빠른 정상 호출을 500ms까지 기다리게 하는 동작은 없다.

ping의 host ticks/frequency와 부모 송수신 시각을 기록했다. Windows 시험에서는 같은 frequency와 host timestamp가 부모 RTT 구간 안에 들어오는 것을 확인했다. [원본](benchmarks/csharp-c3-2026-11-19.json)의 clock sample은 offset의 가능한 구간을 제공하며 정확한 단일 offset 추정값이 아니다. 호출 판정은 host 내부 duration을 사용한다. 다른 OS·배포 환경의 시계 대응까지 검증한 것으로 표시하지 않는다.

## 중단·복구

stop/입력 EOF/관리 채널 단절 시 host 소유 stop 상태를 설정한다. 다음 guard에서 예외로 실제 호출을 끝내고 신규 판단을 받지 않는다. 최종 마감 상태는 예외 타입이나 중단 요청보다 우선한다. 정상 timeout 뒤에는 같은 객체/PID를 계속 사용한다.

긴 builtin 또는 guard 밖에서 정지한 worker는 stop을 받았다는 이유만으로 종료된 것으로 표시하지 않는다. 부모가 시험용 watchdog/그룹 종료를 수행하고 실제 종료를 확인한다. 새 호스트는 새 generation/객체이며 상태를 복원했다고 주장하지 않는다.

이 강제 정리·재생성은 **인프라 복구 실험**이다. 게임의 정상 timeout마다 프로세스를 교체하거나 새로운 실격/재시작 규칙을 적용하지 않았다. 정리 유예 시간·반복 실패·상태 복원 정책은 여전히 제품 결정 전이다.

시작 통보 전 정지한 후보는 아직 사용자 실행 scope를 얻지 못했다. 부모의 준비/dispatch watchdog 대상이며 사용자 계산 500ms timeout으로 분류하지 않는다. 실험은 이 경로와 guard 밖 정지 경로를 신뢰된 부모만 지정하는 fault injection 실행 인자로 만들었다. 사용자 알고리즘에 sleep API를 허용한 것이 아니다.

입력 frame은 누적 중 길이를 검사하며 데이터 1 Mi 문자·제어 64문자 한도를 둔다. JSON 미지정 필드·필수 값/범위를 검사한다. 이것은 소스 파일 크기 제한이 아니다. 출력 channel·pending 명령·요청 ID 수에도 실험 한도를 두고 포화 시 실행을 종료하거나 거절한다. 이 프로토콜/한도는 정식 공통 wire 계약으로 등록하지 않았다.

## 검증

Windows의 격리된 합성 데이터·별도 `artifacts/c3-build`에서 C3 확인 30개를 통과했다.

- 같은 프로세스에서 timeout→정상 호출 3회 반복, 동일 PID/InstanceId·필드/호출 순서 보존.
- 중복 ID와 계산 중 중첩 요청 거절, 결과 직후 후속 호출 수락.
- guard 밖 2초 지연 중 deadline 통보, 독립 ping, 다른 host의 정상 계산, 늦은 방향 거절.
- 시작 통보 누락 시 사용자 timeout으로 오분류하지 않음.
- 계산 중 stop·stdin EOF와 malformed 입력의 종료 경로, stop ack와 settled 구분.
- 무기한 worker 정지 시 관리 응답 유지, 부모의 OS 그룹 강제 종료/완전 drain, 새 generation·초기 상태 확인.
- 종료 후 모든 그룹의 메모리/프로세스 예약 합계 0.

OS 그룹 프로필은 host당 메모리 768 MiB, Windows 프로세스 2개/Linux task 128개, CPU rate 10000이다. 시험 watchdog은 ready/이벤트 15초·연결 10초·제어 3초·정리 10초 등 개발자 시험 실패 경계이며 운영 grace 정책이 아니다.

최종 전체 BE 회귀에서 C1 52건, C2 149개 확인, C3 30개 확인, 기존 .NET 계약/업무/OS 59건과 BE 통합 13그룹·프로토콜 5건을 통과했다. 빌드 경고/오류는 0개다. [기존 Node legacy 파일 잠금 문제](remaining-work.md)는 별도 미해결로 유지한다.

재현:

```powershell
$env:COINHUNTER_BUILD_ROOT='artifacts/c3-build'
node scripts/backend.js build
dotnet artifacts/c3-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-host
```

## 남은 관문

1. C2의 긴 builtin/GC 실제 중단 한계와 허용 프로필 조정. 이 호스트가 .NET native 연산을 선점하는 것은 아니다.
2. C3 후속: 실제 OS별 시계/부모 장애·컴파일/JIT/예비 호스트 비용, 제품용 독립 감시·watchdog와 복구 정책 확정. 현재 parent driver는 시험 프로젝트에 있다.
3. C4: 격리된 준비/컴파일과 artifact hash/cache·lease·원본 위치·소유권, 공통 검사/저장·운영 API·Node 어댑터 연결.
4. Linux cgroup/부모 장애 감독, 혼합 언어·부하·보안 경계의 실제 검증 후 C5 판정.

게임 엔진이 이 호스트를 정식 C# runner로 생성하는 연결과 FE 언어 선택은 아직 구현하지 않았다. 실제 사용자 서버·계정 데이터는 변경하지 않았고 C1~C3 새 변경은 커밋/푸시하지 않았다.
