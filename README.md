# Coin Hunter

사용자 알고리즘으로 코인을 수집하는 웹 게임. 현재는 **JavaScript 파일 업로드 → 개인/더미 경기 → 결과**를 실행하는 첫 개발 버전입니다.

## 시작

```sh
npm ci
npm start
```

브라우저에서 <http://127.0.0.1:3000>을 엽니다. 화면의 **샘플 알고리즘 내려받기**로 받은 `nearest-coin.js`를 업로드하거나 `examples/nearest-coin.js`를 직접 선택하고 경기를 시작합니다. 더미는 0~3명 선택할 수 있습니다.

- 다른 포트는 `PORT` 환경 변수로 지정합니다.
- 서버는 로컬 검증용으로 `127.0.0.1`에만 바인딩됩니다. 사내/Azure 배포는 아직 구성하지 않았습니다.
- 로컬 검증 환경: Windows, Node.js 18.20.2, npm 10.9.0. CI 구성은 Node.js 22 기준이며 원격 CI 실행 여부는 별도 확인이 필요합니다.

## 구현된 기능

- 플레이어별 프로세스·QuickJS 인스턴스를 경기 동안 유지
- 턴마다 500ms 실행 제한, 시간 초과 후 같은 인스턴스로 계속 진행
- 독립 턴, 현재 턴만 적용되는 제자리 패널티
- 고정 대칭 맵, 최대 4인, 코인·점수·HurryUp
- 신발·망치·x2·랜덤점프 기본 규칙과 개발용 연출
- BlackMatter·벽 파괴 개별 옵션
- 파일 업로드, `debug.print`, 실시간 경기 화면, 새로고침 후 재연결
- 게스트 세션별 경기 접근 구분

## 검증

```sh
npm test
npm run verify:runtime
npm run demo
npm run test:browser
```

브라우저 검증은 설치된 Edge/Chrome/Chromium을 사용합니다. 자동으로 찾지 못하면 `COINHUNTER_BROWSER`에 실행 파일 경로를 지정합니다. 별도 브라우저 다운로드는 하지 않습니다. 스크린샷은 Git에서 제외한 `artifacts/`에 생성됩니다.

`verify:runtime`은 같은 PID에서 정상 → 무한 루프 → 정상 호출의 상태·시간·반환값을 출력합니다. `demo`는 화면 없이 4인 경기를 실행합니다.

## 아직 구현하지 않은 기능

계정 로그인·영구 저장, 코드 에디터, AI 연결, 관리자 화면·맵 편집, 선택적 공유 더미, 대회, 실제 사내 배포는 후속 단계입니다. 현재 코드와 경기 기록은 영구 저장되지 않습니다. 게스트 경기 결과는 종료 후 5분 동안 서버 메모리에 유지됩니다.

## 문서

- [전체 작업 계획](docs/implementation-plan.md)
- [아키텍처](docs/architecture.md)
- [작업 체크리스트](docs/work-checklist.md)
- [게임 규칙 및 첫 구현 결정](docs/game-rules.md)
- [알고리즘 API](docs/algorithm-api.md)
- [데이터와 통신](docs/data-and-api.md)
- [실행 환경 검증 결과](docs/runtime-verification.md)
