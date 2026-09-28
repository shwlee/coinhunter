const definitions = {
  10: { file: 'Coins.png', prefix: 'Cooper', color: '#e4a06d', size: 24 },
  30: { file: 'Coins.png', prefix: 'Silver', color: '#d8e8ff', size: 24 },
  100: { file: 'Coins.png', prefix: 'Gold', color: '#ffd563', size: 28 },
  200: { file: 'Diamond.png', prefix: 'Diamond_', color: '#7edbff', size: 30 },
  500: { file: 'blackmatter.png', prefix: 'blackmatter_', color: '#c39aff', size: 30 },
};
let frames, images;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export async function loadCoins() {
  const response = await fetch('/assets/coins/frames.json');
  if (!response.ok) throw new Error('Coin atlas metadata unavailable');
  frames = await response.json();
  images = new Map(
    await Promise.all(
      Object.keys(frames).map(async (file) => {
        const image = new Image();
        image.src = '/assets/coins/' + file;
        await image.decode();
        return [file, image];
      }),
    ),
  );
}

function sprite(ctx, file, frame, x, y, size) {
  const width = (size * frame.w) / 8;
  const height = (size * frame.h) / 8;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    images.get(file),
    frame.x,
    frame.y,
    frame.w,
    frame.h,
    Math.round(x - width / 2),
    Math.round(y - height / 2),
    width,
    height,
  );
}

export function drawCoin(ctx, value, x, y, now, index = 0, bornAt) {
  const definition = definitions[value];
  if (!images || !definition) return;
  const time = reducedMotion.matches ? 0 : now + index * 83;
  const bob = reducedMotion.matches ? 0 : Math.sin(time / 420) * 2;
  ctx.save();
  ctx.fillStyle = '#00000040';
  ctx.beginPath();
  ctx.ellipse(x, y + 16, definition.size * 0.35, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = definition.color;
  ctx.shadowBlur = value >= 100 ? 8 : 3;
  const appearing =
    value === 500 && bornAt !== undefined && now - bornAt < 700 && !reducedMotion.matches;
  if (appearing) {
    const file = 'appear_blackmatter.png';
    const sequence = frames[file].frames;
    sprite(
      ctx,
      file,
      sequence[Math.min(sequence.length - 1, Math.max(0, Math.floor((now - bornAt) / 100)))],
      x,
      y,
      definition.size,
    );
  } else {
    const sequence = frames[definition.file].frames.filter((frame) =>
      frame.name.startsWith(definition.prefix),
    );
    sprite(
      ctx,
      definition.file,
      sequence[Math.floor(time / (value === 500 ? 100 : 167)) % sequence.length],
      x,
      y + bob,
      definition.size,
    );
  }
  ctx.restore();
}

export function drawCoinPickup(ctx, player, now, columns, cell, pad) {
  if (player.coinBurstAt === undefined || player.coinBurstPosition === undefined) return;
  const age = now - player.coinBurstAt;
  if (age < 0 || age >= 650) return;
  const progress = age / 650;
  const x = pad + (player.coinBurstPosition % columns) * cell + cell / 2;
  const y = pad + Math.floor(player.coinBurstPosition / columns) * cell + cell / 2;
  ctx.save();
  ctx.globalAlpha = 1 - progress;
  ctx.fillStyle = definitions[player.coinBurstValue]?.color || '#ffd563';
  if (!reducedMotion.matches) {
    const count = player.coinBurstBoosted ? 10 : 5;
    for (let i = 0; i < count; i++) {
      const angle = (i * Math.PI * 2) / count;
      const radius = 8 + progress * (player.coinBurstBoosted ? 32 : 20);
      ctx.fillRect(
        x + Math.cos(angle) * radius - 2,
        y + Math.sin(angle) * radius - progress * 12 - 2,
        4,
        4,
      );
    }
  }
  ctx.textAlign = 'center';
  ctx.font = 'bold 14px sans-serif';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#101722';
  const label = `+${player.coinBurstValue * (player.coinBurstBoosted ? 2 : 1)}`;
  const labelY = y - 22 - (reducedMotion.matches ? 0 : progress * 18);
  ctx.strokeText(label, x, labelY);
  ctx.fillText(label, x, labelY);
  ctx.restore();
}
