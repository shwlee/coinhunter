# FE/BE 폴더 구조

2026-11-15: 소스의 책임에 따라 FE와 BE를 물리 디렉터리로 구분했다. 실행 명령·HTTP 주소·데이터 저장 위치는 유지한다. 이전 문서의 루트 `public`, `src`, `examples`, `maps` 경로보다 이 문서의 현재 배치를 우선한다.

```text
coinhunter/
  frontend/
    public/                  HTML·CSS·브라우저 JS·이미지/영상/폰트
      generated/             에디터 번들 산출물 (Git 제외)
    src/code-editor.js       CodeMirror 번들 입력
    server/                  정적 웹서버·API 중계·공개 에셋 목록
  backend/
    CoinHunter.sln           C# 솔루션
    src/                     운영 API·실행 관리·Contracts·Infrastructure
    tests/                   C# 계약/업무 검사
    contracts/               C#/Node 실행 규약·빌드 생성 게임/프롬프트 데이터
    node/
      src/game/              게임 규칙·경기 진행
      src/runtime/           JS/QuickJS 알고리즘 실행기·검사
      src/execution/         경기별 엔진 진입점·프레임·JSONL 수집
      src/algorithm-assistant/ 작성 규약 생성
      src/server.js          기존 Node 운영 서버 호환 진입점
      examples/              샘플 알고리즘
      maps/                  배포용 기본 샘플 맵·registry
  shared/                    FE/Node 공용 순수 JavaScript 규약/도구
  scripts/                   루트 실행·빌드·유지보수·통합 검증 도구
  test/                      Node 단위/FE·BE 공통 회귀 검사
  docs/                      설계·계획·검증·운영 문서
  data/                      기존 운영 데이터 (경로 유지, 소스 이동과 별개)
  artifacts/                 임시 검증 결과 (Git 제외)
  package.json               공통 의존성과 실행 명령
  .env                       기존 로컬 환경 설정 (Git 제외, 이동하지 않음)
```

## 책임과 의존성

FE 화면/에셋은 [frontend](../frontend/README.md), C#과 Node 게임 실행 코드는 [backend](../backend/README.md)에 보관한다. C# 프로젝트의 경로를 유지했으므로 솔루션과 각 프로젝트의 무시된 `appsettings.Local.json`도 같은 위치다.

공유 파일은 캐릭터 정의, 전략 템플릿/입력 정리, 맵 편집/배열 파서 5개다. [shared](../shared/README.md)는 HTTP·파일·계정·세션을 소유하지 않는다. Node 엔진이 FE의 public 파일을 직접 import하던 의존성을 이 영역으로 옮겼다.

브라우저가 요청하는 기존 `/characters.js`, `/map-array.js` 등의 URL은 그대로 제공한다. 새 상대 import가 사용하는 `/shared/*`도 명시한 5개만 에셋 목록에 등록한다. 저장소 디렉터리를 임의 정적 경로로 노출하지 않는다. 레거시 Node 서버만 호환 실행을 위해 FE의 에셋 목록을 재사용하며 기본 BE의 게임 엔진은 FE에 의존하지 않는다.

현재는 저장소 루트의 `package.json`/lockfile로 공통 설치·실행을 관리한다. FE 독립 패키지·빌드/배포 제품 구성은 이 파일 이동과 구분한다.

## 실행

저장소 루트에서 기존 명령을 그대로 사용한다.

```sh
npm start                       # FE + C# 운영/실행 관리
npm run backend:start           # C# 운영/실행 관리만
npm run build:editor            # frontend/public/generated로 생성
npm run backend:test
npm run backend:test:browser
npm test
```

게임 엔진은 C# 실행 관리자가 `backend/node/src/execution`에서 자동으로 시작한다. 샘플 다운로드와 기본 맵 생성기는 `backend/node/examples`, `backend/node/maps`를 사용한다.

## 데이터·설정

이 작업에서 실제 `data/`, `.env`, 기존 C# 로컬 설정은 옮기거나 이전하지 않았다. 기본 새 BE 저장 영역은 계속 `data/backend/operations`, `data/backend/exchange`, `data/backend/execution`이다. 레거시의 `data/accounts`, `data/maps` 경로도 유지한다. 원문/맵 저장 데이터와 배포용 샘플 맵은 서로 다르다.

실제 데이터 이전과 백업/복귀는 [기존 절차](backend-cutover-runbook.md)를 따른다. Git에서는 기존 파일 삭제와 새 경로의 파일 추가로 보일 수 있으며, 커밋 시 내용이 동일한 파일은 rename으로 인식된다. 에셋은 파일 이동만 수행했다.

## 확인

- C# 빌드: 경고/오류 0. 계약 31건·업무 13건, Node/C# 프레임 5그룹·업무/유지보수 통합 13그룹 통과.
- 기존 Node 회귀 검사 232개 통과.
- 실제 브라우저에서 로그인→작업실 저장/검사→테스트 iframe→관리자 맵 제작/게시→게임 결과 통과. 1440/768/390 너비 확인.
- 실행 도구·부하 검사도 새 엔진/예제/맵 경로로 갱신했고 기동/정상 종료·4경기/16플레이어 동시 실행·프로세스 장애/복구 검사를 통과했다. 실제 운영 데이터/Google 키는 사용하지 않았다.
