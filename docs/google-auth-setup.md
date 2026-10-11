# Google OAuth 로컬 실행

현재 Google 인증 코드 교환과 ID 토큰 검증을 구현했다. 로그인 버튼에서 Google으로 이동한 뒤 검증된 사용자에게 게임 세션을 발급한다. 아직 실제 클라이언트 비밀값을 입력하지 않았으므로 실제 Google 로그인 성공은 확인하지 않았다.

## 로컬 설정

저장소 루트의 `.env`를 편집한다. 파일이 없다면 `.env.example`을 `.env`로 복사한다. `.env`는 Git에서 제외되며 `.env.example`에는 실제 비밀값을 넣지 않는다.

```dotenv
AUTH_MODE=google
GOOGLE_CLIENT_ID=콘솔에서 발급받은 클라이언트 ID
GOOGLE_CLIENT_SECRET=콘솔에서 발급받은 클라이언트 비밀값
GOOGLE_REDIRECT_URI=http://127.0.0.1:3000/api/auth/google/callback
GOOGLE_ALLOWED_DOMAINS=
GOOGLE_ALLOWED_EMAILS=
PORT=3000
```

`npm start`는 `.env`를 읽는다. 기존 셸 환경변수가 있으면 `.env`보다 우선한다. 설정 변경 후 서버를 재시작한다. Node 18 환경에서 npm 실행 문제가 있으면 `node scripts/build-editor.js` 후 `node scripts/start.js`로 실행할 수 있다. `node src/server.js`를 직접 실행하면 `.env`를 읽지 않는다.

Google 콘솔의 웹 클라이언트에 승인된 리디렉션 URI를 **동일한 문자열**로 등록한다. 브라우저는 `http://127.0.0.1:3000/signin`으로 접속한다. 다른 로컬 별칭인 `localhost`로 접속하면 로그인 시작에서 등록된 콜백 호스트로 먼저 이동한 뒤 인증 쿠키를 발급한다. 반대 방향도 지원하며 포트가 다른 주소나 임의의 호스트는 허용하지 않는다. 콜백 경로는 `/api/auth/google/callback`으로 고정한다. 로컬 HTTP는 개발 환경의 localhost·127.0.0.1에서만 허용한다.

회사 Google Workspace 도메인이 정해지면 `GOOGLE_ALLOWED_DOMAINS=company.example`처럼 설정한다. 여러 값은 쉼표로 구분한다. 이 검사는 이메일 끝부분 대신 Google 토큰에서 검증한 `hd`를 사용한다. Gmail 등 개별 예외는 `GOOGLE_ALLOWED_EMAILS`에 명시한다. 이는 로그인 허용 목록이며 관리자 권한 설정이 아니다. 운영 환경에서는 허용 도메인·이메일 중 하나 이상을 반드시 설정해야 한다. 로컬에서 두 목록이 모두 비어 있으면 검증된 모든 Google 계정이 일반 사용자로 가입할 수 있다.

로그인 시작 요청에는 직접 연결된 TCP 접속 IP별 제한을 적용한다. `GOOGLE_AUTH_STARTS_PER_MINUTE`는 1분 구간의 시작 요청 횟수이며 기본값은 60, 허용 범위는 1~10000이다. `GOOGLE_AUTH_FLOWS_PER_ADDRESS`는 해당 IP의 미완료 인증 수이며 기본값은 50, 허용 범위는 1~999이다. 대기 중인 요청과 Google 코드 교환·계정 조회 중인 요청을 함께 센다. 완료·취소·실패 또는 10분 만료 시 인증 슬롯을 회수한다. 거절된 시작 요청은 429와 `Retry-After` 헤더를 반환하며 기존 인증 요청과 로그인 세션은 유지한다. 콜백은 시작 요청 횟수 제한에 포함하지 않아 이미 승인된 인증을 마칠 수 있다.

브라우저 쿠키나 `X-Forwarded-For`·`Forwarded` 헤더로 접속 IP를 대체하지 않는다. IPv4와 같은 주소를 나타내는 IPv4-mapped IPv6는 같은 한도로 처리한다. 사내 NAT·VPN 또는 프록시 뒤에서는 여러 사용자가 동일한 TCP 접속 IP를 공유할 수 있으므로 배포 시험에서 두 한도를 조정한다. 향후 프록시 원본 IP를 사용할 때는 신뢰할 프록시와 헤더 검증을 별도로 구현해야 한다. IP별 제한은 한 접속자가 전체 1000개 인증 슬롯을 차지하는 것을 막는 조치이며 여러 IP의 분산 공격에 대한 방어는 운영 프록시 단계에서 추가한다.

