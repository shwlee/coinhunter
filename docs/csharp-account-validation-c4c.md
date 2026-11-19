# C# C4-C 계정 저장 버전·백그라운드 검사 연결

작성: 2026-11-19. 선행 C4-A/B를 `b107afa`로 커밋한 뒤 진행했다. 이번 단계는 계정 알고리즘의 **언어·원문 파일·저장 버전과 실제 C# 검사 결과를 연결**한다. Node 게임 어댑터와 편집기의 언어 선택은 아직 구현하지 않았고 C# 게임 지원도 활성화하지 않았다.

후속 [C4-D](csharp-node-game-c4d.md)에서 Node 게임 어댑터와 내부 혼합 실행 후보를 추가했다. 이 문서의 Node 연결 미완료 설명은 C4-C 당시 상태이며, 공개 C# 기능과 정식 채택 관문은 계속 남는다.

## 책임과 흐름

```mermaid
sequenceDiagram
    participant Ops as 게임 운영 / 검사 worker
    participant Meta as IAccountStore / 파일 어댑터
    participant Files as 원문·교환 파일
    participant Exec as 게임 실행 관리 / CSharpValidationService
    participant Runner as 격리 컴파일러·실행 호스트
    Ops->>Meta: owner + language + revision + sourceKey + sourceHash 확인
    Ops->>Files: 소유 기록 후 불변 검사 사본 생성·해시 대조
    Ops->>Exec: 내부 Bearer 인증 / language + scope + source reference
    Exec->>Files: 사본 크기·해시 확인, 전용 실행 사본 생성
    Exec->>Runner: OS 제한 컴파일 또는 검증된 DLL 캐시 획득
    Exec->>Runner: 동일 공통 fixture의 실제 MoveNext 36회 검사
    Exec->>Exec: owner/artifact/fixture별 결과 파일 저장
    Exec-->>Ops: 검사 결과 + 산출물 참조 + 실행 허가 false
    Ops->>Meta: 동일 owner/언어/revision/sourceKey/sourceHash일 때만 결과 갱신
    Ops->>Files: 소유한 임시 사본 정리; 원본 유지
```

게임 운영 프로세스에서 Roslyn을 실행하거나 사용자 DLL을 로드하지 않는다. 기존 내부 `/internal/v1/validations` 요청에 `language`를 추가했으며 생략하면 기존 `javascript`다. C#은 실행 서비스의 별도 후보 검사 모듈로 분기한다. 내부 요청에 임의 경로나 DLL을 전달하는 기능은 없다.

## 저장 계약

`AccountService.Save`의 서버 내부 저장 경로는 `javascript`와 `csharp`를 구분한다. 기존 호출은 JavaScript를 유지하고 기존 항목을 갱신할 때 언어를 생략하면 저장된 언어를 유지한다. C#에는 유효한 원문 SHA-256이 필요하다.

원문 내용은 `ISourceStore` 파일로 유지한다. 현재 파일 어댑터의 내부 확장자 `.js`는 기존 저장 경로와의 호환을 위해 유지하며 **실행 언어는 파일 확장자가 아니라 메타데이터로 결정한다.** 코드 크기 제한은 추가하지 않았다.

계정 문서에는 기존 id/ownerId/name/language/revision/sourceKey/sourceHash와 다음 검사 요약만 보관한다.

```json
{
  "state": "passed",
  "version": "csharp-artifact-preflight-v1/<fixture-sha256>/500ms/candidate-only",
  "sourceHash": "<sha256>",
  "executionAllowed": false,
  "artifact": {
    "key": "<source-and-toolchain-key>",
    "sourceHash": "<sha256>",
    "toolchainKey": "<sha256>",
    "profile": "csharp-artifact-preflight-v1",
    "fixtureVersion": "2.0.0",
    "fixtureHash": "<sha256>"
  }
}
```

원문 전체나 DLL 바이너리를 계정 문서에 넣지 않는다. 산출물과 상세 검사 보고서는 실행 서비스의 `ExecutionRoot/csharp/artifacts`와 `ExecutionRoot/csharp/reports`가 소유한다. 기존 `IAccountStore`, `ISourceStore`, `ICSharpPreflightReportStore` 경계를 유지하므로 이후 운영 DB 어댑터와 파일 보관을 분리할 수 있다.

## 결과를 적용하는 조건

- 큐 작업은 owner/id/revision/sourceKey뿐 아니라 language/sourceHash도 고정한다. 읽은 실제 파일 해시가 다르면 실행 서비스로 보내지 않고 미검증으로 남긴다.
- 백그라운드 작업은 본인의 저장 버전에만 최종 결과를 적용한다. 검사 도중 덮어쓴 새 버전에는 이전 결과를 붙이지 않는다.
- 수동 검사에서 같은 내용을 찾는 경우에도 언어를 구분하고 요청 시점의 저장 버전에 CAS를 적용한다. JavaScript와 C# 사이에서 결과를 공유하지 않는다.
- 실행 서비스 응답의 owner, 원문 해시, toolchain/artifact key 조합, 검사 프로필, fixture 버전/내용 해시, 결과·호출 수와 실행 허가 false를 확인한다. 통과 결과에는 실제 보고서와 36회 호출이 필요하다. 불일치는 `unverified`이며 산출물 참조를 적용하지 않는다.
- 정적 규약/컴파일 실패는 `failed`와 제한된 진단을 남긴다. 컴파일은 성공했지만 실행 검사에 실패한 경우 산출물 참조와 진단은 남길 수 있으나 실행 허가는 false다. 취소·환경 장애는 `unverified`다.
- 서버 재시작 시 C# 결과는 재검사가 필요한 `stale`, 중단된 pending은 `unverified`로 바꾼다. 현재 단계에서 운영 서비스가 실행 서비스의 최신 toolchain을 미리 조회하지 않으므로 재시작 후 기존 통과를 그대로 신뢰하지 않는다. 자동 재실행 없이 명시적인 재검사로 갱신한다.
- 코드 저장은 검사 성공과 독립적이다. 규약 실패·시간 초과·취소·환경 장애에도 원본 파일은 보관한다. 파일 해시 불일치가 검사 worker 전체를 중단시키지 않도록 오류 분류를 보완했다.

