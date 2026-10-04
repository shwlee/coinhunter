export const STRATEGY_TEMPLATES = [
  { id: 'nearestCoin', label: '근처 코인', description: '이동 거리가 짧은 코인을 우선합니다.' },
  { id: 'valuableCoin', label: '고액 코인', description: '점수가 높은 코인을 우선합니다.' },
  {
    id: 'coinCluster',
    label: '코인 밀집',
    description: '주변 두 칸 안에 코인이 많이 모인 곳을 우선합니다.',
  },
  { id: 'shoes', label: '신발 획득', description: '이동 속도를 높이는 신발을 우선합니다.' },
  { id: 'hammer', label: '망치 획득', description: '벽을 부수는 망치를 우선합니다.' },
  {
    id: 'double',
    label: 'x2 획득',
    description: '코인 점수를 두 배로 만드는 아이템을 우선합니다.',
  },
  { id: 'jump', label: '점프 획득', description: '무작위 위치로 이동하는 아이템을 우선합니다.' },
  { id: 'avoidShoes', label: '신발 회피', description: '신발 칸을 밟지 않고 경로를 탐색합니다.' },
  { id: 'avoidHammer', label: '망치 회피', description: '망치 칸을 밟지 않고 경로를 탐색합니다.' },
  {
    id: 'avoidDouble',
    label: 'x2 회피',
    description: '코인 두 배 아이템 칸을 밟지 않고 경로를 탐색합니다.',
  },
  {
    id: 'avoidJump',
    label: '점프 회피',
    description: '랜덤점프 아이템 칸을 밟지 않고 경로를 탐색합니다.',
  },
];
export const PRIORITY_WEIGHTS = [5, 3, 1];

export function buildTemplateSource(priorities) {
  if (!Array.isArray(priorities) || priorities.length < 1 || priorities.length > 3)
    throw new Error('전략 템플릿을 1~3개 선택하세요.');
  const weights = Object.fromEntries(STRATEGY_TEMPLATES.map(({ id }) => [id, 0]));
  for (const [index, id] of priorities.entries()) {
    if (!STRATEGY_TEMPLATES.some((template) => template.id === id) || weights[id])
      throw new Error('전략 템플릿의 우선순위를 다시 확인하세요.');
    weights[id] = PRIORITY_WEIGHTS[index];
  }
  const summary = priorities
    .map(
      (id, index) =>
        `${index + 1}순위 ${STRATEGY_TEMPLATES.find((item) => item.id === id).label} (가중치 ${PRIORITY_WEIGHTS[index]})`,
    )
    .join(' · ');
  return `// 선택한 전략과 가중치: ${summary}
// 각 턴에 도달 가능한 코인과 아이템을 비교해 가장 높은 점수의 목표로 이동합니다.
module.exports = class Player {
  initialize(myNumber, column, row) {
    this.number = myNumber;
    this.column = column;
    this.row = row;
  }

  getName() {
    return '우선순위 전략 ' + (this.number + 1);
  }

  moveNext(map, myPosition, items) {
    const weights = ${JSON.stringify(weights)};
    const itemWeights = [weights.shoes, weights.hammer, weights.double, weights.jump];
    const avoidedItems = [weights.avoidShoes, weights.avoidHammer, weights.avoidDouble, weights.avoidJump];
    const blockedItems = new Set(items.filter((position, index) => avoidedItems[index] && position >= 0));
    const offsets = [-1, -this.column, 1, this.column];
    const visited = new Set([myPosition]);
    const queue = [{ position: myPosition, first: -1, distance: 0 }];
    let head = 0;
    let bestDirection = -1;
    let bestScore = -Infinity;
    let bestDistance = Infinity;

    while (head < queue.length) {
      const current = queue[head++];
      for (let direction = 0; direction < 4; direction++) {
        if (direction === 0 && current.position % this.column === 0) continue;
        if (direction === 2 && current.position % this.column === this.column - 1) continue;
        const next = current.position + offsets[direction];
        if (next < 0 || next >= map.length || map[next] === -1 || blockedItems.has(next) || visited.has(next)) continue;
        visited.add(next);
        queue.push({
          position: next,
          first: current.first === -1 ? direction : current.first,
          distance: current.distance + 1,
        });
      }
    }
    for (const current of queue) {
      if (current.distance === 0) continue;
      const coin = map[current.position];
      if (coin > 0) {
        const x = current.position % this.column;
        const y = Math.floor(current.position / this.column);
        let nearbyCoins = 0;
        if (weights.coinCluster) {
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              if (Math.abs(dx) + Math.abs(dy) > 2 || x + dx < 0 || x + dx >= this.column || y + dy < 0 || y + dy >= this.row) continue;
              const position = (y + dy) * this.column + x + dx;
              if (visited.has(position) && map[position] > 0) nearbyCoins++;
            }
          }
        }
        const score = 0.1 / (current.distance + 1) +
          weights.nearestCoin * 200 / (current.distance + 1) +
          weights.valuableCoin * coin / 5 +
          weights.coinCluster * 100 * nearbyCoins / (current.distance + 1);
        if (score > bestScore || (score === bestScore && current.distance < bestDistance)) {
          bestScore = score;
          bestDistance = current.distance;
          bestDirection = current.first;
        }
      }
      for (let index = 0; index < 4; index++) {
        const weight = itemWeights[index];
        if (!weight || items[index] !== current.position) continue;
        const score = weight * 200 / (current.distance + 1);
        if (score > bestScore || (score === bestScore && current.distance < bestDistance)) {
          bestScore = score;
          bestDistance = current.distance;
          bestDirection = current.first;
        }
      }
    }
    return bestDirection;
  }
};`;
}
