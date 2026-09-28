import { characterFor } from './characters.js';
import { drawCharacter } from './character-renderer.js';

export function rankPlayers(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.id - b.id);
  return sorted.map((player) => ({
    ...player,
    rank: sorted.findIndex((other) => other.score === player.score) + 1,
    tied: sorted.some((other) => other.id !== player.id && other.score === player.score),
  }));
}

export function renderPodium(container, players) {
  container.replaceChildren();
  const ranked = rankPlayers(players);
  // Keep the winner between second and third; the fourth player stands to the right.
  const order = ranked.length > 1 ? [ranked[1], ranked[0], ...ranked.slice(2)] : ranked;
  for (const player of order) {
    const column = document.createElement('li');
    column.className = `podium-player rank-${player.rank}`;
    column.dataset.player = player.id;
    column.dataset.rank = player.rank;
    column.setAttribute(
      'aria-label',
      `${player.tied ? '공동 ' : ''}${player.rank}위, P${player.id + 1}, ${player.name}, ${player.score.toLocaleString()}점`,
    );
    const portrait = document.createElement('canvas');
    portrait.width = 180;
    portrait.height = 200;
    portrait.className = 'podium-character';
    portrait.setAttribute('aria-hidden', 'true');
    drawCharacter(portrait.getContext('2d'), player.characterId, 90, 207, 200);
    const identity = document.createElement('div');
    identity.className = 'podium-identity';
    identity.textContent = `P${player.id + 1} · ${characterFor(player.characterId).name}${player.id === 0 ? ' · 나' : ''}`;
    const name = document.createElement('div');
    name.className = 'podium-name';
    name.textContent = player.name;
    name.title = player.name;
    const block = document.createElement('div');
    block.className = 'podium-block';
    const rank = document.createElement('span');
    rank.className = 'podium-rank';
    rank.textContent = `${player.tied ? '공동 ' : ''}${player.rank}위`;
    const score = document.createElement('strong');
    score.className = 'podium-score';
    score.textContent = `${player.score.toLocaleString()}점`;
    block.append(rank, score);
    column.append(identity, name, portrait, block);
    container.append(column);
  }
}