## 개발용 활성화와 실행 허가

기본값은 C# 후보 검사 비활성이다. 실행 서비스의 신뢰된 로컬 설정에서 다음 두 값을 모두 제공해야 후보 검사가 동작한다.

```text
Backend__CSharpValidation__Enabled=true
Backend__CSharpValidation__HostAssembly=<절대 경로>/CoinHunter.CSharp.Host.dll
```

이는 **내부 검사만 허용하는 개발 설정**이다. 공개 API의 신규 저장은 계속 JavaScript이며 C# 편집/저장 UI는 제공하지 않는다. 기존 C# 항목을 현재 JavaScript 편집 저장 경로로 덮어쓰는 것도 거절한다. 게스트 C# 검사와 C# 저장 알고리즘/경기 기록의 게임 진입은 거절한다. 엔진 계약·registry의 지원 언어는 계속 JavaScript 하나다.

후보 검사값은 준비 30초·768 MiB·CPU rate 10000, DLL 16 MiB·manifest 1 MiB·캐시 256 MiB, 검사 전체 110초다. 별도 내부 HTTP client의 응답 대기 120초를 사용하며 기존 게임·JavaScript 요청의 40초 설정은 유지한다. 전체 검사 슬롯 2개와 계정별 제한을 기존 검사와 공유하고 C# 후보 검사는 추가로 직렬화한다. 이 값은 정식 운영 동시성/자원 정책의 확정값이 아니다.

종료 시 후보 검사를 취소하고 실제 컴파일/실행 호스트 정리를 기다린다. 코드 파일·DLL 캐시·검사 보고서는 비공개 사용자 파생 데이터이며 최종 개인정보 운영 준비의 계정 삭제/보유 정책에 함께 포함해야 한다.

## 검증

별도 임시 계정·파일·실행 루트에서 실제 C# 컴파일러와 36회 호스트 검사를 사용했다. 운영 서비스 호출의 JSON 직렬화·역직렬화와 결과 적용을 시험 transport로 연결하고, 별도 실제 실행 HTTP 서버에서도 새 분기를 확인했다. 최종 신규 검증 **40건 통과**, 빌드 경고·오류는 0개다.

- 정상 BFS의 계정 결과와 실제 보고서/산출물 참조 일치, 원본 파일 보존.
- 정적 try/catch 위반·실제 500ms 무한 루프의 서로 다른 진단.
- 다른 언어로 같은 원문을 저장해도 결과가 섞이지 않음.
- owner/source/toolchain/fixture·호출 수/실행 허가 변조 응답 거절.
- 검사 중 덮어쓰기, 잘못된 언어·해시·owner의 결과 갱신 거절.
- 파일/메타데이터 해시 불일치 이후에도 다음 큐 작업 진행.
- 재시작 stale·명시적 재검사와 동일 artifact 재사용, 종료 취소·임시 사본/호스트/예약 정리.
- 실제 HTTP의 내부 Bearer 인증·owner/source가 묶인 C# 검사 응답·게스트 거절·정상 서비스 종료.

[최종 검증 원본](benchmarks/csharp-c4c-2026-11-19.json). Linux 강제 제한/부모 장애 감독과 실제 운영 배포·혼합 언어 게임 검증을 완료한 것으로 간주하지 않는다.

기존 전체 회귀도 통과했다. C1 62·C2 223·C3 30·부모 42·C4-A 33·C4-B 53, 기존 .NET 계약/업무/OS 59건, BE 통합 13그룹·프로토콜 5건이다. 전체 실행 시점의 C4-C 34건 통과 후 HTTP 검증 6건을 추가하고 최종 C4-C 40건을 별도로 재검증했다.

```powershell
$env:COINHUNTER_BUILD_ROOT='artifacts/c4c-build'
node scripts/backend.js test
# 빌드 후 이번 연결만 확인:
dotnet artifacts/c4c-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-account-validation
```

## 다음 작업

Node의 공통 실행기 registry에 C# 후보 어댑터를 연결하고, 게임 시작 시 확정된 source/artifact snapshot을 사용하도록 한다. 매 턴 컴파일이나 운영 API 경유 없이 유지한 Player 객체를 호출해야 한다. 공개 C# 기능은 native/GC 중단 한계, Linux·OS 권한, 운영 감시/복구·부하·공정성 관문을 통과한 뒤 별도로 활성화한다.

현재 작업은 실제 사용자 데이터나 실행 중 사용자 서버를 수정하지 않았으며 아직 커밋하지 않았다. 선행 `b107afa`는 커밋만 했고 이번 요청에서 푸시는 하지 않았다.
