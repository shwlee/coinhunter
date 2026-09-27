# 플레이어 캐릭터 · 2026-09-27

사용자가 제공한 `characters_plan.png`의 디자인을 바탕으로 내장 image_gen 도구로 2D 셀 애니메이션풍 스프라이트를 생성했다. 코비는 더미 전용이며 펭코, 냥탐이, 디노, 루미 중 하나를 경기 전에 선택한다. 캐릭터는 외형만 바꾸며 이동 시간, 알고리즘 규약, 점수와 아이템 규칙에는 영향을 주지 않는다.

## 파일과 렌더링

- `public/assets/characters/atlas.png`: 5열 × 2행의 원본 PNG. 열 순서는 코비 / 펭코 / 냥탐이 / 디노 / 루미, 위쪽은 대기, 아래쪽은 걷기 포즈다.
- `public/characters.js`: 클라이언트와 서버가 공유하는 캐릭터 식별자·표시 이름·선택 가능 여부.
- `public/character-renderer.js`: 이미지를 한 번 읽고 크로마키 배경을 제거해 메모리 캔버스에 보관한다. 이미지 생성 결과에 실제 알파 투명 배경이 제공되지 않아 단색 녹색 배경 버전을 사용했다. 순수 녹색에 가까운 색만 제거하며 디노의 연두색 몸체는 유지한다. 원본 파일은 투명 PNG가 아니다.

걷기는 두 포즈 전환과 상하 움직임, 좌향 이동은 좌우 반전으로 표현한다. 대기는 가벼운 호흡 움직임, 벽 충돌·제자리 패널티·점프 실패는 갸웃 동작, 순간이동은 축소·확대, 벽 파괴는 망치 동작을 사용한다. 전후좌우 전용 프레임을 갖춘 다방향 스프라이트는 이번 범위에 포함하지 않는다.

사용자의 선택은 브라우저 설정으로 기억하며 서버 경기 상태의 `players[].characterId`에도 저장된다. 경기 재연결 시 서버 상태를 우선한다. 경기 준비 중과 진행 중에는 선택을 잠근다. 서버는 코비 및 알 수 없는 ID를 사용자 캐릭터로 지정하는 요청을 거부한다. 이전 API 호출에서 ID를 생략하면 펭코를 사용한다. 더미는 항상 코비다.

## 생성 프롬프트

내장 이미지 생성 도구 사용. 외부 API/CLI는 사용하지 않았다. 참고 원본을 입력으로 제공했다.

1. 5열 × 2행의 2D 셀 셰이딩 스프라이트 시트 생성. 각 열은 흰색·주황색 로봇, 고글과 파란 목도리를 두른 펭귄, 탐험 모자와 붉은 스카프를 두른 고양이, 연두색 몸과 붉은 돌기의 공룡, 보라색 별 장식 모자와 푸른 구슬 지팡이를 든 마법사. 위쪽은 대기 자세, 아래쪽은 걷는 자세. 원본 색과 소품 유지. 같은 셀 크기, 온전한 전신, 글자·그리드·배경·그림자 제외, 1536×1024.
2. 배경만 실제 투명 알파로 제거하고 캐릭터 위치·크기·윤곽 유지 요청. 결과에 배경이 남아 최종본으로 사용하지 않음.
3. 최종 수정 프롬프트:

> Replace only the background of this sprite atlas with one perfectly flat solid chroma-key color #00FF00 RGB(0,255,0). No gradients, no glow, no shadow, no texture. Entire background everywhere between and around figures must be identical pure neon green. Keep all ten figures exactly as drawn in these 5 columns and 2 rows, same sizes and placement, no cutoffs. Especially preserve the dinosaur's existing muted light green body, which is distinct from pure neon green. This is for a game engine that keys out pure green. Keep existing dark outlines. 1536x1024.

## 경기 준비 UI

게임판 블러 영역 안에서 캐릭터 선택 → 시작 위치 선택 순서로 진행한다. 다음 버튼으로 네 모서리 선택 화면에 들어가고, 이전 버튼으로 캐릭터를 다시 고를 수 있다. 위치 선택 단계와 알고리즘 업로드가 준비되면 경기 시작 버튼이 활성화된다. 경기 중에는 준비 UI가 숨겨지며 종료 후 캐릭터 선택부터 다시 진행한다.

시작 위치는 왼쪽 위 / 오른쪽 위 / 왼쪽 아래 / 오른쪽 아래를 0~3으로 표현한다. POST /api/matches에 `startSlot`으로 전달하며 생략하면 0, 잘못된 값이면 400을 반환한다. 서버는 플레이어 상태의 `startSlot`에 배정한 위치를 기록하여 새로고침 후에도 복원한다. 더미는 남은 모서리를 번호순으로 배정한다. 플레이어 ID와 알고리즘의 initialize 인자는 위치에 따라 바뀌지 않는다.

## 검증

`npm test` 및 `npm run test:browser`로 캐릭터 ID 검증, 더미 고정, 초상화 렌더링과 배경 투명화, 선택 잠금, 새로고침 후 유지, 모바일 가로 넘침 여부를 확인한다. 브라우저 스크린샷은 `artifacts/`에 생성한다.
