# Coin Hunter 분리 백엔드

현재 폴더 배치: `src/`는 C# 서비스, `node/`는 Node 게임/실행기·샘플 알고리즘·기본 맵이다. 화면/에셋·정적 웹 중계는 루트 `frontend/`로, 공용 순수 JavaScript는 `shared/`로 이동했다. [전체 폴더 구조](../docs/project-layout.md). 기존 데이터/로컬 설정 경로는 유지한다.

BE 분리 1~9단계를 로컬 파일 어댑터와 기존 화면 기준으로 구현했다. **리뷰 대기 중이며 커밋·실제 데이터 전환·외부 배포는 수행하지 않았다.** [단계별 결과·제한](../docs/backend-split-completion.md), [전환·복귀 절차](../docs/backend-cutover-runbook.md).

```text
브라우저 → Node 정적 웹/중계 :3000 → C# 운영 API :3101
                                     ↓ 내부 Bearer 인증
                                  C# 실행 관리 :3102
                                     ↓ 경기별 프레임 채널
                                  Node 게임 엔진
                                     ├─ 플레이어별 기존 JS/QuickJS 실행기
                                     └─ 독립 수집 인터페이스 → JSONL/완결 receipt
```

Node 웹 계층은 계정·운영 저장소·게임 인스턴스를 만들지 않는다. 운영 API가 계정/인가와 운영 파일을 소유하고, 실행 관리 서비스가 경기별 엔진과 실행 기록을 소유한다. 알고리즘 호출은 엔진 안에서 완결하며 운영 HTTP를 매 턴 호출하지 않는다.

## 실행

Windows 로컬 검증: .NET SDK **10.0.401**, Node **18.20.2**. 외부 NuGet 패키지는 없다. 설치된 SDK/shared framework로 빌드한다. 배포 런타임/컨테이너는 후속 검증 대상이다.

```sh
npm ci
npm start
```

`npm start`는 에디터를 빌드하고 루트의 무시된 `.env`를 읽은 뒤 C# 두 서비스와 정적 웹 중계를 실행한다. 기본 주소는 `http://127.0.0.1:3000`. Google 모드에서는 명시한 공개 주소가 없으면 `GOOGLE_REDIRECT_URI`의 origin을 사용한다. 내부 키가 없으면 임시 키를 생성해 두 C# 서비스에만 주입하며 출력·저장하지 않는다. 웹 중계·엔진·플레이어에는 전달하지 않는다.

```sh
node scripts/backend.js build
node scripts/backend.js test
node scripts/backend.js start
node scripts/backend.js web
```

직접 실행한 `backend.js`는 루트 `.env`를 읽지 않는다. `start`는 BE 두 개만, `web`은 기존 화면까지 실행한다. 환경변수를 직접 주입하거나, 로컬 `.env`가 필요한 전체 실행은 `npm start`를 사용한다. Ctrl+C 또는 부모 stdin의 `shutdown`/EOF로 자체 생성한 서비스만 정상 종료한다. 실행 도구는 운영 서비스의 ready를 확인한 뒤 웹 포트를 연다.

기존 서버는 `npm run start:legacy`로 명시적으로 실행할 수 있다. **구·신 서버를 같은 데이터의 작성자로 실행하지 않는다.** 새 기본 저장 경로는 기존 `data/accounts`, `data/maps`와 다르다. 자동으로 이전하거나 기존 계정을 이메일로 합치지 않는다.

## 프로젝트와 저장 경계

| 프로젝트                    | 역할                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| `CoinHunter.Operations.Api` | Controller → 계정/세션/Google·맵·알고리즘·경기 업무 서비스 → 저장/실행 계약 |
| `CoinHunter.Execution.Host` | 수락 한도·엔진 프로세스·준비/시작/종료·결과 outbox·JSONL 조회/복구          |
| `CoinHunter.Contracts`      | 공개 API 목록, 내부 요청/결과, 버전 있는 프레임 DTO                         |
| `CoinHunter.Infrastructure` | 저장 인터페이스/파일 구현, 맵 검사, 설정/인증/상태 확인                     |
| `CoinHunter.Backend.Checks` | 외부 테스트 패키지 없는 C# 계약/저장/인증/복구 검사                         |

`CoinHunter.sln`을 Visual Studio에서 열어 각 서비스의 `Program.cs`와 `Controllers`, `Services`부터 확인할 수 있다. 각 서비스는 별도 진입점이다. `StorageSettings`, `IAccountStore`, `ISourceStore`, `IMapStore` 뒤에서 현재 파일 구현을 선택한다. DB 제품은 이번에 선택·설치하지 않았다.

| 기본 경로                                       | 보관 내용·작성자                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `data/backend/operations/accounts/store.json`   | 계정/신원·알고리즘 메타데이터·경기 요약/반영 상태; 운영 API만 작성 |
| `data/backend/operations/accounts/sources/*.js` | 알고리즘 원문·본인 이전 경기 사본; 불변 파일                       |
| `data/backend/operations/maps/`                 | 사용자 맵 버전·registry·게시/표시 순서                             |
| `data/backend/exchange/*.js`                    | 운영 → 실행 영역의 불변 코드 참조; sourceKey/길이/SHA-256 검증     |
| `data/backend/execution/games/`                 | 실행 요청·게임별 코드 사본·최종 결과/확인 상태                     |
| `data/backend/execution/journals/`              | 원본 JSONL·partial·완결 결과 receipt                               |

