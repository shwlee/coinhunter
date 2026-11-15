// 망치 연출 확인용. 더미 0명, 랜덤 벽 파괴 OFF로 실행하는 것을 권장합니다.
// 망치 출현 전에는 기다리고, 획득 후 벽을 찾아 부숩니다.
// 장착 효과는 API에 없으므로 이전 이동 목표와 다음 턴의 맵 변화로 추정합니다.
module.exports = class HammerTest {
  initialize(myNumber, column, row) {
    this.column = column;
    this.row = row;
    this.hammer = false;
    this.pickup = -1;
    this.breakTarget = -1;
    this.broken = 0;
    this.message = '';
  }
  getName() {
    return '망치 벽 파괴 테스트';
  }
  log(message) {
    if (message !== this.message) {
      debug.print(message);
      this.message = message;
    }
  }
  neighbor(position, direction) {
    const x = position % this.column;
    const y = Math.floor(position / this.column);
    if (direction === 0) return x > 0 ? position - 1 : -1;
    if (direction === 1) return y > 0 ? position - this.column : -1;
    if (direction === 2) return x + 1 < this.column ? position + 1 : -1;
    return y + 1 < this.row ? position + this.column : -1;
  }
  interior(position) {
    const x = position % this.column,
      y = Math.floor(position / this.column);
    return x > 0 && x < this.column - 1 && y > 0 && y < this.row - 1;
  }
  moveNext(map, myPosition, items) {
    if (this.pickup === myPosition && items[1] === -1) {
      this.hammer = true;
      this.broken = 0;
      this.log('망치 획득 추정! 다른 아이템을 피하며 벽으로 이동합니다.');
    }
    this.pickup = -1;
    if (this.breakTarget >= 0) {
      if (map[this.breakTarget] !== -1) {
        this.broken++;
        this.log('벽 파괴 확인: ' + this.broken + '개 / 위치 ' + this.breakTarget);
      } else {
        this.hammer = false;
        this.log(
          '벽이 남아 있습니다. 망치 소진 또는 미획득 상태입니다. 새 경기로 다시 테스트하세요.',
        );
      }
      this.breakTarget = -1;
    }
    if (!this.hammer && items[1] < 0) {
      if (!this.broken)
        this.log('망치 출현 대기 중 — 제자리 턴은 테스트를 위한 의도된 동작입니다.');
      return -1;
    }
    const queue = [{ position: myPosition, first: -1 }];
    const visited = new Set([myPosition]);
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      if (!this.hammer && current.position === items[1]) {
        const next = this.neighbor(myPosition, current.first);
        if (next === items[1]) this.pickup = next;
        this.log('망치로 이동: 위치 ' + items[1]);
        return current.first;
      }
      for (let direction = 0; direction < 4; direction++) {
        const next = this.neighbor(current.position, direction);
        if (next < 0) continue;
        if (this.hammer && map[next] === -1 && this.interior(next)) {
          if (current.first !== -1) {
            this.log('벽으로 접근: 위치 ' + next);
            return current.first;
          }
          this.breakTarget = next;
          this.log('벽 파괴 시도: 위치 ' + next + ' / 방향 ' + direction);
          return direction;
        }
        // 다른 아이템을 먹으면 망치 효과가 교체되므로 우회합니다.
        if (
          map[next] === -1 ||
          visited.has(next) ||
          items.some((position, type) => position === next && type !== 1)
        )
          continue;
        visited.add(next);
        queue.push({ position: next, first: current.first === -1 ? direction : current.first });
      }
    }
    this.log(this.hammer ? '접근 가능한 내부 벽이 없습니다.' : '망치까지 안전한 경로가 없습니다.');
    return -1;
  }
};
