// Visual separation only: game positions, collisions and item ownership stay unchanged.
export function playerVisuals(players, columns, now) {
  const visuals = players.map((player) => {
    let x = player.position % columns;
    let y = Math.floor(player.position / columns);
    const action = player.action;
    const progress = action
      ? Math.max(0, Math.min(1, (now - action.startedAt) / (action.endsAt - action.startedAt)))
      : 0;
    if (action?.type === 'move') {
      x += ((action.to % columns) - x) * progress;
      y += (Math.floor(action.to / columns) - y) * progress;
    } else if (action?.type === 'jump' && progress > 0.5) {
      x = action.to % columns;
      y = Math.floor(action.to / columns);
    }
    return { player, x, y, progress, offset: 0, scale: 1 };
  });
  for (let i = 0; i < visuals.length; i++) {
    for (let j = i + 1; j < visuals.length; j++) {
      const a = visuals[i],
        b = visuals[j];
      const proximity = Math.max(0, 1 - Math.hypot(a.x - b.x, a.y - b.y) / 0.5);
      const sign = a.player.id < b.player.id ? 1 : -1;
      a.offset -= sign * 9 * proximity;
      b.offset += sign * 9 * proximity;
      a.scale -= 0.15 * proximity;
      b.scale -= 0.15 * proximity;
    }
  }
  return visuals;
}
