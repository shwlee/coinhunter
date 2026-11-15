# 분리 BE 전환·백업·복귀 절차

2026-11-15. 로컬 구현용 실행 절차다. 실제 사용자 데이터의 이전/서버 종료/설정 전환은 이번 개발 검증에서 수행하지 않았다. [실행법](../backend/README.md), [구현 결과](backend-split-completion.md).

## 기본 실행과 소유권

새 기본 `npm start`는 정적 웹 중계와 C# 운영/실행 관리 서비스를 실행한다. 기존 `data/accounts`, `data/maps`를 자동으로 열지 않고 `data/backend/operations`, `exchange`, `execution`을 사용한다. 따라서 이전하지 않은 기존 계정·맵이 새 저장소에서 보이지 않는 것은 초기 상태다. 임의 이메일 병합으로 관리자 권한을 복원하지 않는다.

원격 호스팅/TLS/VPN/컨테이너·운영 DB 전환은 별도 작업이다. 여기서 제공하는 웹 launcher는 loopback HTTP 개발용이다. 공개 URL과 Google callback origin은 같아야 하며 localhost/127.0.0.1을 섞지 않는다.

## 이전 전 준비

1. 기존 버전/새 버전의 코드와 로컬 설정 위치, 계정 저장 파일·원문·맵 디렉터리의 실제 경로를 확인한다. 비밀 값을 문서/저장소로 복사하지 않는다.
2. 기존 서버와 유지보수 명령의 쓰기를 중지하고 실행 중 게임을 끝낸다. 이전 도구는 실행 중 Node writer를 강제로 잠그거나 종료하지 않는다.
3. **하나의 시점**으로 계정 metadata, 원문/역사 코드 사본, 모든 관리자 맵 revision/registry를 함께 백업한다. 독립 파일을 서로 다른 시점에 복사하지 않는다.
4. 원본 대신 오프라인 export 사본을 만든다. 기본 구조는 다음과 같다. 사용자 지정 원문 경로를 사용했다면 해당 파일을 `accounts/sources`에 모은다. `.env`, 키, 개발용 AI 자격 증명은 export에 넣지 않는다.

```text
offline-export/
  accounts/store.json
  accounts/sources/<기존 sourceKey>.js
  maps/registry.json
  maps/<기존 mapId>/<revision>.json
```

5. 목적지는 기존 운영 파일이 없는 별도 빈 경로로 정한다. 새 운영 API도 중지한다. 기존 목적지에 새 쓰기가 있다면 이를 먼저 보존하고 새 경로를 선택한다. 덮어쓰기 이전은 제공하지 않는다.

## 검사와 이전

새 목적지를 무시된 로컬 환경변수 `Backend__DataRoot`로 지정한 뒤:

```sh
npm run backend:maintenance -- migrate <offline-export-directory>
npm run backend:maintenance -- migrate <offline-export-directory> --apply
npm run backend:maintenance -- inspect
```

첫 명령은 dry-run이다. 실제 원문/맵을 읽어 참조·ID/소유권·Google 신원 중복·맵 구조를 검사하지만 목적지 파일을 만들지 않는다. `--apply`에서만 목적지 writer lease와 migration marker를 사용해 복사하고 metadata를 마지막에 확정한다. 사용자/알고리즘/맵/신원 ID, 기존 파일 sourceKey, 관리자 역할을 보존한다. 과거 inline source가 있다면 파일로 분리한다. 실행 중 경기/메모리 세션은 가져오지 않는다.

중간 실패 시 `.migration.in-progress`가 남아 새 운영 API의 시작을 막는다. marker만 지워 성공으로 간주하지 않는다. 목적지 사본을 보존해 원인을 확인하고 **빈 새 목적지**에서 같은 오프라인 export로 다시 수행한다. 원본은 변경하지 않는다.

검사 후 새 BE를 실행한다. 같은 공개 주소에 중계를 연결하고 로그인→원문 조회/저장→코드 검사→게임/이전 경기→관리자 맵/게시/숨김을 확인한다. 구 Node 서버는 쓰기 경로로 다시 켜지 않는다. 계정 세션은 새 운영 API에서 다시 발급하므로 재로그인이 필요하다.

관리자 등록이 필요하면 API를 종료한 뒤 `admin:bootstrap -- <email> --provider google`을 사용한다. Google 신원이 이미 등록된 계정만 승격하며 이메일 자동 연결을 하지 않는다. 이미 다른 활성 관리자가 있으면 `admin:grant -- <UUID>`로 대상을 지정한다.

## 분리 BE 백업·복원

전체 종료는 웹→운영→실행 관리 순서다. 실행 관리가 게임 엔진/플레이어를 정리하고 전량 로그/결과를 닫을 시간을 준다. launcher는 자신의 자식만 종료하며 다른 사용자의 3000번 서버를 강제로 내리지 않는다.

정지 후 다음을 같은 백업 세트로 보관한다.

- `operations`: store.json, 원문/역사 사본, 맵 registry/모든 revision.
- `exchange`: 미반영/진행 요청이 참조하는 불변 파일. 단순 경로 이동 중 참조를 유실하지 않도록 첫 구현에서는 영역 전체를 보관한다.
- `execution`: 요청/status outbox, 게임별 source 사본, JSONL/partial/완결 결과 receipt.

복원은 두 BE를 중지한 상태에서 같은 세트로 수행하고 `inspect`로 원문 참조를 확인한다. 잠금 파일의 존재 자체는 활성 writer를 의미하지 않는다. OS exclusive lease를 사용하므로 별도 강제 삭제가 필요하지 않다. 운영만 복원하고 실행 outbox/원문을 새 시점으로 남기는 식의 혼합 복원을 하지 않는다.

운영 API만 중지/재시작하면 게임 엔진은 계속 진행하고 결과를 재반영한다. 실행 관리/엔진 장애에서 자동 게임 재개는 제공하지 않는다. 완결 receipt를 회수하거나 실패와 유효한 partial prefix를 기록한다. `complete`와 `partial`을 구분하고 메모리 큐까지 전원 장애 무손실이라고 안내하지 않는다.

## 복귀

**새 저장소에서 쓰기 전:** 새 서비스를 중지하고 이전 버전/이전 설정/이전 백업으로 함께 복귀한다. 구 버전은 `npm run start:legacy`와 구 저장 경로를 명시한다.

**새 쓰기 후:** 새 데이터/원문/맵/실행 저널을 먼저 함께 백업한다. 이 구현은 새 결과를 구 버전으로 역이전하는 도구를 제공하지 않는다. 새 백업으로 새 BE를 복구하거나, 운영자가 데이터 보존/병합 계획을 정한 뒤 구 버전을 선택한다. 설정만 되돌려 새 데이터가 사라진 것처럼 보이게 하지 않는다.

## 정리와 배포 전 남은 항목

`reconcile`은 오프라인 원문 참조 누락/미참조 파일을 확인하고 `--apply`일 때만 미참조 `.js`를 제거한다. 진행 중 source lease와 경쟁하지 않게 운영 API를 반드시 중지한다. exchange/게임 사본/저널·세션·사용자 전체 삭제/보유 기간/백업 만료는 [마지막 개인정보 운영 준비](privacy-operations-plan.md)에서 연계한다. 현재 자동 전체 삭제/TTL이 구현됐다고 표시하지 않는다.

실제 Google 왕복, 다른 사내 PC, 공개 주소/TLS/신뢰 프록시, DB/영구 볼륨, 운영 동시 실행 한도, 백업 저장 위치와 복원 훈련은 배포 환경에서 확인해야 한다.
