# 망치 장착 캐릭터 에셋 · 2026-09-28

`public/assets/characters/atlas-hammer.png`는 코비, 펭코, 냥탐이, 디노, 루미 순서의 5열 × 2행 안전모 전용 이미지다. 위쪽은 대기, 아래쪽은 걷기 포즈다. 코비 안테나, 냥탐이 귀, 디노 돌기, 루미 머리카락에 맞게 안전모를 그렸으며 루미의 기존 마법사 모자는 안전모로 교체했다.

내장 imagegen 편집 모드로 기존 `atlas.png`를 참조해 생성했다. 실제 알파 배경 대신 녹색 크로마키 배경을 사용하며 기존 렌더러와 동일하게 로드 시 한 번 제거한다. 두 아틀라스를 함께 로드하고 `player.effect.type === 1`일 때만 안전모 이미지를 사용한다. 효과 종료·다른 아이템 획득 시 기본 이미지로 돌아간다. 기존 도형 안전모 덧그리기는 제거했으며 벽 파괴 망치 애니메이션은 유지한다. 선택 화면과 결과 화면은 기본 이미지를 사용한다.

## 최초 생성 프롬프트

```text
Edit the provided 1536x1024 game character atlas into a helmet-equipped variant. Asset: 5 columns x 2 rows, ten full-body 2D cartoon sprites. Keep EXACT existing character identities, face shapes, expressions, body proportions, body colors, clothing, accessories below the head, poses, sizes, x/y locations and foot baselines. Top row is idle, bottom row is walk. Change ONLY headgear: each character wears a bright golden-yellow construction hard hat designed and drawn to fit its individual head with convincing perspective, a small brim, center ridge and subtle shadow where it touches the head. No floating helmet, no bar overlay, no oversized helmet, no face obstruction.
Column 1: white orange robot Kobi, helmet hugs its round dome, antenna passes through a custom opening; preserve screen face and orange ear pieces.
Column 2: navy white penguin Pengko, snug hard hat replacing its aviator goggles on top, keep blue scarf and backpack; brown goggle strap can wrap the helmet.
Column 3: explorer cat Nyangtami, hard hat REPLACES safari hat, fitted ear cutouts let both orange ears remain visible, keep red scarf.
Column 4: green dinosaur Dino, rounded helmet matching its wide curved skull, red spikes behind helmet still visible; keep green face and cream belly.
Column 5: wizard Lumi, hard hat REPLACES purple pointed wizard hat entirely (no old hat beneath it). Keep lavender hair and gold star badge on helmet, purple cape, blue-orb staff and face. Do NOT enlarge face/body to fill space vacated by the pointed hat.
Keep both rows' animations consistent. No added hammer or tool. No text, labels, tile backgrounds, grid, ground shadow, or glow.
Remove the neon green backdrop and return REAL alpha transparency. Preserve all green character body pixels (Dino). Exact 5-column 2-row arrangement and original alignment for direct runtime sprite swapping; do not move or rescale the characters.
```

## 배경 수정 프롬프트

```text
Edit this sprite atlas. Preserve all ten helmet-wearing characters EXACTLY as drawn, same positions, sizes, poses, colors and equipment. Replace ALL background between and around characters with perfectly uniform solid pure neon green #00FF00 (RGB 0,255,0). No gradients, shadows, checkerboard, glow or ground. Keep green dinosaur body unchanged. Sharp clean sprite silhouettes, no green spill. Same 1536x1024 canvas, five columns two rows. Background replacement only.
```
