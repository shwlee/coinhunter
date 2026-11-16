# J3 검사 포화·재시작·동시 게임 검증

2026-11-16. 선행 J2를 `19a4643`으로 커밋한 뒤 수행했다. J3 수정/시험은 아직 커밋하지 않았다.

## 결과와 수정

| 검증                     | 방식                                                                 | 확인 결과                                                                                                 |
| ------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 저장 검사 queue 포화     | 실제 C# 서비스 + 중단 지점을 제어하는 합성 HTTP 응답, 21개 합성 계정 | active 1 + queued 16, 초과 4개 unverified. 원문 21개 모두 보존                                            |
| 계정별 대기·취소         | 동일 계정 active 1 + waiter 3, 추가 요청과 waiter 취소               | 초과 요청 429, 취소된 waiter는 실제 실행 안 함, 이후 슬롯 회수                                            |
| 정상 종료                | 검사 응답을 대기 중인 서비스 종료                                    | active 요청 취소·queue 소진·pending 해소·snapshot 회수                                                    |
| 재시작 복구              | pending·부분 copy·소유 lease를 만든 뒤 서비스 재생성                 | 자동 무제한 재실행 없이 unverified로 복구, 명시적 재검사 통과. 관련 없는 game snapshot 보존               |
| 예약 키 충돌             | 기존 코드와 다른 writer의 temporary 파일에 같은 키 사용              | overwrite/삭제 거부, 기존 bytes 보존                                                                      |
| 실제 검사 포화           | 분리 서버에서 guest 검사 12개 동시 요청                              | 허용된 요청은 실제 QuickJS timeout으로 검사 실패, 초과는 429. 운영 API·같은 game PID의 snapshot 진행 유지 |
| 실제 운영 서버 강제 종료 | active 검사 snapshot lease를 확인한 뒤 시험 Operations만 종료·재시작 | pending→unverified, 이전 검사 버전→stale, 원문 보존, 기존 game engine PID/진행 유지                       |
| 복구 후 정리             | 본인 재검사·게임 종료와 검사 directory 확인                          | 재검사 passed, 검사 임시 snapshot·lease 회수. 경기 기록이 참조하는 exchange 파일은 유지                   |
| 동시 게임/검사/저장      | 게임 4개×플레이어 4개, SSE 4개, 실제 검사·업로드/저장·맵 읽기        | 엔진 4개/실행기 16개 관측. 5번째 게임 429, timeout 후 동일 객체/필드와 빠른 참가자 독립 진행 유지         |
| 게임/실행 서비스 장애    | 시험 엔진과 Execution host 종료/재시작                               | 실패/partial 기록과 durable prefix, readiness 실패 및 terminal 복구 확인                                  |

첫 다계정 시험에서 startup recovery와 첫 Queue 요청의 경합을 발견했다. 복구를 ExecuteAsync 안에서 수행하면 새 pending job을 이전 서버의 미완료 기록처럼 unverified로 바꿀 수 있었다. `StartAsync`가 복구 완료를 기다린 뒤 worker/서비스를 시작하도록 수정했다. 21개 계정의 예상 pending 개수를 실제 저장 상태로 검사해 재발을 방지한다.

백그라운드 검사 snapshot에는 copy 전에 `DataRoot/validation-leases/<GUID>.json` 소유 기록을 원자적으로 남긴다. 새로 예약한 GUID로 기존 FileSourceStore의 스트리밍·디스크 여유 확인·temporary/rename·hash 경로를 재사용한다. 정상 종료 시 원문 snapshot·부분 temporary·lease를 정리하고, 재시작은 소유 기록이 있는 것만 회수한다. 임의 exchange 파일을 일괄 삭제하지 않는다. 삭제 IO 실패 시 소유 기록을 유지해 다음 시작에서 재시도한다. 과거 J2 이전에 소유 기록 없이 남은 파일까지 자동 추정 삭제하는 것은 아니다.

예약 키를 받는 내부 PutReserved 경로를 추가하면서 collision 시 기존 완성 파일이나 다른 writer의 temporary를 지우지 않게 소유 플래그를 뒀다. 원래 원문 파일의 크기 상한·보관 방식은 바꾸지 않았다. source stream/hash/디스크 여유 보호를 새 copy 코드로 우회하지 않는다.

## 시험의 범위와 재현

```powershell
$env:COINHUNTER_BUILD_ROOT = 'artifacts/j2-build'
npm run backend:test
npm run backend:test:validation-lifecycle
npm run backend:test:load
```

로드 시험의 Windows 프로세스 조회에는 WMI 읽기 권한이 필요했다. 샌드박스 내 실행은 access denied로 종료됐고 허용된 권한으로 시험 프로세스만 조회해 재실행했다. 결과를 얻지 못한 실행을 부하 검증 통과로 표시하지 않았다.

J2에 추가한 실행 전 검사 때문에 기존 load fixture는 preflight에서 먼저 거부됐다. 신뢰된 fault fixture를 실제 게임의 10×10 입력에서만 timeout이 발생하도록 조정했고, 사전 검사 입력에서는 유효한 값을 반환한다. 실제 게임 시간/액션 시간을 늘려 4개 게임을 동시에 관측했다. 제품 500ms를 늘리거나 검사를 우회하는 제품 옵션을 추가하지 않았다. 유한한 검사 통과 후 처음 나타나는 입력에서도 게임 중 보호가 필요함을 시험한다.

제어 가능한 HTTP 응답을 쓴 C# queue/취소 시험은 서비스 동시성 검증이며 실제 알고리즘 실행/처리량 수치가 아니다. 별도의 실제 QuickJS/프로세스/게임 시험으로 이를 보완했다. Windows 로컬 관측 결과이며 다국어 채택·Linux 배포·최대 서비스 용량 보장을 의미하지 않는다.

닷넷 계약 35건+업무 19건=54건, 분리 BE 통합 13그룹·프로토콜 5건, 실제 J3 lifecycle 3그룹과 4게임 부하·장애 흐름을 통과했다. 빌드 경고/오류 0개. 기존 게임과 코드 보관을 유지하는 회귀에 한정해 검사했으며 새 JS/FE 제품 코드 변경은 없다. 사용자 서버/계정·외부 AI는 사용하지 않았다.

부하 원본은 [J3 자원 측정](benchmarks/validation-j3-load-2026-11-16.json)에 보관했다. WorkingSet 합은 공유 페이지를 포함하므로 고유 RSS나 서버 용량으로 해석하지 않는다. CPU는 누적 관측값이며 샘플 간 차이와 기간을 함께 봐야 한다.

## 남은 작업

J3 집중 검증과 발견된 동시성/소유 파일 복구 수정은 완료했다. 저장 검사의 영속 자동 재생 queue·passed 캐시 최적화·다국어 OS 강제 자원 한도·시간/유예 계약은 이번 범위가 아니다. 공통 프로세스 자원 기반(R0)과 C# 규약 분석/중단 후보가 다음 순서다. JS의 동적 간접 호출·전체 상태 분석·낮은 수준 재귀 장애 분류는 기존 미완료 범위로 유지한다.
