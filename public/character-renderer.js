import { characterFor } from './characters.js';

let atlas;
let hammerAtlas;
let directionalSprites;
const directionNames = ['left', 'up', 'right', 'down'];
export async function loadCharacters() {
  const loaded = await Promise.all([
    loadAtlas('/assets/characters/atlas.png'),
    loadAtlas('/assets/characters/atlas-hammer.png'),
    ...directionNames.map(async (name) =>
      splitSprites(await loadAtlas(`/assets/characters/${name}.png`)),
    ),
  ]);
  [atlas, hammerAtlas] = loaded;
  directionalSprites = loaded.slice(2);
}

// Generated sheets have uneven gutters and overlapping bounding boxes (tails/hats).
// Extract connected silhouettes once at load time, rather than clipping a fixed grid.
function splitSprites(atlas) {
  const { width, height } = atlas;
  const data = atlas.getContext('2d').getImageData(0, 0, width, height).data;
  const labels = new Int32Array(width * height);
  const queue = new Int32Array(labels.length);
  const components = [];
  for (let start = 0; start < labels.length; start++) {
    if (labels[start] || !data[start * 4 + 3]) continue;
    const component = {
      label: components.length + 1,
      x: width,
      y: height,
      right: 0,
      bottom: 0,
      size: 0,
    };
    let head = 0,
      tail = 1;
    queue[0] = start;
    labels[start] = component.label;
    const add = (index) => {
      if (!labels[index] && data[index * 4 + 3]) {
        labels[index] = component.label;
        queue[tail++] = index;
      }
    };
    while (head < tail) {
      const index = queue[head++];
      const x = index % width,
        y = Math.floor(index / width);
      component.x = Math.min(component.x, x);
      component.y = Math.min(component.y, y);
      component.right = Math.max(component.right, x);
      component.bottom = Math.max(component.bottom, y);
      if (x > 0) add(index - 1);
      if (x + 1 < width) add(index + 1);
      if (y > 0) add(index - width);
      if (y + 1 < height) add(index + width);
    }
    component.size = tail;
    components.push(component);
  }
  const figures = components.sort((a, b) => b.size - a.size).slice(0, 20);
  if (figures.length !== 20 || figures.some((figure) => figure.size < (width * height) / 500))
    throw new Error('Invalid directional character atlas');
  figures.sort((a, b) => a.y + a.bottom - (b.y + b.bottom));
  const rows = Array.from({ length: 4 }, (_, row) =>
    figures.slice(row * 5, row * 5 + 5).sort((a, b) => a.x - b.x),
  );
  return rows.map((row) =>
    row.map((figure) => {
      const sprite = document.createElement('canvas');
      sprite.width = figure.right - figure.x + 1;
      sprite.height = figure.bottom - figure.y + 1;
      const ctx = sprite.getContext('2d');
      const pixels = ctx.createImageData(sprite.width, sprite.height);
      for (let y = 0; y < sprite.height; y++) {
        for (let x = 0; x < sprite.width; x++) {
          const source = (y + figure.y) * width + x + figure.x;
          if (labels[source] === figure.label)
            pixels.data.set(data.subarray(source * 4, source * 4 + 4), (y * sprite.width + x) * 4);
        }
      }
      ctx.putImageData(pixels, 0, 0);
      return sprite;
    }),
  );
}

export function drawDirectionalCharacter(
  ctx,
  id,
  x,
  feetY,
  height,
  direction = 3,
  frame = 0,
  hammer = false,
) {
  const poses = directionalSprites?.[direction] ?? directionalSprites?.[3];
  if (!poses) return;
  const column = characterFor(id).column;
  const sprite = poses[(hammer ? 2 : 0) + (frame === 1 ? 1 : 0)][column];
  // Share the normal idle scale across costumes/poses; helmet replacement doesn't resize the body.
  const scale = (height * 0.85) / poses[0][column].height;
  const w = sprite.width * scale,
    h = sprite.height * scale;
  ctx.drawImage(sprite, x - w / 2, feetY - h, w, h);
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
    // Only key saturated neon green; darker green is part of Dino's skin/shading.
    if (g > 180 && r < 75 && b < 75) pixels.data[i + 3] = 0;
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
