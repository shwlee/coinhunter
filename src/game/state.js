import { validateMap } from './maps.js';
import { DEFAULT_CHARACTER, isPlayableCharacter } from '../../public/characters.js';

export class GameState {
  constructor(map, names, options = {}, random = Math.random) {
    validateMap(map);
    this.columns = map.columns;
    this.rows = map.rows;
    this.tiles = [...map.tiles];
    this.settings = { ...map.settings };
    this.options = { blackMatter: false, destroyWalls: false, ...options };
    this.random = random;
    this.items = [-1, -1, -1, -1];
    this.effectSequence = 0;
    const starts = [0, this.columns - 1, this.columns * (this.rows - 1), this.tiles.length - 1];
    this.players = names.map((name, id) => ({
      id,
      name,
      characterId: id
        ? 'kobi'
        : isPlayableCharacter(options.characterId)
          ? options.characterId
          : DEFAULT_CHARACTER,
      position: starts[id],
      score: 0,
      turn: 0,
      effect: null,
      action: null,
      thinking: false,
      lastStatus: 'ready',
    }));
    this.status = 'ready';
    this.reason = null;
  }

  start(now) {
    this.status = 'playing';
    this.startedAt = now;
    this.nextItemsAt = now + this.settings.itemFirstMs;
    this.nextBlackMatterAt = now + this.settings.blackMatterIntervalMs;
    this.nextWallAt = now + this.settings.destroyWallIntervalMs;
    this.nextRemovalAt = Infinity;
    this.checkFinished();
  }

  isRunning() {
    return this.status === 'playing' || this.status === 'hurryup';
  }

  neighbor(index, direction) {
    const x = index % this.columns;
    const y = Math.floor(index / this.columns);
    if (direction === 0 && x > 0) return index - 1;
    if (direction === 1 && y > 0) return index - this.columns;
    if (direction === 2 && x < this.columns - 1) return index + 1;
    if (direction === 3 && y < this.rows - 1) return index + this.columns;
    return -1;
  }

  eligibleSpaces() {
    const occupied = new Set(this.items.filter((i) => i >= 0));
    for (const player of this.players) {
      // During an action its source cell remains the committed position.
      occupied.add(player.position);
      for (let direction = 0; direction < 4; direction++) {
        let index = player.position;
        for (let distance = 0; distance < 2; distance++) {
          index = this.neighbor(index, direction);
          if (index < 0) break;
          occupied.add(index);
        }
      }
    }
    return this.tiles.flatMap((tile, index) => (tile === 0 && !occupied.has(index) ? [index] : []));
  }