목업으로 돌아가려면 `AUTH_MODE=mock`으로 변경하고 재시작한다. Google 모드에서는 목업 로그인 API가 비활성화된다. `AUTH_MODE=disabled`는 계정 로그인 없이 게스트 플레이만 제공한다. 운영에서 목업은 금지한다.

## 확인 순서

1. 로그인 화면에 `Google 계정으로 계속`이 나타나는지 확인한다.
2. Google 계정 선택·동의를 완료한다.
3. 홈 화면 또는 로그인 전에 선택한 페이지로 이동하는지 확인한다.
4. 작업실에서 코드 저장 후 로그아웃·재로그인하여 같은 계정의 코드를 불러온다.
5. 이용 중지한 계정, 허용 목록 밖 계정, 취소한 인증 요청이 로그인되지 않는지 확인한다.

설정 누락은 서버 시작 시 환경변수 이름으로 안내한다. 토큰 교환·검증 오류의 원문은 클라이언트에 노출하지 않는다. 콜백 오류는 로그인 화면에 일반 안내로 표시하며 인증 코드·토큰을 화면 URL에 남기지 않는다. Google의 `redirect_uri_mismatch` 오류는 콘솔과 로컬 콜백 주소를 비교한다. 회사 계정의 조직 정책에 따른 앱 접근 차단은 Workspace 관리자에게 확인한다.

## 기존 계정과 관리자

Google 계정은 이메일이 같은 목업 계정과 자동 병합하지 않는다. 기존 목업 관리자와 같은 이메일로 로그인해도 새 Google 계정은 일반 사용자다. 기존 계정의 데이터·권한을 유지하려면 별도의 명시적 신원 이관 절차가 필요하며 현재 공개 계정 연결 API는 제공하지 않는다. 초기 관리자 정보는 계속 로컬 계정 메타데이터에 보관하며 저장소에 관리자 이메일을 추가하지 않는다.

Google 모드의 `admin:bootstrap`은 먼저 로그인하여 등록된 Google 계정만 대상으로 한다. 기존 목업 관리자가 있으면 같은 이메일이라는 이유로 성공 처리하지 않는다. 관리자 접근 복구가 필요하면 서버를 중지하고 `npm run admin:grant -- --list --email <이메일>`에서 Google 계정의 ID를 확인한 다음 `npm run admin:grant -- --user-id <계정 ID>`로 해당 계정만 승격한다. 기존 목업 계정과 데이터는 그대로 유지한다. [유지보수 명령 안내](local-authoring.md)를 참고한다.

## 네트워크와 배포 경계

브라우저는 Google 로그인에 접근해야 하며 게임 서버는 Google 토큰 교환·공개 서명키 조회를 위한 외부 HTTPS 접근이 필요하다. 현재는 로컬에서 직접 접속한다. Azure 호스트가 외부에 직접 접근하지 못하는 환경의 인증 중계·프록시는 배포 단계에서 정한다.

현재 게임 서버는 루프백 바인딩과 로컬 Host·Origin 검사만 허용한다. HTTPS 콜백과 Secure 세션 쿠키 설정 검사는 준비했지만 운영 프록시·도메인·Host·Origin 허용 설정은 아직 구현하지 않았다. 이 상태를 그대로 사내 배포 완료로 간주하지 않는다.

## 자동 검증

`node --test test/google-auth.test.js`는 설정 검사, 브라우저 쿠키에 연결된 일회성 state, nonce·PKCE, 만료·재사용 차단, 실제 Google 공식 SDK를 통한 로컬 JWT 서명·issuer·audience·expiry 검증, 회사 도메인 검사와 HTTP 세션 발급을 확인한다.

`npm run test:google-auth`는 브라우저에서 인증 취소·재시도·콜백·작업실 이동을 확인한다. Google 네트워크 응답과 공개키 조회는 테스트 대역으로 교체하며 **실제 Google 로그인 테스트는 아니다**. 비밀값 설정 후 위의 확인 순서를 직접 실행해야 한다.

구현 기준: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Google 공식 Node.js 인증 라이브러리 저장소](https://github.com/googleapis/google-cloud-node-core).
