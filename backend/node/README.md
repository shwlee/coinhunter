# Node 게임 엔진과 호환 코드

- `src/game`: 게임 상태·맵 규칙·독립 턴 진행.
- `src/runtime`: 플레이어별 QuickJS 실행과 코드 검사. 턴별 500ms 중단 후 같은 인스턴스를 유지한다.
- `src/execution`: C# 실행 관리자가 생성하는 경기별 프로세스, 프레임 채널·전량 JSONL collector/storage.
- `examples`: 다운로드/테스트용 알고리즘. `nearest-coin.js`, `hammer-test.js`, `player-skeleton.js`.
- `maps`: 배포용 기본 맵과 registry. 관리자가 저장한 실제 맵의 데이터 디렉터리와 구분한다.

기본 게임은 루트 `npm start` 또는 `npm run backend:start`로 실행한 C# 관리 서비스가 필요에 따라 시작한다. 게임마다 Node 엔진을 사용자가 직접 띄울 필요는 없다.

`src/server.js`, `auth`, `persistence` 등 구 Node 운영 코드는 호환 실행/회귀 검사에 남겨두었다. `npm run start:legacy`로 명시적으로 사용하며 C# 운영 서버와 같은 파일에 동시에 쓰지 않는다. 제거한 직접 AI 연결은 다시 활성화하지 않았다.

[전체 BE 실행법](../README.md) · [폴더 구조](../../docs/project-layout.md)
