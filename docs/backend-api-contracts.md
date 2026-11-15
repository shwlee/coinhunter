# BE 분리: 기존 공개 API 호환 계약

- 기준일: 2026-11-15, 기존 `src/server.js`, `src/authoring-api.js`, `src/auth/*`, `src/admin-maps-api.js`.
- 구현 상태: 아래 업무 API를 C# 운영/실행 관리로 이전했고 기존 화면은 Node 정적 중계를 통해 연결한다. [완료 결과/제한](backend-split-completion.md), [실행법](../backend/README.md). 실제 사용자 데이터 이전/외부 Google 왕복은 별도다.
- 기계적으로 확인할 목록: `backend/src/CoinHunter.Contracts/ApiCatalog.cs`, Development의 `GET /api/system/contracts`. 기존 36개와 신규 기록 다운로드 1개로 총 37개다.

## 1. 경로·메서드·권한

| 영역                  | 메서드/경로                                                                         | 권한·후속 단계                    |
| --------------------- | ----------------------------------------------------------------------------------- | --------------------------------- |
| 세션                  | GET `/api/session`                                                                  | 공개, 3단계                       |
| Google 시작/콜백      | GET `/api/auth/google/start`, GET `/api/auth/google/callback`                       | 공개 OAuth flow, 3단계            |
| 개발 로그인/로그아웃  | POST `/api/auth/mock`, POST `/api/auth/logout`                                      | 개발/세션 정책, 3단계             |
| 사용자 관리           | GET `/api/admin/users`, PUT `/api/admin/users/{id}`                                 | 관리자, 3단계                     |
| 작성 규약             | GET `/api/algorithm-assistant/contract`                                             | 로그인, 5단계                     |
| 알고리즘 목록/생성    | GET·POST `/api/algorithms`                                                          | 로그인, 5단계                     |
| 코드 검사             | POST `/api/algorithms/validate`                                                     | 로그인, 5단계                     |
| 알고리즘 조회/수정    | GET·PUT `/api/algorithms/{id}`                                                      | 소유자, 5단계                     |
| 원문 다운로드         | GET `/api/algorithms/{id}/source`                                                   | 소유자, 5단계                     |
| 이전 경기             | GET `/api/history`                                                                  | 로그인, 5단계                     |
| 공개 맵/예제          | GET `/api/maps`, GET `/api/example`                                                 | 공개, 5단계                       |
| 맵 기본값             | GET `/api/admin/maps/default-settings`                                              | 관리자, 5단계                     |
| 맵 입력 검사          | POST `/api/admin/maps/validate-array`, POST `/api/admin/maps/validate-json`         | 관리자, 5단계                     |
| 맵 순서               | PUT `/api/admin/maps/order`                                                         | 관리자, 5단계                     |
| 맵 목록/생성          | GET·POST `/api/admin/maps`                                                          | 관리자, 5단계                     |
| 맵 복제               | POST `/api/admin/maps/{id}/copy`                                                    | 관리자, 5단계                     |
| 맵 옵션               | GET·PUT `/api/admin/maps/{id}/settings`                                             | 관리자, 5단계                     |
| 맵 미리보기           | GET `/api/admin/maps/{id}/preview`                                                  | 관리자, 5단계                     |
| 맵 게시/노출          | POST `/api/admin/maps/{id}/publish`, PUT `/api/admin/maps/{id}/visibility`          | 관리자, 5단계                     |
| 맵 초안               | GET·PUT `/api/admin/maps/{id}/draft`                                                | 관리자, 5단계                     |
| 플레이 전 검사        | POST `/api/game/validate`                                                           | 게스트/계정, 6단계                |
| 경기 생성             | POST `/api/matches`                                                                 | 게스트/계정, 재대결은 계정, 6단계 |
| 경기 조회/이벤트/종료 | GET `/api/matches/{id}`, GET `/api/matches/{id}/events`, DELETE `/api/matches/{id}` | 경기 소유 범위, 6단계             |

`/api/ai`와 하위 경로는 제거된 기능으로 410을 유지한다. `/api/system/contracts`는 Development 전용 점검 경로이며 Production에는 404다. 업무 API는 실제 인가/서비스로 처리하며 501 placeholder를 사용하지 않는다. 소유 경기의 `GET /api/matches/{id}/recording`을 추가해 원본 JSONL을 스트리밍한다.

## 2. JSON·오류·식별자

