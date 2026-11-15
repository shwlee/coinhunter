# Frontend

- `public/`: 화면, 브라우저 모듈, CSS와 게임 에셋.
- `src/code-editor.js`: CodeMirror 번들의 원본. 루트 `npm run build:editor`로 `public/generated/code-editor.js`를 생성한다.
- `server/`: 정적 제공·보호 페이지 세션 조회·`/api/*` 중계. 운영 계정/저장소/게임 엔진을 직접 만들지 않는다.

루트 `npm start`가 FE와 BE를 함께 실행하며 기본 브라우저 주소는 `http://127.0.0.1:3000`이다. FE만 실행하는 별도 CLI는 이번 폴더 변경에 추가하지 않았다. BE만 실행할 때는 루트 `npm run backend:start`를 사용한다.

공통 순수 규약은 [shared](../shared/README.md), 전체 배치는 [폴더 구조](../docs/project-layout.md), 연결/인증 설정은 [backend 실행법](../backend/README.md)을 참고한다. 루트 공통 package.json/lockfile·환경 설정·운영 데이터 경로는 유지한다.
