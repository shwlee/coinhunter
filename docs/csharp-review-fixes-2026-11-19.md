# C# 적대적 리뷰 3건 수정

대상: `781b5cb`의 [적대적 리뷰](csharp-adversarial-review-2026-11-19.md). 작성: 2026-11-19. 세 건을 수정하고 각 재현 입력과 정상 경로를 회귀 검사에 추가했다. 현재 변경은 커밋/푸시하지 않았다.

## R1 — 의미 타입 검사 보완

`PlayerAnalyzer`가 선언 외의 캐스트 대상과 foreach 변수 타입도 검사한다. 표현식의 의미 타입이 dynamic이면 AP001로 거절하므로 dynamic member/indexer/operator가 심볼을 해석하지 못한 채 통과하지 않는다. 단순 문자열 이름 검사가 아니라 Roslyn의 타입을 사용해 alias도 같은 규칙을 받는다.

리뷰의 Dictionary 동적 인덱서·List 동적 Capacity는 이제 `StaticPassed=false`다. object/dynamic foreach·object 캐스트도 거절한다. var/int 배열 foreach와 승인한 숫자/배열 캐스트, uint/ulong 배열 길이는 유지한다. 분석기 버전은 `c1-3`으로 올리고 기계 판독 프로필에 반영했다. 프로필 이름/guard 삽입 버전은 유지한다.

## R2 — 이름 결과 계약

`CSharpCandidate.GetName`이 실제 반환값을 검사한다. null은 `invalid-result`, 진단 AR013로 반환하며 준비 성공으로 처리하지 않는다. 마감이 겹치면 기존 host 소유 timeout 판정이 우선한다.

기존 JavaScript와 같이 빈 문자열/공백은 string 값으로 허용하고 표시 이름은 최대 40 UTF-16 단위로 정규화한다. 길이를 줄일 때 surrogate pair를 자르지 않는다. 한글·빈 문자열·공백·긴 한글/emoji 경계를 회귀 검사에 포함했다.

부모도 준비의 이름 결과를 독립 확인하고, 유효한 string 결과가 없으면 ready를 승인하지 않는다. null 이름은 일반 host 장애 대신 `invalid-name`으로 분류하고 실제 프로세스/자원 회수 후 실패를 돌려준다. 신뢰된 시험 호스트가 `status=ok,value=null`을 보내는 경우도 차단한다. 이는 이전/잘못된 호스트 응답을 상태 코드만 보고 승인하는 일을 막는다.

## R3 — 송신 전 입력 오류와 실행 장애 분리

parent가 로컬 검증·복사·직렬화를 마친 뒤에만 pending/computing 상태를 확정한다. 검증 중에는 같은 lock으로 다른 호출/stop과 경합을 관리한다. 명백한 과대 배열은 복사 전 거절하며, 나머지 JSON은 길이가 제한된 stream에 기록해 한도를 넘으면 추가 누적을 막는다. 현재 판단 frame은 정수/ID 데이터만 포함하므로 UTF-8 byte 길이와 전송 문자 길이가 같다.

로컬 입력 오류는 ArgumentException으로 돌려주고 ready·PID/generation/instance를 유지한다. 송신을 시작한 뒤의 IPC 오류·시작 통보 누락·미종료 감시는 기존 강제 회수 경로를 유지한다. 송신 전 취소는 pending을 만들지 않고, 송신 후 취소는 기존 실제 정리 확인을 수행한다.

회귀 입력은 600,000개의 0(복사 전 거절)과 100,000개의 int.MinValue(실제 직렬화 길이 초과)다. 두 거절 뒤 같은 객체에서 다음 CallId가 1만 증가하고 turn도 정상 증가하는 것을 확인한다. 빈 pending이나 유령 호출을 만들지 않는다.

## 검증

- 분석 검사: 기존 52 + 새 10 = 62건.
- 예산/정책/이름: 기존 211 + 새 12 = 223개 확인.
- IPC 호스트: 30개 확인.
- 운영 부모: 기존 37 + 새 5 = 42개 확인.
- 기존 .NET 계약/업무/Windows OS: 59건, BE 통합 13그룹·프로토콜 5건.
- 빌드 경고/오류 0개, 별도 `artifacts/review-fix-build`·합성 데이터/OS 제한 프로세스 사용. 실제 사용자 서버·계정·알고리즘은 유지했다.

리뷰 당시 개발자 프로브도 다시 실행했다. 동적 접근/foreach는 분석 단계에서 거절됐고, null 이름은 `invalid-name`과 정리 확인으로 실패했다. 과대 입력 2건 뒤 상태는 ready이고 다음 정상 호출은 같은 instance에서 성공했다.

이번 수정으로 C#을 게임에 활성화하지 않는다. native/GC의 강제 선점, Linux 실측, 운영 정책·C4 연결 등 기존 관문은 유지한다.
