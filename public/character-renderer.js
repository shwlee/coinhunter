import { characterFor } from './characters.js';

let atlas;
let hammerAtlas;
export async function loadCharacters() {
  [atlas, hammerAtlas] = await Promise.all([
    loadAtlas('/assets/characters/atlas.png'),
    loadAtlas('/assets/characters/atlas-hammer.png'),
  ]);
}

async function loadAtlas(path) {
  const image = new Image();
  image.src = path;
  await image.decode();
  // Generated atlas uses a chroma-key backdrop. Decode once, never per frame.
  const atlas = document.createElement('canvas');
  atlas.width = image.naturalWidth;
  atlas.height = image.naturalHeight;
  const context = atlas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, atlas.width, atlas.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const [r, g, b] = pixels.data.subarray(i, i + 3);
    if (g > 120 && g > r * 1.8 && g > b * 1.8) pixels.data[i + 3] = 0;
  }
  context.putImageData(pixels, 0, 0);
  return atlas;
}

export function drawCharacter(ctx, id, x, feetY, height, frame = 0, flip = false, hammer = false) {
  const sprite = hammer ? hammerAtlas : atlas;
  if (!sprite) return;
  // Lumi's wide hat extends slightly left of the generated nominal grid.
  const edges = [0, 0.2, 0.4, 0.6, 1214 / 1536, 1];
  const column = characterFor(id).column;
  const sourceX = edges[column] * sprite.width;
  const cellWidth = (edges[column + 1] - edges[column]) * sprite.width;
  const cellHeight = sprite.height / 2;
  const width = (height * cellWidth) / cellHeight;
  ctx.save();
  ctx.translate(x, feetY);
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(
    sprite,
    sourceX,
    frame * cellHeight,
    cellWidth,
    cellHeight,
    -width / 2,
    -height,
    width,
    height,
  );
  ctx.restore();
}
