# C# C4-A 격리 준비·불변 산출물·lease

작성: 2026-11-19. 리뷰 수정을 `3b01b5d`로 커밋하고 origin/main에 푸시한 뒤 C4 첫 구현 단위를 진행했다. **준비/컴파일·캐시와 준비된 DLL 실행 기반을 구현했으며, 전체 C4와 정식 C# 지원을 완료한 것은 아니다.** 실행 검사 fixture·계정 검사/저장 상태·Node 어댑터·공개 API 연결은 후속이다.

## 준비와 실행 분리

```text
신뢰된 서버 호출자
  → CSharpPreparationStore
      → 원문 내용 해시 확인 / UTF-8 사본 / 소유 기록
      → R0 자원 그룹 → 별도 dotnet --prepare
          → 규약 분석 → guard 변환 → DLL emit / manifest
          → 사용자 assembly 로드·객체 생성·초기화는 수행하지 않음
      → 실제 준비 프로세스 종료·그룹 drain 확인
      → 소유자별 불변 object 디렉터리로 원자적 게시

CSharpHostManager.CreatePreparedAsync
  → 소유자/key·메타데이터·DLL 해시 검증 → artifact lease
  → R0 실행 그룹 → dotnet --artifact
      → DLL 검증·로드 → Player 생성·초기화 → 반복 호출
  → 실제 그룹 정리 확인 → lease 반환
```

같은 실행 파일을 준비/실행 모드로 사용하되 **별도 프로세스**로 구동한다. 부모는 사용자 소스 전체를 메모리에 올리거나 Roslyn을 로드하지 않는다. 원문을 스트리밍으로 canonical UTF-8 사본에 기록하고 내용 해시를 검증한다. 원본 파일과 기존 파일 저장 구조는 유지한다. 새 소스 코드 크기 제한을 추가하지 않았다.

실행 모드는 원문을 읽거나 파싱/변환/emit하지 않는다. 참조/호스트 파일 fingerprint 검증과 DLL 로드·JIT는 준비된 실행 프로세스의 초기 비용으로 남으며, 매 턴 컴파일하는 구조가 아니다. 기존 개발자용 raw source 실행 경로는 회귀/후보 실험용으로 유지한다.

## 키와 무효화

`CandidateCompiler.Describe`는 정책·프로필·분석기·guard·Roslyn·런타임·OS/architecture와 다음 파일의 SHA-256을 포함한다.

- 고정 승인 참조 CoreLib/Runtime/Collections.
- guard/분석기 assembly, 공통 Contracts assembly와 Roslyn assemblies.
- 실제 호스트 진입 assembly·deps/runtimeconfig.

딕셔너리 정렬을 ordinal로 고정하고 이 기술 묶음의 fingerprint를 만든다. build key는 원문 내용 해시와 fingerprint의 조합이다. 원문·도구·참조·실행 환경이 달라지면 다른 key가 된다. 동일 key의 assembly 이름과 emit은 결정적으로 생성하며 재빌드한 DLL의 내용 해시가 같은 것을 확인했다.

프로세스 수명 중 배포 파일이 바뀌면 새 컴파일 응답의 toolchain을 대조해 혼합 버전 게시를 거절한다. 배포 파일을 실행 중 덮어쓰는 hot reload를 지원하는 것으로 해석하지 않는다. artifact 검사는 컴파일 성공을 증명하는 캐시 검사이며 모든 게임 입력에서의 실행 성공/실행 허가가 아니다.

## 보관과 소유권

현재 실제 제품 설정에는 cache root를 추가하지 않았다. 시험에서는 `artifacts/c4-{GUID}/cache`를 사용한다. 추후 실행 영역의 전용 private root로 설정한다.

```text
cache-root/
  .writer.lock
  work/{job-guid}/
    ownership.json         # source 사본을 쓰기 전에 owner/hash/key를 내구 기록
    source.cs              # 임시 canonical 사본
    output/artifact.dll
    output/manifest.json
  objects/{owner-guid}/{build-key}/
    artifact.dll
    manifest.json
```

