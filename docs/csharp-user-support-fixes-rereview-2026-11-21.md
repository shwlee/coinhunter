# C# 사용자 지원 수정분 재리뷰

2026-11-21. 대상은 `4c93ec3` 이후 미커밋인 [H1·M1·M2 수정](csharp-user-support-review-fixes-2026-11-21.md)이다. 제품 코드는 수정하지 않고 격리된 빌드/서비스와 컴포넌트 재현으로 확인했다. [집계 증거](benchmarks/csharp-user-support-fixes-rereview-2026-11-21.json).

판정: 기존 3건의 수정은 확인했다. **중간 1건(R1)의 잔여 결함**을 확인했으며 아직 수정하지 않았다. R1은 이번 수정으로 새로 도입된 회귀가 아니라, 수정된 복구 경로에서도 노출되는 기존 문제다.

## R1 — 로그 복구 전 잠정 실패 결과를 최종 운영 정보로 고정함

- 우선순위: 중간 / P2.
- 주 위치: [MatchService.cs:202](../backend/src/CoinHunter.Operations.Api/Services/MatchService.cs#L202), [MatchService.cs:244](../backend/src/CoinHunter.Operations.Api/Services/MatchService.cs#L244).
- 관련: [InternalController.cs:41](../backend/src/CoinHunter.Execution.Host/Controllers/InternalController.cs#L41), [ExecutionManager.cs:266](../backend/src/CoinHunter.Execution.Host/Services/ExecutionManager.cs#L266), [ExecutionManager.cs:305](../backend/src/CoinHunter.Execution.Host/Services/ExecutionManager.cs#L305).

게임 엔진이 비정상 종료하면 Execution은 먼저 `state=failed`, `recording.durableThroughSeq=0`인 결과를 공개한다. 이후 실행기/OS 자원을 정리하고 실제 부분 로그를 복구한 뒤 `Closed`를 완료한다. 이 사이의 마지막 게임 snapshot은 `playing`일 수 있다.

내부 GET은 snapshot의 게임 상태가 `finished`일 때만 `Closed`를 기다리므로 위 실패 결과는 복구 전에도 반환될 수 있다. Operations는 이를 받아 `completed/applied/finalSnapshot/recording/resultHash`를 먼저 저장한다. ACK가 최종 정리를 기다리는 동안 Execution의 로그 정보가 바뀌어도 ACK 후에는 다시 읽지 않는다. 다음 복구도 `completed=true` 항목에는 ACK만 하므로 잠정 정보가 계속 남는다.

컴포넌트 재현에서 실제 `MatchService`와 파일 어댑터를 사용하고, 실행 서비스 응답 순서를 테스트 대역으로 통제했다.

1. 비정상 종료의 마지막 게임 snapshot을 `playing`, 실패 결과의 durable seq를 0으로 반환한다.
2. ACK 처리 중 정리가 끝난 상황을 모델링해 최종 durable seq를 23으로 바꾼 뒤 성공 응답한다.
3. 복구를 한 번 더 호출한다.
4. 최종 실행 응답은 seq 23인데 운영 파일은 seq 0, `completed=true`, `acknowledged=true`였다. GET/ACK는 각각 1회였으며 두 번째 복구에서 최종 결과를 다시 조회하지 않았다.

이 재현은 전달/완결 순서를 통제한 컴포넌트 검증이다. 실제 OS 강제 종료에서 이 특정 타이밍을 직접 포착한 결과로 표시하지 않는다. 다만 그 순서를 허용하는 실행 서비스의 공개/정리 순서는 소스에서 확인했다. 실제 JSONL 파일을 삭제하는 문제는 아니며, 운영에 보관되는 기록 범위와 결과 hash가 확정 결과와 달라질 수 있는 문제다.

수정 방향:

- 실패를 포함해 수집·정리·결과 영구화가 끝난 결과만 최종 결과로 공개/적용한다. 또는 잠정/확정 상태를 계약으로 명시하고 운영 반영을 확정 후로 미룬다.
- ACK 전후의 최종 결과 버전/hash를 대조해 잠정 정보를 완료 처리하지 않도록 한다.
- 실행 서비스의 영구 보관용 상태와 외부 공개용 상태를 구분해, 응답을 숨기는 수정이 최종 결과의 파일 저장까지 누락시키지 않도록 검증한다.

## 기존 수정 확인

- 별도 전체 BE 빌드: 경고/오류 0개.
- 수락/복구 집중 회귀 23건, 브라우저 컴포넌트 10시나리오 통과.
- 실제 두 서비스에서 C# 정상 시작, 베타 비활성화 후 두 사용자 복구/JS 재시작, 정책 불일치 확정 거절 후 다음 JS 생성, 미생성 취소/지연 수락/내용 충돌을 다시 확인했다.
- 실제 내부 HTTP로 수락과 취소를 동시 요청하는 8회를 수행했다. 함수 호출 순서를 교대로 바꿨지만 관측된 경합은 모두 수락 등록 후 취소 경로였다. 모든 취소는 200, 초기 수락 응답은 400, 최종 상태는 실패 종료와 `user-stopped`였고 같은 요청 재전송은 새 실행을 만들지 않았다. 취소를 먼저 확정한 뒤 수락하는 반대 경로도 별도 순차 검사로 확인했다.
- `status.json` 위치에 빈 디렉터리를 두어 취소 기록 저장 실패를 주입했다. 500으로 응답하고 조회는 404여서 취소 성공으로 오인하지 않았다. 장애 제거 후 재시도로 `closed/aborted`, 실행기 미생성을 확인했다. 최종 예약 메모리와 프로세스 수는 0이었다.
- 원래 사용자 데이터/`.env`/정상 개발 서버 설정은 변경하지 않았으며 시험 서비스는 종료했다. 이번 재리뷰는 최종 사용자 인수·장시간 부하·엄격한 500ms 정지·Linux 격리·운영 승인 완료를 의미하지 않는다.
