// 단일 파일, 동기 알고리즘. 반환: 0=왼쪽, 1=위, 2=오른쪽, 3=아래, -1=제자리.
module.exports = class Player {
  initialize(myNumber, column, row) {
    this.number = myNumber;
    this.column = column;
    this.row = row;
    this.turn = 0;
  }
  getName() {
    return '길찾기 ' + (this.number + 1);
  }
  moveNext(map, myPosition, items) {
    this.turn++;
    const visited = new Set([myPosition]);
    const queue = [{ position: myPosition, first: -1 }];
    let head = 0;
    const offsets = [-1, -this.column, 1, this.column];
    while (head < queue.length) {
      const { position, first } = queue[head++];
      if (position !== myPosition && (map[position] > 0 || items.includes(position))) {
        if (this.turn % 10 === 1) debug.print('목표', position, '방향', first);
        return first;
      }
      for (let direction = 0; direction < 4; direction++) {
        if (direction === 0 && position % this.column === 0) continue;
        if (direction === 2 && position % this.column === this.column - 1) continue;
        const next = position + offsets[direction];
        if (next < 0 || next >= map.length || map[next] === -1 || visited.has(next)) continue;
        visited.add(next);
        queue.push({ position: next, first: first === -1 ? direction : first });
      }
    }
    return -1;
  }
};