manifest는 schema, Owner, Key, SourceHash, DllHash/길이, toolchain, 원본 guard 위치 목록을 보관한다. 코드 원문을 계정 DB 필드로 옮기지 않는다. DLL도 사용자 알고리즘의 파생 데이터이므로 원문과 같은 비공개/삭제 정책 대상이다.

캐시는 소유자별 디렉터리로 분리하며 Acquire는 owner/key/manifest를 함께 확인한다. 다른 소유자가 준비하지 않은 key를 획득하지 못한다. 단, 원문 경로에 대한 계정 권한 검사는 **신뢰된 운영 서비스 호출자의 책임**이다. 현재 라이브러리의 owner 인자만으로 HTTP 사용자 인증/인가를 구현한 것은 아니다.

루트에는 단일 writer lease를 둔다. 임시 output은 프로세스 정리와 검증을 마친 후 디렉터리 이동으로 게시한다. partial DLL만 존재하는 상태를 ready로 읽지 않는다. Acquire/재사용 때 메타데이터/버전과 DLL 크기·해시를 확인하고 손상은 거절한다. 손상된 엔트리를 묵시적으로 실행하지 않으며 lease가 없을 때 명시적으로 Evict 후 다시 준비할 수 있다.

실행 중 artifact lease는 파일을 열어 두고 store의 참조 수를 유지한다. Evict는 active lease가 있으면 false다. 준비된 호스트의 생성/초기화 실패도 실제 정리 뒤에만 lease를 반환한다. 정리 확인 실패 시 세션·자원 예약·lease를 유지한다. store도 live lease나 미확인 준비 프로세스가 있으면 종료를 성공으로 표시하지 않는다.

파일 해시는 손상/버전 검사이며 업로드 DLL의 인증 서명이 아니다. 서버 전용 파일 권한이 전제이고 임의 DLL/manifest 업로드·게시 API를 제공하지 않는다. native 실행의 OS 파일/네트워크 권한 격리는 별도 관문이다.

## 한도와 실패 처리

`CSharpPreparationLimits`는 호출자가 준비 ResourceProfile, 전체 시간, DLL/manifest 출력 크기와 published cache 총량을 지정한다. worker는 gate 허가 뒤에만 실행한다. parent는 64 Ki 문자 이내 응답만 읽고 stderr는 고정 버퍼로 버린다. 정책 진단은 최대 20개·메시지 최대 256자로 제한한다. compiler에는 사용자 참조/옵션·패키지·source generator를 받는 기능이 없다.

시험값은 준비 30초·768 MiB·CPU rate 10000, DLL 16 MiB·manifest 1 MiB·published cache 64 MiB다. 이는 소스 파일 크기 제한과 다른 준비 자원 한도이며 운영 정책 확정값이 아니다. snapshot 단계도 전체 시간/취소를 적용한다.

현재 writer는 준비/획득/evict를 직렬화하며 준비 대기는 active 포함 최대 8개다. 진행 중 게임은 이미 로드한 객체를 호출하므로 준비 gate를 매 턴 기다리지 않는다. 준비 중 새 게임의 artifact 획득이 지연될 수 있으며 병렬 최적화는 후속 측정 대상이다.

| 결과/실패                 | 의미                                                         |
| ------------------------- | ------------------------------------------------------------ |
| prepared / CacheHit       | 불변 DLL 준비 또는 검증된 캐시 재사용. 실행 검사 통과와 구분 |
| failed + 진단             | 정적 규약/컴파일 의미 검사 실패. 원문 유지                   |
| source-changed            | 요청 해시와 실제 원문 내용 불일치                            |
| output-limit / cache-full | 준비 산출물 또는 published cache 한도 초과                   |
| 취소·인프라 오류          | 실제 준비 그룹 정리 뒤 실패. 통과 결과를 생성하지 않음       |