- 공개 JSON은 camelCase를 유지한다. 데이터의 기존 UUID·map id·revision·source 참조 의미를 보존하고 별도 DB ObjectId로 API 식별자를 바꾸지 않는다.
- 세션 응답은 `{user,mock,google,identities}`다. 사용자/알고리즘/맵/기록의 기존 필드는 해당 저장·API 이전 단계에서 계약 검사로 고정한다. 신원 subject나 토큰을 목록에 추가하지 않는다.
- 목록은 `{algorithms}`, `{history}`, `{maps}`, `{users}` wrapper를 유지한다. 알고리즘 목록/metadata에는 원문·물리 파일 경로가 없다.
- 알고리즘 저장은 `name`, 갱신 시 `revision`을 사용하고 충돌은 409다. 사용자 관리의 expected 상태와 맵의 expectedRevision/expected 게시 상태도 유지한다.
- 맵은 schemaVersion/id/revision/name/description/columns/rows/tiles/settings와 draft/published·enabled·표시 순서를 유지한다. 배열의 타일/방향/아이템 의미는 기존 규약을 사용한다.
- 경기 생성 입력은 mapId/dummyCount/blackMatter/destroyWalls/startSlot/characterId/mode와 source 또는 algorithmId다. duel은 opponentHistoryId를 사용하고 임의 다른 사용자 원문 선택으로 바꾸지 않는다.
- 생성 응답은 201 `{id}`다. 조회와 SSE의 snapshot은 `{sequence,game,logs}`다. game의 serverTime과 액션 startedAt/endsAt는 같은 단조 시간 기준의 ms 숫자로 유지하고 UTC 날짜 문자열로 바꾸지 않는다. 메타데이터의 저장 시각과 구분한다.
- 공개 오류는 `{error}`의 읽기 가능한 메시지를 유지한다. 진단 경로의 diagnostic·offset/line/column·단계/로그/생략 수는 기존 의미를 보존한다. -1은 정상 방향값이며 timeout/exception/invalid-result 상태와 구분한다.
- 주요 상태: 입력 400, 미인증 401, 권한 403, 비공개/누락 404, 충돌 409, legacy JSON 경로 크기 413, 타입 415, 동시 제한 429, 저장/환경 실패 500/503/507. 새 호스트의 아직 미이전 경로만 501 `{error,code,requiredStage}`를 사용한다.

## 3. 원문·다운로드·SSE

- 파일 원문은 `text/plain; charset=utf-8` 스트림으로 업로드/다운로드한다. 작은 코드의 기존 JSON 경로도 호환하되 이를 무제한 파일 경로의 크기 정책으로 확장하지 않는다.
- 생성 파일의 이름은 query `name`, 수정 파일은 `name,revision`으로 전달한다. 경기 파일 업로드의 옵션은 `X-Coinhunter-Options` JSON 헤더에 두고 본문에는 코드만 보낸다.
- 코드 다운로드의 `X-Coinhunter-Metadata`는 URI 인코딩한 metadata JSON이다. 예제 다운로드는 Content-Disposition attachment를 유지한다.
- 제품 코드 크기 제한 없음과 별개로 작은 일반 JSON 요청/legacy JSON 경로의 기존 한도와 디스크/동시 업로드 보호는 유지한다. 프록시나 ASP.NET 기본 요청 한도로 파일 경로에 작은 상한을 새로 만들지 않는다.
- SSE는 `Content-Type: text/event-stream`, 이벤트명 `snapshot`, data JSON을 유지한다. 현재 heartbeat는 15초 간격이며 최신 전체 상태 전달·재연결·느린 수신자 정리와 스트리밍을 구현 단계에서 검증한다.
- 화면 상태 sequence는 원본 로그 seq가 아니다. 브라우저 연결 종료는 경기 종료 명령이 아니며, 코드 검사/업로드 연결 취소와 구분한다.

## 4. 쿠키·주소·로그

- 기존 게스트 쿠키 `coinhunter`와 계정 쿠키 `coinhunter-session`은 HttpOnly/Path=/ 정책을 유지한다. 계정 쿠키는 현재 Google에서 SameSite=Lax, 목업에서 Strict다. OAuth flow 쿠키와 함께 복수 Set-Cookie를 분리 전달한다.
- 공개 서비스 URL은 브라우저 Origin·Google 콜백·리다이렉트·Secure 쿠키 판단의 기준이다. 내부 서비스 주소를 공개 콜백으로 사용하지 않는다.
- Host/Origin·신뢰 proxy와 클라이언트 주소·요청 제한·차단 계정 반영은 .NET 이전 뒤에도 검증한다. Node와 .NET의 메모리 세션이 공유된다고 가정하지 않는다.
- 운영 서비스만 세션을 발급한다. 기존 Node 세션과 공유하지 않으며 운영 API 재시작 후 재로그인한다. 게스트 쿠키도 운영 API에서 발급한다.
- 일반 요청 로그에 Cookie/Authorization·OAuth code/state·코드 원문/본문을 남기지 않는다. 기본 요청 URL 진단 로그를 억제하고 공개 오류는 원문 예외와 분리한다.

API별 저장소/인증·실제 코드 검사·게임/SSE·브라우저 흐름을 합성 데이터로 대조했다. [검증 결과와 운영 배포의 남은 범위](backend-split-completion.md)를 함께 확인한다. 기존 초안의 1단계 표현/이전 단계 번호는 작업 이력이다.