  choose(candidates) {
    return candidates[
      Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length))
    ];
  }

  beginAction(id, result, now) {
    if (!this.isRunning()) return;
    const player = this.players[id];
    if (player.action) throw new Error('플레이어 액션 중복');
    player.thinking = false;
    player.lastStatus = result.status;
    const effect = player.effect;
    const duration = this.settings.actionMs / (effect?.type === 0 ? 2 : 1);
    const action = {
      type: 'penalty',
      from: player.position,
      to: player.position,
      startedAt: now,
      endsAt: now + duration,
      effectId: effect?.id ?? null,
    };
    if (effect?.type === 3) {
      const spaces = this.eligibleSpaces();
      action.type = spaces.length ? 'jump' : 'jump-failed';
      if (spaces.length) action.to = this.choose(spaces);
      player.lastStatus = 'jump';
    } else if (
      result.status === 'ok' &&
      Number.isInteger(result.value) &&
      result.value >= 0 &&
      result.value <= 3
    ) {
      const target = this.neighbor(player.position, result.value);
      action.type = 'confused';
      if (target >= 0) {
        if (this.tiles[target] !== -1) {
          action.type = 'move';
          action.to = target;
        } else if (effect?.type === 1) {
          action.type = 'break';
          action.to = target;
        }
      }
    }
    player.action = action;
    return action;
  }

  completeAction(id, now) {
    const player = this.players[id];
    const action = player.action;
    if (!action || now < action.endsAt || !this.isRunning()) return false;
    const effect = player.effect?.id === action.effectId ? player.effect : null;
    if (action.type === 'break' && this.tiles[action.to] === -1) {
      this.tiles[action.to] = 0;
      if (effect?.type === 1) effect.remaining--;
    } else if (action.type === 'move' || action.type === 'jump') {
      if (this.tiles[action.to] !== -1) {
        player.position = action.to;
        const coin = this.tiles[action.to];
        if (coin > 0) {
          player.score += coin * (effect?.type === 2 ? 2 : 1);
          if (effect?.type === 2) effect.remaining--;
          this.tiles[action.to] = 0;
          player.coinBurstAt = now;
          player.coinBurstBoosted = effect?.type === 2;
        }
        const item = this.items.indexOf(action.to);
        if (item >= 0) {
          this.items[item] = -1;
          player.effect = {
            type: item,
            remaining: this.settings.itemDuration,
            id: ++this.effectSequence,
          };
        }
      }
    }
    if (effect && (effect.type === 0 || effect.type === 3)) effect.remaining--;
    if (player.effect?.id === effect?.id && effect?.remaining <= 0) player.effect = null;
    player.action = null;
    this.checkFinished();
    return true;
  }

  update(now) {
    if (!this.isRunning()) return;
    if (this.status === 'playing' && now - this.startedAt >= this.settings.runningTimeMs) {
      this.status = 'hurryup';
      this.nextRemovalAt = now;
    }
    if (now >= this.nextItemsAt) {
      this.nextItemsAt = now + this.settings.itemIntervalMs;
      if (this.items.every((index) => index === -1)) {
        const spaces = this.eligibleSpaces();
        if (spaces.length >= 4) {
          this.items = Array.from({ length: 4 }, () => {
            const chosen = this.choose(spaces);
            spaces.splice(spaces.indexOf(chosen), 1);
            return chosen;
          });
        }
      }
    }
    if (this.options.blackMatter && this.status === 'playing' && now >= this.nextBlackMatterAt) {
      this.nextBlackMatterAt = now + this.settings.blackMatterIntervalMs;
      const spaces = this.eligibleSpaces();
      for (let i = 0; i < 4 && spaces.length; i++) {
        const chosen = this.choose(spaces);
        spaces.splice(spaces.indexOf(chosen), 1);
        this.tiles[chosen] = 500;
      }
    }
    if (this.options.destroyWalls && now >= this.nextWallAt) {
      this.nextWallAt = now + this.settings.destroyWallIntervalMs;
      const walls = this.tiles.flatMap((value, index) => (value === -1 ? [index] : []));
      if (walls.length) this.tiles[this.choose(walls)] = 0;
    }
    if (this.status === 'hurryup' && now >= this.nextRemovalAt) {
      const values = this.tiles.filter((value) => value > 0);
      if (values.length) {
        const cheapest = Math.min(...values);
        const coins = this.tiles.flatMap((value, index) => (value === cheapest ? [index] : []));
        this.tiles[this.choose(coins)] = 0;
        this.nextRemovalAt = now + { 10: 300, 30: 700, 100: 1000, 200: 1300, 500: 1300 }[cheapest];
      }
      this.checkFinished();
    }
  }

  checkFinished() {
    if (!this.tiles.some((value) => value > 0)) this.finish('coins-collected');
  }
  finish(reason) {
    this.status = 'finished';
    this.reason = reason;
    for (const player of this.players) {
      player.thinking = false;
      player.action = null;
    }
  }
  snapshot(now) {
    return structuredClone({
      columns: this.columns,
      rows: this.rows,
      tiles: this.tiles,
      items: this.items,
      players: this.players,
      status: this.status,
      reason: this.reason,
      serverTime: now,
      remainingMs: Math.max(0, this.settings.runningTimeMs - (now - this.startedAt)),
    });
  }
}
