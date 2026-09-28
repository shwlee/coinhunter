# 방향별 캐릭터 스프라이트 · 2026-09-28

## 에셋 구성

내장 imagegen 도구로 기존 `atlas.png` 및 `atlas-hammer.png`를 참조하여 생성했다. 다음 4개 파일은 각각 5열 × 4행(20포즈)이며 총 80포즈다.

- `public/assets/characters/left.png`: 왼쪽
- `public/assets/characters/up.png`: 위쪽, 뒷모습
- `public/assets/characters/right.png`: 오른쪽
- `public/assets/characters/down.png`: 아래쪽, 정면

열은 코비·펭코·냥탐이·디노·루미, 행은 기본 대기·기본 걷기·안전모 대기·안전모 걷기 순서다. 원본 PNG는 녹색 크로마키 배경이며 실제 알파 PNG가 아니다. 기존 두 아틀라스는 선택 화면 및 포디엄용으로 유지한다.

## 렌더링과 상태

`GameState.players[].facing`은 기존 알고리즘 방향 값(0 왼쪽, 1 위, 2 오른쪽, 3 아래)을 사용한다. 초기값은 아래쪽이다. 유효한 방향 결과를 받으면 이동·벽 충돌·벽 파괴 시 해당 방향으로 전환하고, 대기·패널티·점프 및 아이템 교체 중에는 마지막 방향을 유지한다. 스냅샷에 포함되므로 재접속 시에도 복원한다. 알고리즘 인자와 실행 규칙은 변경하지 않는다.

`drawDirectionalCharacter`가 방향·포즈·망치 효과에 맞는 이미지를 선택한다. 안전모는 효과 종료 또는 다른 아이템 교체 시 같은 방향의 기본 복장으로 돌아간다. 신발 잔상과 벽 파괴 망치 위치에도 같은 방향을 적용했다. 이동 시 상하 흔들림을 줄였다.

생성된 이미지의 모자·꼬리가 규칙적인 셀 경계를 넘는 경우가 있어, 로딩 시 크로마키를 제거한 뒤 연결된 윤곽 20개를 분리한다. 녹색 배경과 구분되도록 디노의 짙은 녹색 음영은 보존한다. 프레임을 발 밑 기준으로 정렬하며 방향별 기본 대기 이미지의 배율을 해당 방향의 다른 포즈와 복장에 공유한다. 매 프레임 픽셀 분석은 하지 않는다. 새 에셋 교체 시 분리된 윤곽이 20개이며 캐릭터 소품이 몸체와 이어지는지 갤러리 확인이 필요하다.

검증: 게임 상태 테스트(방향 유지·벽 액션·망치 소진·점프), 브라우저 80포즈 렌더링 확인, `artifacts/direction-gallery.png` 시각 검토.

## 생성 프롬프트

각 방향마다 아래 프롬프트를 내장 도구에 전달했다. 외부 CLI/API를 사용하지 않았다.

### left

```text
Create a production game sprite atlas using reference 1 for normal costumes and reference 2 for fitted yellow hard hats. Same cute 2D outlined characters, same identities, colors, proportions. Exactly 1600x2048 canvas, 5 equal columns by 4 equal rows, twenty sprites, one full body character per 320x512 cell. Columns LEFT TO RIGHT: white orange robot Kobi with antenna, blue penguin Pengko with scarf and backpack, orange explorer cat Nyangtami with red scarf, green dinosaur Dino with red dorsal spikes, lavender haired wizard Lumi with purple cape and orb staff.
Rows TOP TO BOTTOM: row1 normal costume neutral standing; row2 normal costume mid walking stride; row3 yellow construction hard hat neutral standing; row4 yellow construction hard hat mid walking stride. Normal costumes use original headgear; hard hats REPLACE normal headgear, especially Lumi has no wizard hat under the hard hat. Cat ears and robot antenna remain visible through hard hat openings. No held hammer.
All characters face LEFT, moving toward the LEFT edge of the screen. Strict LEFT SIDE PROFILE for every sprite, nose/beak/robot face pointing LEFT. Left side of image is forward. Tail/backpack/cape trail toward RIGHT. No front-facing or rear-facing bodies. True directional full body view, not eyes looking sideways. CAMERA is slightly elevated for a 2D grid game, orthographic, same camera angle for all. Direction is relative to screen. No diagonal facing. Neutral and walking poses have identical scale and head size; walking has subtle alternating arms/legs, not running or jumping. Center each figure horizontally in its cell; feet baseline at 94% of each cell height. Full figure including hat/staff within cell, with 8% horizontal margin. Keep figures about 80% cell height, consistent scale between normal and helmet costumes; Lumi helmet has same body size as normal Lumi. 
Background MUST be perfectly flat pure neon green #00FF00 RGB(0,255,0), no transparency, no gradients, no shadows, no floor, no labels, no grid lines. Preserve dinosaur muted light green skin distinct from chroma green. Clean outlines with no green spill.
```

### up

