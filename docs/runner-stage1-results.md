# 실행기 1단계 결과와 JavaScript 성능 기준선

2026-11-15. [10단계 계획](game-engine-language-runners-plan.md)의 1단계 산출물이다. 공통 계약·구조/수명 검증·현 JS 대응과 기준 측정을 구현했다. 게임/검사 경로에 새 어댑터를 연결하거나 다른 언어/컴파일러를 설치하지 않았다.

## 산출물

- [실행 계약 v1](algorithm-runner-contract.md): preparer/runner/factory, 파일/산출물·식별자, 수명/입출력/오류·중단·계측 경계.
- [JSDoc](../backend/node/src/runtime/contracts/types.js), [검증 모듈](../backend/node/src/runtime/contracts/validation.js), [수명 모델](../backend/node/src/runtime/contracts/lifecycle.js), [manifest](../backend/contracts/runner-contract-v1.json).
- [계약 검사](../test/runner-contract.test.js): 요청/산출물 교차 결합·오래된 응답·중복 호출·닫는 중 응답·실제 JS timeout 뒤 상태 재사용.
- [측정 도구](../scripts/measure-runner-baseline.js), [원시 집계 JSON](benchmarks/runner-js-baseline-2026-11-15.json). 이전 [호출 비용 분석](algorithm-invocation-cost-analysis.md)은 별도 이전 실험으로 유지한다.

## 재현 방법과 범위

저장소 루트에서:

```sh
npm run runner:baseline
node scripts/measure-runner-baseline.js
node scripts/measure-runner-baseline.js --quick
node --test test/runner-contract.test.js
```

위 두 정상 측정 명령은 같은 기본 프로필이다. quick은 실행 확인용 축소 표본이며 기준 성능 자료로 사용하지 않는다. 매 실행은 무시된 `artifacts/runner-js-baseline.json`을 갱신하며 보관된 docs의 측정 JSON을 덮어쓰지 않는다.

환경은 Windows 10.0.26200 x64, Node 18.20.2, QuickJS binding 패키지 quickjs-emscripten 0.32.0, Intel i7-10700F/16 logical CPU다. QuickJS native 엔진 버전은 별도로 확인하지 못해 null로 기록했고 package 버전과 같은 값으로 만들지 않았다. 코드/정책·worker의 hash도 JSON에 기록했다.

실제 `.env`, 사용자 원문/계정/맵, Google 키·HTTP 서버·외부 서비스를 사용하지 않는다. 합성 입력과 저장소의 nearest-coin 샘플만 사용한다. 측정 프로세스는 자식에게 OS 실행용 최소 환경만 상속하도록 자체 환경을 정리하고 측정이 끝나면 생성한 sandbox/플레이어 프로세스를 닫는다.

## 측정 설계

| 항목     | 설정                                                                                |
| -------- | ----------------------------------------------------------------------------------- |
| 알고리즘 | 무연산 방향 반환 / 전체 map·items 읽기 및 checksum 보관 / 기존 BFS 샘플             |
| 맵       | 12×10, 20×16, 40×30 합성 입력                                                       |
| 경로     | 직접 QuickJS / IPC 1플레이어 / IPC 4플레이어 동시 호출                              |
| 워밍업   | 각 조합 direct 80호출, IPC는 플레이어별 80호출                                      |
| 표본     | 3라운드×200호출: direct/IPC 1명은 각 600개, IPC 4명은 2,400개                       |
| 집계     | 준비 시간 별도, total/execution/roundTrip/경계 밖 관찰값의 min·mean·p50/p95/p99·max |

9개 조합×3개 경로다. 측정 표본은 총 32,400호출이고 워밍업은 별도다. 라운드마다 경로 순서를 회전하며 호출별 검사·통계 처리는 측정 구간 밖에 둔다. IPC 4명 경로의 Promise.all은 비교용 배치이며 실제 게임의 턴 정책이 아니다. 게임 tick·SSE·전량 로그 저장과 동시 게임을 실행한 부하 자료도 아니다.

`execution`은 기존 elapsedMs이고 순수 알고리즘 함수 시간은 아니다. `total`에는 엔진을 흉내 낸 입력 사본과 caller 경과가 포함되며 직접 경로에도 사본 정책을 적용한다. `roundTrip`은 기존 PlayerProcess 값이고 직접 경로는 null이다. 입력 준비·응답 처리·엔진 반영의 독립 구간은 아직 미측정이라 null이며 이 단계에서 분해됐다고 표시하지 않는다.

## 기준 측정 요약

단위 ms, 2026-11-15T08:54:02Z에 시작한 한 로컬 실행이다. 수치는 반올림했다.

| 알고리즘  | 맵    | 직접 total p50 | IPC 1명 total p50 | IPC 1명 total p95 | IPC 4명 total p95 |
| --------- | ----- | -------------- | ----------------- | ----------------- | ----------------- |
| 무연산    | 12×10 | 0.040          | 0.156             | 0.199             | 0.294             |
| 무연산    | 20×16 | 0.065          | 0.192             | 0.260             | 0.311             |
| 무연산    | 40×30 | 0.191          | 0.328             | 0.378             | 0.433             |
| 입력 읽기 | 12×10 | 0.038          | 0.157             | 0.244             | 0.318             |
| 입력 읽기 | 20×16 | 0.077          | 0.201             | 0.376             | 0.279             |
| 입력 읽기 | 40×30 | 0.248          | 0.395             | 0.460             | 0.478             |
| BFS 샘플  | 12×10 | 0.045          | 0.186             | 0.294             | 0.309             |
| BFS 샘플  | 20×16 | 0.071          | 0.222             | 0.348             | 0.322             |
| BFS 샘플  | 40×30 | 0.203          | 0.405             | 0.482             | 0.511             |

결과는 동일 JS 구현의 경로별 기준선이다. 모든 입력/언어에 이 지연을 보장하거나 실제 게임의 시간/점수 차이로 직접 환산하지 않는다. 한 경로의 percentile에서 다른 경로의 percentile을 빼 정밀한 IPC 비용으로 간주하지 않는다. 전체 집계·환경·준비 시간과 p99/max는 원시 JSON에서 확인한다.

## 검증과 다음 단계

- 새 계약/수명/manifest·실제 JS 호환 검사 12건, 기존 runtime/preflight 회귀 21건 통과(합계 33건).
- 구조와 상태 검증의 오류/지연 응답·비중첩·닫는 중 완료·미해제 실패를 검사했으며 실제 QuickJS 무한 루프 중단과 필드 보존을 함께 확인했다.
- 기준 측정 9개 입력 조합×3개 경로를 완료했고 측정/워밍업 동안 같은 sandbox/플레이어를 유지했다. 타 언어/전체 게임 성능의 검증으로 확대 해석하지 않는다.

계약은 정상 -1과 오류 상태를 구분하고 timeout 시 실제 중단을 보고하도록 정의한다. 수명 모델은 비중첩·단조 callId·run/instance 결합, 잘못된 응답 뒤 pending 유지, close/실패 시 자원 해제 확인을 검사한다. 실제 기존 PlayerProcess에서 정상→500ms 무한 루프 중단→다음 정상 호출의 PID/필드 보존도 확인한다.

구조/상태 검사만으로 실제 중단·자원 정리·격리·지원 언어를 증명하지 않는다. 기존 GameState/Match/PlayerProcess/QuickJS의 게임 실행 코드는 변경하지 않았다. 공통 계약을 사용하는 JS 정식 어댑터·registry와 실제 run/instance/version 발급은 **2단계**다. 언어별 호스팅 채택은 4단계, 세부 계측/최적화는 7~8단계다.
