# 첫 웹 구현의 데이터와 API

- 기준일: 2026-09-27
- 최초 게스트 API 기록이다. 2026-09-29 추가된 목업 계정·영구 파일 저장·작성 API의 현재 사용법은 [로컬 작업실](local-authoring.md)을 참고한다.

## HTTP

| 메서드·경로 | 요청 | 응답 |
| --- | --- | --- |
| GET /api/maps | 없음 | 서버 등록 맵·설정 목록 |
| GET /api/example | 없음 | 다운로드 가능한 샘플 JS 파일 |
| POST /api/matches | `text/plain` 코드 본문과 `X-Coinhunter-Options` JSON 헤더(mapId, dummyCount, blackMatter, destroyWalls, characterId, startSlot 등) | 준비 완료 후 경기 id |
| GET /api/matches/:id | 게스트 세션 쿠키 | 최신 상태·로그 |
| GET /api/matches/:id/events | 게스트 세션 쿠키 | SSE snapshot 이벤트 |
| DELETE /api/matches/:id | 게스트 세션 쿠키 | 경기 종료·프로세스 정리 후 ok |
| POST /api/algorithms/validate | 로그인 쿠키와 `text/plain` 코드 본문 | 별도 프로세스 검사 결과 |
| POST /api/algorithms?name=... | 로그인 쿠키와 `text/plain` 코드 본문 | 새 알고리즘 메타데이터 |
| PUT /api/algorithms/:id?name=...&revision=... | 로그인 쿠키와 `text/plain` 코드 본문 | 갱신된 메타데이터 |
| GET /api/algorithms/:id?metadata=1 | 로그인 쿠키 | 원문을 제외한 메타데이터 |
| GET /api/algorithms/:id/source | 로그인 쿠키 | 원문 파일 스트림 |

작은 설정 요청은 JSON으로 전달한다. 코드가 포함된 이전 JSON 형식은 2 MiB 이내에서 호환 처리하며, 새 화면은 코드를 `text/plain`으로 임시 파일에 스트리밍한다. 다른 세션 경기에는 404를 반환한다. 같은 세션의 동시 경기는 한 개, 서버 전체 초기 한도는 네 경기다. 준비 중 경기도 한도에 포함한다. 게스트 식별 쿠키는 HttpOnly/SameSite=Strict이며 제품 계정 인증을 대체하지 않는다.

현재 서버는 127.0.0.1 바인딩과 localhost/127.0.0.1 Host·Origin 검사만 지원한다. 실제 사내 호스트·TLS·프록시는 배포 단계에서 별도 설정한다.

`characterId`는 pengko, nyangtami, dino, lumi 중 하나이며 생략 시 pengko다. `startSlot`은 0(왼쪽 위), 1(오른쪽 위), 2(왼쪽 아래), 3(오른쪽 아래)의 정수이며 생략 시 0이다. 잘못된 값에는 400을 반환한다. 더미는 남은 모서리에 번호순으로 배치한다. 플레이어 ID와 initialize의 myNumber는 시작 위치에 따라 바뀌지 않는다. 상태의 `players[].characterId`와 `players[].startSlot`으로 선택값을 복원한다.

## 실시간 상태

snapshot 이벤트는 sequence, game, logs를 포함한다. game에는 서버 시각, 맵 크기·타일·아이템, 플레이어 상태, 경기 상태·종료 사유·남은 시간이 포함된다. 최초 연결과 재연결 시 최신 전체 상태를 보낸다.

플레이어에는 id, name, position, score, turn, effect, action, thinking, lastStatus가 있다. action에는 type, from, to, startedAt, endsAt, effectId가 있다. 브라우저는 서버 시각과 수신 시점으로 애니메이션 시간을 보정한다.

통신은 전체 상태를 보내는 첫 구현이다. 연결 버퍼가 과도하게 누적되면 연결을 종료하여 재연결하게 한다. 향후 동시 경기 부하 검증 후 이벤트 증분 전송 여부를 결정한다.

## 프로세스 통신

Node IPC 메시지는 id, type, payload로 구성한다. type은 initialize, move, close다. 응답은 같은 id와 ok/result 또는 error를 포함한다. 부모의 요청 맵으로 결과를 연결하며 동일 플레이어의 move 중첩을 거부한다.

move 결과는 status, value, elapsedMs, logs, droppedLogs, pid를 포함한다. pid는 내부 검증용이며 브라우저 경기 상태에는 포함하지 않는다.

## 보관 범위

- 경기별 코드와 맵은 시작 시 복사하여 실행한다.
- 업로드한 코드는 임시 파일에 기록하고 경기 실행 프로세스에서 읽는다. 경기 종료 후 임시 파일을 지우며, 로그인 계정의 완료 경기 기록에는 당시 코드를 별도 영구 파일로 복사한다.
- 완료 경기는 최대 약 5분(정리 검사 간격 30초) 동안 메모리에 남는다.
- 실행 로그는 최근 40개 출력/오류 이벤트를 보관한다. 턴별 메시지는 별도 출력 제한을 적용한다.
- 서버 재시작 시 경기와 결과는 사라진다.

계정 데이터와 알고리즘·완료 경기 기록은 [저장 어댑터](storage-adapters.md)의 파일 저장소를 사용한다. 코드 이력 기능은 추가하지 않는다.