```text
Create a production game sprite atlas using reference 1 for normal costumes and reference 2 for fitted yellow hard hats. Same cute 2D outlined characters, same identities, colors, proportions. Exactly 1600x2048 canvas, 5 equal columns by 4 equal rows, twenty sprites, one full body character per 320x512 cell. Columns LEFT TO RIGHT: white orange robot Kobi with antenna, blue penguin Pengko with scarf and backpack, orange explorer cat Nyangtami with red scarf, green dinosaur Dino with red dorsal spikes, lavender haired wizard Lumi with purple cape and orb staff.
Rows TOP TO BOTTOM: row1 normal costume neutral standing; row2 normal costume mid walking stride; row3 yellow construction hard hat neutral standing; row4 yellow construction hard hat mid walking stride. Normal costumes use original headgear; hard hats REPLACE normal headgear, especially Lumi has no wizard hat under the hard hat. Cat ears and robot antenna remain visible through hard hat openings. No held hammer.
All characters face UP, moving toward the TOP of the screen, seen entirely FROM BEHIND. All twenty sprites show BACKS of heads and bodies; faces/eyes/mouths NOT visible. Show backpacks on penguin and cat, robot rear panels, dinosaur back spikes and tail, wizard cape and back of purple hat / yellow helmet. True directional full body view, not eyes looking sideways. CAMERA is slightly elevated for a 2D grid game, orthographic, same camera angle for all. Direction is relative to screen. No diagonal facing. Neutral and walking poses have identical scale and head size; walking has subtle alternating arms/legs, not running or jumping. Center each figure horizontally in its cell; feet baseline at 94% of each cell height. Full figure including hat/staff within cell, with 8% horizontal margin. Keep figures about 80% cell height, consistent scale between normal and helmet costumes; Lumi helmet has same body size as normal Lumi. 
Background MUST be perfectly flat pure neon green #00FF00 RGB(0,255,0), no transparency, no gradients, no shadows, no floor, no labels, no grid lines. Preserve dinosaur muted light green skin distinct from chroma green. Clean outlines with no green spill.
```

### right

```text
Create a production game sprite atlas using reference 1 for normal costumes and reference 2 for fitted yellow hard hats. Same cute 2D outlined characters, same identities, colors, proportions. Exactly 1600x2048 canvas, 5 equal columns by 4 equal rows, twenty sprites, one full body character per 320x512 cell. Columns LEFT TO RIGHT: white orange robot Kobi with antenna, blue penguin Pengko with scarf and backpack, orange explorer cat Nyangtami with red scarf, green dinosaur Dino with red dorsal spikes, lavender haired wizard Lumi with purple cape and orb staff.
Rows TOP TO BOTTOM: row1 normal costume neutral standing; row2 normal costume mid walking stride; row3 yellow construction hard hat neutral standing; row4 yellow construction hard hat mid walking stride. Normal costumes use original headgear; hard hats REPLACE normal headgear, especially Lumi has no wizard hat under the hard hat. Cat ears and robot antenna remain visible through hard hat openings. No held hammer.
All characters face RIGHT, moving toward the RIGHT edge of the screen. Strict RIGHT SIDE PROFILE for every sprite, nose/beak/robot face pointing RIGHT. Right side of image is forward. Tail/backpack/cape trail toward LEFT. No front-facing or rear-facing bodies. True directional full body view, not eyes looking sideways. CAMERA is slightly elevated for a 2D grid game, orthographic, same camera angle for all. Direction is relative to screen. No diagonal facing. Neutral and walking poses have identical scale and head size; walking has subtle alternating arms/legs, not running or jumping. Center each figure horizontally in its cell; feet baseline at 94% of each cell height. Full figure including hat/staff within cell, with 8% horizontal margin. Keep figures about 80% cell height, consistent scale between normal and helmet costumes; Lumi helmet has same body size as normal Lumi. 
Background MUST be perfectly flat pure neon green #00FF00 RGB(0,255,0), no transparency, no gradients, no shadows, no floor, no labels, no grid lines. Preserve dinosaur muted light green skin distinct from chroma green. Clean outlines with no green spill.
```

### down

```text
Create a production game sprite atlas using reference 1 for normal costumes and reference 2 for fitted yellow hard hats. Same cute 2D outlined characters, same identities, colors, proportions. Exactly 1600x2048 canvas, 5 equal columns by 4 equal rows, twenty sprites, one full body character per 320x512 cell. Columns LEFT TO RIGHT: white orange robot Kobi with antenna, blue penguin Pengko with scarf and backpack, orange explorer cat Nyangtami with red scarf, green dinosaur Dino with red dorsal spikes, lavender haired wizard Lumi with purple cape and orb staff.
Rows TOP TO BOTTOM: row1 normal costume neutral standing; row2 normal costume mid walking stride; row3 yellow construction hard hat neutral standing; row4 yellow construction hard hat mid walking stride. Normal costumes use original headgear; hard hats REPLACE normal headgear, especially Lumi has no wizard hat under the hard hat. Cat ears and robot antenna remain visible through hard hat openings. No held hammer.
All characters face DOWN, moving toward the BOTTOM of the screen, directly facing the viewer. Strict FRONT VIEW for every sprite, face centered, both eyes visible, body squarely frontal and symmetrical neutral standing. No sideways or three-quarter facing. Backpacks are behind bodies, dinosaur belly in front. True directional full body view, not eyes looking sideways. CAMERA is slightly elevated for a 2D grid game, orthographic, same camera angle for all. Direction is relative to screen. No diagonal facing. Neutral and walking poses have identical scale and head size; walking has subtle alternating arms/legs, not running or jumping. Center each figure horizontally in its cell; feet baseline at 94% of each cell height. Full figure including hat/staff within cell, with 8% horizontal margin. Keep figures about 80% cell height, consistent scale between normal and helmet costumes; Lumi helmet has same body size as normal Lumi. 
Background MUST be perfectly flat pure neon green #00FF00 RGB(0,255,0), no transparency, no gradients, no shadows, no floor, no labels, no grid lines. Preserve dinosaur muted light green skin distinct from chroma green. Clean outlines with no green spill.
```
