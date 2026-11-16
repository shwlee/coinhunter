# 저장·코드 검사 상태·실행 허가 연결

2026-11-16. 선행 JS 검사 확장을 `6e12470`으로 커밋한 뒤 J2 연결을 구현했다. 이 변경분은 아직 커밋하지 않았다.

## 사용자 흐름

원문 파일과 이름/revision을 먼저 저장한다. 저장 후 bounded 백그라운드 검사를 요청하고 API는 저장 결과와 검사 상태를 반환한다. 문법·규약·실행 오류와 500ms 초과는 코드 저장을 취소하지 않는다. 인증·소유권·revision 충돌·파일/메타데이터 쓰기 오류는 기존처럼 저장 실패다.

작업실은 저장 완료를 즉시 표시하고 최대 45회/초당 1회 현재 문서 검사 상태를 조회한다. 통과/실패·진단을 별도로 표시하며 코드/문서/revision 변경이나 수동 검사 시작 시 이전 조회가 현재 화면을 덮어쓰지 않는다. 검사 실패 코드도 저장됨 상태·재불러오기를 유지한다. 조회 지연/실패는 코드를 삭제하지 않고 다시 검사할 수 있게 안내한다.

## 운영 BE 구조

- `AlgorithmValidationService`: singleton hosted service, 백그라운드 queue 16개·worker 1개, 계정별 백그라운드 job 1개. 같은 revision 재요청은 진행 중 job과 합치고, 다른 revision/전체 한도 초과는 저장 성공+unverified로 안내한다. 자동 검사와 수동/실행 전 검사는 동일 계정 scope에서 직렬화하며 대기/실행 합계 최대 4개다. 이 계정 gate는 마지막 사용 후 회수한다.
- `AccountService`: 저장할 때 source hash와 unverified 상태를 부여한다. 검사 결과는 owner/id/revision/sourceKey를 모두 비교해 갱신한다. 현재 계정이 비활성이면 결과를 게시하지 않는다. 이전 revision의 늦은 결과가 새 코드의 상태를 덮어쓰지 않는다.
- 원문은 기존 immutable 파일 스토어에 유지하고 상태/버전/hash/진단은 계정 metadata에 보관한다. 파일 copy/read lease로 검사할 exchange snapshot을 만들고 정리한다. 소스 크기의 새 제품 상한은 도입하지 않았다.
- 상태: pending/passed/failed/unverified/stale. 재시작 시 pending은 unverified, 기록이 없거나 현재 검사 버전과 다른 코드는 stale로 바꾼다. 서버 재시작에 걸친 검사를 자동 재생하는 영속 queue는 구현하지 않았다. 원문 보존과 명시적 재검사로 복구한다.
- `POST /api/algorithms/{id}/validate`: 본인의 현재 저장 revision을 재검사 queue에 요청한다. 기존 수동 `/api/algorithms/validate`도 동일 hash의 저장 문서를 검사 시작 시 snapshot으로 잡아 현재 revision/sourceKey가 유지되는 경우에만 결과를 반영한다.
- 저장 응답/조회는 상태를 포함한다. 코드 다운로드의 metadata HTTP 헤더에서는 큰 diagnostic/debug 로그를 제외하고 전체 진단은 JSON 조회 경로로 제공한다.

검사 서비스의 환경 실패/포화/계정 중지/취소는 일반적으로 unverified이며 코드 보관 성공과 분리한다. 백그라운드 queue는 전체/계정 한도에서 넘어간 작업을 무제한 대기시키지 않는다. 프로세스 종료 시 active 검사를 취소하고 queue 잔여 기록을 unverified로 바꾼다. 비정상 종료로 남은 pending은 다음 시작에서 복구한다. 드문 exchange 삭제 IO 실패는 offline reconciliation 대상이며 보관된 원문 삭제로 대신하지 않는다.

## 실행 허가

공개 Match 생성 경로에서 사용자 입력·소유권·중복 요청·진행 중 경기 확인 후, 사용자 코드 snapshot을 실제 36회 preflight로 **매번 새로 검사**한다. 업로드, 저장 알고리즘, 작업실 테스트가 같은 경로를 사용하며 이전 경기 대결의 상대 snapshot도 검사한다. 더미는 서버 제공 코드이므로 이 사용자 재검사에서 제외한다.