정상 실패/취소 시 소유 작업 디렉터리만 정리한다. 정리 확인 실패는 작업과 owner 기록을 보존하고 새 컴파일을 막는다. C4-A 시점에는 crash 뒤 회수가 미구현이었다. 후속 [C4-B 복구](csharp-recovery-preflight-c4b.md)에서 owner/PID 시작 시각·독점 lock을 확인하는 회수를 추가했다. 소유 기록이 없는 이전 작업은 임의 삭제하지 않는다. 원문 사본의 owner 기록으로 최종 개인정보 운영 준비의 소유자별 정리 경로를 구성한다.

출력/공개 캐시 총량과 별개로 canonical 원문 사본·crash work에 대한 실제 볼륨 quota/여유 공간·보유 정책은 운영 준비에서 확정해야 한다. 이 구현이 전체 디스크 사용량을 강제 제한한다고 표시하지 않는다.

## 검증

Windows의 OS 제한 프로세스와 합성 파일로 새 C4 확인 33개를 수행했다.

- 동일 요청 동시 준비에서 실제 compile 1회와 cache hit, 새 store에서도 재컴파일 없는 재사용.
- 원문 revision 변경 시 다른 key, 같은 입력 재빌드 시 동일 DLL 해시.
- 소유자 분리·단일 writer·원본 guard 위치·DLL 변조/메타데이터 버전 변조 거절.
- 원문 파일이 없는 상태에서 artifact만으로 실제 실행, 두 호스트의 독립 상태, timeout 뒤 동일 객체 재호출.
- 실행 lease가 하나라도 남아 있으면 삭제 거절; 준비된 null 이름의 초기화 실패 뒤 lease 반환.
- 취소 전/실제 compiler 실행 중 취소·출력 한도·cache 한도에서 원문 유지 및 작업 정리.
- 사용자 초기화가 무한 반복인 코드도 **컴파일만** 완료: 준비 단계에서 해당 함수를 호출하지 않음.
- 임시 source의 owner 내구 기록과 종료 뒤 예약 메모리/프로세스 0 확인.

[최종 검증 원본](benchmarks/csharp-c4a-2026-11-19.json)을 보관한다. 기존 C1~C3·부모·BE 회귀도 유지한다. Linux의 실제 cgroup·부모 장애 감독·권한은 이 환경에서 검증하지 않았다.

최종 전체 BE 검증은 C1 62건·C2/정책 223개 확인·C3 30개·부모 42개·C4-A 33개 확인, 기존 .NET 계약/업무/OS 59건, BE 통합 13그룹·프로토콜 5건 통과다. 빌드 경고/오류는 0개다. 개발 중 descriptor 정렬/실행 인자 순서 문제를 발견해 수정했다. 실패한 이번 시험 프로세스만 명령줄을 확인해 정리했으며 사용자 서버를 종료하지 않았다.

재현:

```powershell
$env:COINHUNTER_BUILD_ROOT='artifacts/c4-receipt-build'
node scripts/backend.js build
dotnet artifacts/c4-receipt-build/bin/CoinHunter.Backend.Checks/debug/CoinHunter.Backend.Checks.dll . csharp-preparation
```

## 후속 C4-B

2026-11-19 [C4-B 첫 구현](csharp-recovery-preflight-c4b.md)에서 작업 회수·36회 artifact 검사·검사 결과 파일 어댑터를 추가했다. 아래 목록의 계정/Node 연결·볼륨 정책은 계속 남는다.

1. orphan 작업/파일·준비 프로세스의 crash 복구, 실제 볼륨 quota·보유/정리 정책 보강.
2. 컴파일된 artifact를 이용한 맵/아이템/연속 호출 preflight와 진단·검사 버전 연결.
3. 계정 source revision/검사 상태·산출물 참조의 추상 저장 계약에 연결. 원문 파일 보관 유지.
4. Node 어댑터·세션 source/artifact snapshot·계정 경로를 연결한 뒤 최종 채택/보안/부하 관문을 검증.

native/GC·문자열 등의 중간 중단 한계는 계속 남아 있다. 이번 C4-A는 그 한계를 해결하거나 게임의 timeout/프로세스 교체 정책을 바꾼 작업이 아니다. 새 C4 변경은 아직 커밋/푸시하지 않았다.
