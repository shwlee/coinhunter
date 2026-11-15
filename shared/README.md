# FE/BE 공유 JavaScript

| 파일                    | 역할                                    |
| ----------------------- | --------------------------------------- |
| `characters.js`         | 캐릭터 식별자와 표시용 정의             |
| `strategy-templates.js` | 전략 템플릿·우선순위 규약               |
| `algorithm-strategy.js` | 전략 입력 정리·요청 생성                |
| `map-editing.js`        | 맵 타일·대칭 편집·랜덤 생성용 순수 도구 |
| `map-array.js`          | JSON/int[] 데이터 파싱·내보내기         |

FE 브라우저 도구와 Node 게임/규약 모듈에서 같은 원본을 사용한다. 계정·저장소·네트워크·DOM 기능은 넣지 않는다. C#에는 빌드 시 생성하는 게임 데이터/규약과 별도 검증을 통해 연결한다.

FE 웹서버는 이 파일들만 기존 모듈 URL과 `/shared/<파일명>`으로 제공한다. [전체 폴더 구조](../docs/project-layout.md).