클라이언트의 validated 플래그, 저장 성공, 기존 passed metadata만으로 허가하지 않는다. 검사 실패나 서비스 실패·검사 프로필/fixture 불일치면 게임 준비를 거부하고 snapshot을 정리한다. active 계정 여부를 검사 전후와 경기 기록 commit 시 확인한다. idempotent 재요청은 기존 경기로 돌아가고 이미 진행 중인 경기는 새 검사로 재시작하지 않는다.

현재 metadata version은 JS preflight v2/fixture 2.0.0/500ms/32MiB/생성 규약 contentVersion을 포함한다. 전체 언어·런타임/분석기/OS 자원 버전의 capability 교환은 후속이다. 이 한계 때문에 persisted passed를 실행 캐시로 재사용하지 않고 실제 snapshot을 새로 검사한다. 이후 캐시 최적화 시 전체 identity·유효기간·서비스 버전 검증을 먼저 구현해야 한다. 실행 전 검사가 늘어나므로 시작 요청의 준비 시간이 증가한다.

내부 execution endpoint는 서비스 인증 경계 안에 있으며 공개 API의 사전 검사/소유권을 신뢰한다. `start:legacy`의 Node 운영 API에 새 상태 모델을 포팅한 것은 아니다. 기본 분리 BE를 기준으로 구현했다. 새 공통 규약 전체의 간접 호출/승인 API 분석이 완료된 것으로 표시하지 않는다.

## 검증과 다음 범위

검증 대상:

- C# 저장 상태의 owner/revision/source 참조 CAS, 진단 deep clone, pending 재시작 복구.
- 실제 BE에서 문법 오류/timeout 코드 저장 및 재불러오기, 본인 재검사·타인/게스트 차단, 수정 revision 통과와 hash 연결.
- 잘못된 저장 코드·게스트 업로드의 직접 게임 API 요청 거부, 클라이언트 validated 위조 무시, 정상 코드 경기 시작.
- 늦은 이전 revision의 timeout이 새 코드를 실패로 바꾸지 않음. 실행 서비스 중단 시 저장 성공·unverified 유지.
- 브라우저에서 저장 후 자동 상태 표시, 실패 코드 저장 시 미저장 경고 없음, 정상 코드로 수정/덮어쓰기 후 통과, 기존 테스트 iframe·맵 관리·게임 UI 회귀.

새 검사/저장 통합 시험 명령은 `npm run backend:test:validation`이며 먼저 현재 BE를 빌드해야 한다. 사용자 서버의 DLL 잠금과 데이터 보호를 위해 `COINHUNTER_BUILD_ROOT=artifacts/j2-build`의 별도 산출물과 합성 데이터/임시 포트를 사용한다. 사용자 서버는 재시작하지 않았다.

검증 결과: 닷넷 계약 35건·업무 14건(합계 49건), 실제 분리 BE 통합 13그룹·프로토콜 5건, 신규 저장/검사 통합 6그룹, 확장된 실제 브라우저 흐름과 3개 화면 폭, Node 전체 289건(동시 수 2) 통과. 빌드 경고/오류 0개, 변경 JS/문서 형식·diff 검사를 통과했다. 같은 계정 자동/수동 검사 충돌과 동일 job 재요청 시 완료 상태를 pending으로 덮는 경합을 수정한 뒤 관련 회귀를 재실행했다.

후속 [J3 검증/수정](validation-lifecycle-j3-results.md)에서 queue 포화·재시작/복구·게임과 검사 동시 부하를 확인했다. 시작 복구가 요청보다 먼저 완료되게 하고 백그라운드 snapshot 소유 lease를 추가해 부분 copy/강제 종료 후 회수한다. 위 소유 기록 없는 J2 당시 파일은 자동 추정 삭제하지 않는다. 전체 다국어 준비/어댑터와 OS 강제 자원 한도(R0~R5), J1의 미해석 호출/전체 상태 분석은 별도 미완료다. 실제 배포 시 서버 정상 재시작과 프런트 새로고침이 필요하다.
