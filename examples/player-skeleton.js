// 필수 구조를 보여주는 골격입니다. moveNext에 전략을 구현하세요.
module.exports = class Player {
  initialize(myNumber, column, row) {
    this.number = myNumber;
    this.column = column;
    this.row = row;
  }

  getName() {
    return '새 알고리즘';
  }

  moveNext(map, myPosition, items) {
    return -1;
  }
};