모두 Git에서 제외했다. 기본 샘플 맵과 프롬프트 규약은 빌드 시 기존 JS/문서에서 `contracts/generated/game-content.json`으로 생성한다. 수작업으로 수정하지 않는다. JSON/int[] 전송·대칭 랜덤 생성의 기존 브라우저 기능을 그대로 사용한다.

## 설정

| 환경변수                                                          | 용도/기본값                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `COINHUNTER_OPERATIONS_URL`                                       | 실행 도구의 운영 주소, `http://127.0.0.1:3101`                                  |
| `COINHUNTER_EXECUTION_URL`                                        | 실행 도구의 실행 관리 주소, `http://127.0.0.1:3102`                             |
| `COINHUNTER_PUBLIC_URL`                                           | 공개 origin. 기본 3000번, Google 모드에서는 callback origin                     |
| `PORT`                                                            | Google/공개 주소를 별도 지정하지 않았을 때 웹 포트                              |
| `COINHUNTER_INTERNAL_KEY`                                         | 32~256자 base64url. 두 BE에서 동일; 없으면 실행 도구가 임시 생성                |
| `Backend__RepositoryRoot`                                         | 저장소 절대 경로. 실행 도구가 설정                                              |
| `Backend__DataRoot` / `ExchangeRoot` / `ExecutionRoot`            | 위 세 저장 영역의 절대 경로 변경                                                |
| `Backend__NodeExecutable`                                         | Node 실행 파일, 기본 `node`                                                     |
| `Backend__TrustedProxies__0`                                      | 명시한 신뢰 proxy IP. 웹 실행 도구는 운영 API에만 `127.0.0.1` 설정              |
| `AUTH_MODE`                                                       | 로컬 Development의 기본 `mock`; `google`, `disabled` 지원. 운영 환경 mock 금지  |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google 모드. callback은 공개 origin의 `/api/auth/google/callback`과 일치해야 함 |
| `GOOGLE_ALLOWED_DOMAINS`, `GOOGLE_ALLOWED_EMAILS`                 | 검증한 Google hd/이메일 허용 목록. HTTPS 운영에서는 설정 필수                   |

개별 IDE 실행은 `Backend:ListenUrl`, `PublicUrl`, `ExecutionUrl`과 같은 내부 키를 각 프로젝트의 무시된 `appsettings.Local.json` 또는 환경변수로 지정한다. 로컬 JSON은 publish에서 제외한다. launch profile은 Development만 선택하며 키를 담지 않는다. 이 로컬 구현의 내부 수신/연결은 loopback HTTP이며 원격 배치/TLS/키 교체는 실제 배포에서 별도로 검증한다.

인증 키/Google 토큰/코드 본문/OAuth query를 일반 요청 로그에 남기지 않는다. 세션은 운영 API의 메모리에서 12시간 보관하며 운영 API를 재시작하면 재로그인이 필요하다. Google state·브라우저 쿠키·PKCE·nonce·RSA 서명·issuer/audience/시간을 검증하고 email로 기존 계정에 자동 연결하지 않는다.

## 점검과 유지보수

- 두 서비스의 `/health/live`, `/health/ready`. ready는 `scope: business`, 실행 관리의 버전/업무 capability/내부 인증 연결을 확인하며 끊기면 운영 live 200, ready 503이다.
- Development의 운영 `GET /api/system/contracts`: 기존 공개 경로 목록. 실제 업무 경로를 501 placeholder로 처리하지 않는다.
- 동시 경기 4개, 경기당 1~4명, 동시 검사 2개/같은 소유자 1개, 동시 업로드 4개. SSE는 소유자 4개/전체 32개와 쓰기 기한으로 제한한다.
- 원문 파일 업로드의 제품 크기 상한은 두지 않는다. JSON 요청 64KiB/legacy source JSON 2MiB, 파일 스트리밍·디스크 여유 보호는 유지한다.
- 정상 턴 timeout은 500ms 실제 중단 후 같은 객체/프로세스로 계속한다. 엔진 준비/전체 종료 실패의 프로세스 정리와 구분한다.

운영 API를 종료한 뒤:

```sh
npm run admin:bootstrap -- <관리자 이메일> --provider google
npm run admin:grant -- <사용자 UUID>
npm run backend:maintenance -- inspect
npm run backend:maintenance -- reconcile
npm run backend:maintenance -- reconcile --apply
```

Google 관리자는 먼저 Google 로그인해 sub 신원을 등록한 계정이어야 한다. 빈 개발 저장소는 `--provider mock`으로 테스트 관리자를 만들 수 있다. 개인 이메일을 저장소에 넣지 않는다. `admin:*:legacy`는 구 Node 저장소용이다.

`reconcile`은 원문 참조 누락과 미참조 `.js`를 확인한다. `--apply`일 때만 미참조 원문을 삭제한다. 정상 저장에서 이전 원문을 즉시 삭제하지 않아 활성 읽기/사본과 경쟁하지 않으며 오프라인 정리로 회수한다. 실행 저널·완료 경기·exchange의 보유/계정 삭제 정책은 마지막 개인정보 운영 준비에서 확정하며 자동 만료를 약속하지 않는다.

검증 명령:

```sh
npm run backend:test
npm run backend:test:browser
npm run backend:test:load
node scripts/backend-launcher-smoke.js
node --test --test-concurrency=1 test
```

브라우저/부하 검사는 먼저 `backend:build`와 에디터 빌드가 필요하다. 테스트는 합성 계정·임시 디렉터리·임시 포트만 사용한다. 실제 Google 인증·사내 배포·DB 전환·컨테이너·개인정보 운영 준비는 [남은 작업](../docs/remaining-work.md)으로 구분한다.
