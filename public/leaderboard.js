import { characterFor } from './characters.js';
import { drawCharacter } from './character-renderer.js';

const states = new WeakMap();

export function rankLivePlayers(players, previous = []) {
  const order = new Map(previous.map((id, index) => [id, index]));
  const sorted = [...players].sort(
    (a, b) =>
      b.score - a.score ||
      (order.get(a.id) ?? previous.length + a.id) - (order.get(b.id) ?? previous.length + b.id),
  );
  return sorted.map((player) => ({
    ...player,
    rank: sorted.findIndex((other) => other.score === player.score) + 1,
    tied: sorted.some((other) => other.id !== player.id && other.score === player.score),
  }));
}

export function renderLeaderboard(container, players, { colors, effectNames, reset = false }) {
  const state = states.get(container) ?? { order: [] };
  const ranked = rankLivePlayers(players, reset ? [] : state.order);
  const nextOrder = ranked.map((player) => player.id);
  const reordered = state.order.join(',') !== nextOrder.join(',');
  const oldRects = new Map(
    (reordered ? [...container.children] : []).map((card) => [
      Number(card.dataset.player),
      card.getBoundingClientRect(),
    ]),
  );
  const text = (card, selector, value) => {
    const element = card.querySelector(selector);
    if (element.textContent !== value) element.textContent = value;
  };
  for (const player of ranked) {
    let card = [...container.children].find((card) => Number(card.dataset.player) === player.id);
    if (!card) {
      card = document.createElement('li');
      card.className = 'score-card';
      card.dataset.player = player.id;
      card.innerHTML =
        '<div class="live-rank"></div><canvas class="score-portrait" width="64" height="80" aria-hidden="true"></canvas><div class="score-identity"><div class="character-caption"></div><div class="name"><i class="player-marker"></i><span></span></div></div><div class="score"></div><div class="detail"></div>';
      container.append(card);
    }
    card.dataset.character = player.characterId;
    card.dataset.rank = player.rank;
    card.classList.toggle('is-self', player.id === 0);
    text(card, '.live-rank', reset ? '준비' : `${player.tied ? '공동 ' : ''}${player.rank}위`);
    text(
      card,
      '.character-caption',
      `P${player.id + 1} · ${characterFor(player.characterId).name}${player.id === 0 ? ' · 나' : ''}`,
    );
    text(card, '.name span', player.name);
    card.querySelector('.name').title = player.name;
    card.querySelector('.player-marker').style.backgroundColor = colors[player.id];
    text(card, '.score', player.score.toLocaleString());
    text(
      card,
      '.detail',
      reset
        ? '대기 중'
        : player.effect
          ? `${effectNames[player.effect.type]} · ${player.effect.remaining} 남음`
          : `TURN ${String(player.turn).padStart(3, '0')}`,
    );
    const portraitKey = `${player.characterId}:${player.effect?.type === 1}`;
    if (card.dataset.portrait !== portraitKey) {
      const portrait = card.querySelector('canvas'),
        ctx = portrait.getContext('2d');
      ctx.clearRect(0, 0, portrait.width, portrait.height);
      drawCharacter(ctx, player.characterId, 32, 80, 80, 0, false, player.effect?.type === 1);
      card.dataset.portrait = portraitKey;
    }
    if (reordered) container.append(card);
  }
  for (const card of [...container.children])
    if (!nextOrder.includes(Number(card.dataset.player))) card.remove();
  if (
    reordered &&
    !reset &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches &&
    container.getClientRects().length
  ) {
    for (const card of container.children) {
      const before = oldRects.get(Number(card.dataset.player));
      if (!before?.height) continue;
      card.getAnimations().forEach((animation) => animation.cancel());
      const after = card.getBoundingClientRect();
      const dy = before.top - after.top;
      if (dy)
        card.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
          duration: 250,
          easing: 'ease-out',
        });
    }
  }
  state.order = nextOrder;
  states.set(container, state);
}
