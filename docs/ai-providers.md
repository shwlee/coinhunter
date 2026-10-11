# AI 제공자 연결 확인·모델 조회 — 3단계

이 문서는 3단계 당시 범위다. 현재 HTTP·UI·공통 검증 경로는 [4단계 연결 UI 문서](ai-connections-ui.md)를 참고한다.

## 구현 범위

`src/ai/providers.js`는 Claude·OpenAI·Gemini의 `checkConnection`과 `listModels`를 구현한다. Node 18의 서버 `fetch`를 사용하며 자격 증명은 인증 헤더로만 전달한다. 외부 주소는 어댑터에 고정하고 리디렉션은 거부한다. 사용자가 임의 주소를 지정할 수 없으며 승인된 중계 경로는 배포 준비 때 서버 전송 계층에서 별도로 구현한다.

| 제공자 | 모델 목록 주소 | 인증 | 페이지 처리 |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1/models` | `Authorization: Bearer …` | 현재 문서상 단일 목록 |
| Claude | `https://api.anthropic.com/v1/models` | `x-api-key`, `anthropic-version: 2023-06-01` | `has_more`, `last_id` → `after_id` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/models` | `x-goog-api-key` | `nextPageToken` → `pageToken` |

모델 식별자·표시 이름을 공통 형식으로 반환한다. Gemini는 `generateContent` 지원 항목만 포함하고 `models/` 접두사를 제거한다. OpenAI 목록에는 임베딩·음성 등 다른 용도의 모델도 포함될 수 있으므로 이름 추측으로 지원 모델을 고정하거나 생성 가능하다고 단정하지 않는다. 모든 모델의 `generationVerified`는 현재 `false`이며 실제 생성 지원·권한·과금 한도는 생성 어댑터 단계에서 검증한다. 조회 성공과 선택 가능한 모델이 없는 상태는 다르다.

`checkConnection`은 첫 페이지를 읽어 자격 증명과 모델 조회 권한을 확인한다. 실제 코드 생성은 호출하지 않는다. 401/403, 요청 제한, 네트워크 실패, 제공자 장애, 시간 초과, 취소, 잘못된 응답을 공통 오류로 구분한다. 제공자의 원본 오류·응답 본문·전송 예외는 반환하거나 로그로 출력하지 않는다.

## 모델 카탈로그와 수명

`src/ai/model-catalog.js`는 저장 계층의 소유권 검사를 거친 뒤 키를 내부에서 해석하고 모델 목록 전체를 조회한다. 파일 저장소 잠금 안에서 외부 호출을 하지 않는다. 제공자 정책과 실제 반환 목록의 교집합만 제공하며 허용 목록에만 존재하는 모델을 새로 만들지 않는다.

- 캐시는 계정·로그인 세션·연결·리비전으로 분리한다. 키 원문·응답 본문은 캐시에 보관하지 않는다.
- `cached`는 외부 호출 없이 `not_loaded`, `ready`, `stale` 상태와 목록·확인 시각을 반환한다. `stale`은 갱신 실패 뒤 남은 참고 목록이며 생성 허가를 의미하지 않는다. 인증/조회 권한 거부 시 이전 목록도 제거한다.
- `refresh`는 최대 20페이지·1,000개 모델을 조회한다. 한 페이지 본문은 1 MiB 이내다. 초과·순환 커서는 오류이며 일부 목록을 성공으로 제공하지 않는다. 이 제한은 알고리즘 코드 크기와 관계없다.
- 기본 캐시 수명은 5분이며 최대 128개 카탈로그를 메모리에 보관한다. 재시작 시 사라진다.
- 조회 동시 한도는 전체 2개·계정별 1개, 시작 간격은 계정별 1초다. 재시도·제공자 자동 전환은 하지 않는다. 종료되지 않은 전송은 호출자 시간 초과 뒤에도 실행 슬롯을 유지한다.
- 로그아웃·만료·이용 중지·서버 종료는 세션 조회를 취소하고 캐시를 제거한다. 연결 수정·키 교체·삭제는 저장 계층의 소유권 검사 후 취소 훅으로 연결된다. 마지막 리비전·세션 검사로 늦은 응답을 폐기한다.

정책 설정은 `.env.example`의 `AI_CONNECTION_TIMEOUT_MS`, `AI_MAX_CONNECTION_RUNNING`, `AI_MAX_CONNECTION_RUNNING_PER_USER`, `AI_CONNECTION_COOLDOWN_MS`, `AI_MODEL_CACHE_TTL_MS`에서 관리한다. 카탈로그의 전체 조회 시간 제한과 어댑터의 개별 호출 시간 제한을 함께 적용한다. 기본 전송은 취소 신호를 준수한다. 주입하는 전송도 취소를 준수해야 하며 무시하는 전송은 실제 종료까지 슬롯·서버 종료를 지연시킨다.

## 서버 연결·다음 단계

`AI_ENABLED=true`일 때 작성 서비스에 내부 `aiCatalog`를 준비한다. 초기화·서버 시작·목록 캐시 조회만으로 외부 요청을 보내지 않는다. 연결 확인/모델 조회 HTTP API와 브라우저 연결 관리 화면은 4단계에서 함께 구현한다. 이번 단계에는 모델 선택 UI·실제 AI 생성·저장 확인 상태 갱신 API가 없다. 연결 메타데이터의 `checkStatus`는 아직 `unchecked`이며 카탈로그 상태와 별개다.

등록/교체할 새 키 검증도 4단계에서 조회 한도·세션 취소를 공유하는 경로에 연결한다. 저장 서비스의 키 교체 검증 콜백 안에서 장시간 외부 조회를 실행하면 전체 수정 큐를 지연시키므로 검증은 수정 큐 진입 전에 수행하고 커밋 시 세션·리비전을 다시 검사하도록 구현해야 한다.

## 검증과 한계

어댑터 테스트는 공식 응답 형식에 맞춘 대체 HTTP 응답으로 인증 헤더·페이지 조회·오류 비밀 제외·응답 크기·취소·시간 제한을 확인한다. 카탈로그 테스트는 허용 목록·리비전·세션 격리·키 교체·캐시 무효화·늦은 결과·실제 미완료 슬롯을 확인하며 실제 파일 저장소와 세션도 함께 사용한다. 실제 API 키를 읽거나 호출하지 않았다. 실제 제공자별 연결과 생성 검증은 사용자 연결 등록 후 별도 수행한다.

## 공식 근거

2026-10-11 확인: [OpenAI 모델 목록](https://developers.openai.com/api/reference/resources/models/methods/list), [Claude 모델 목록](https://platform.claude.com/docs/en/api/models/list), [Gemini 모델 목록](https://ai.google.dev/api/models), [Gemini API 키 인증](https://ai.google.dev/gemini-api/docs/api-key). 모델 이름·가격은 이번 구현에 고정하지 않았다.
