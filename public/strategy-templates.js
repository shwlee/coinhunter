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
