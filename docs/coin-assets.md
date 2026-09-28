# 코인 에셋과 애니메이션

원본: `D:\proj\unity\CoinChallenger\Assets\Sprites\Coins`.
사용자가 제공한 기존 게임의 PNG를 수정 없이 `public/assets/coins/`에 복사했다. 런타임은 Unity 폴더를 참조하지 않는다.

| 점수 | 이미지 | 프레임 |
| --- | --- | --- |
| 10 | Coins.png / Cooper | 4 |
| 30 | Coins.png / Silver | 4 |
| 100 | Coins.png / Gold | 4 |
| 200 | Diamond.png | 4 |
| 500 | blackmatter.png | 5 |
| 블랙매터 출현 | appear_blackmatter.png | 6 |

`frames.json`은 Unity `.meta`의 잘라내기 영역을 사용한다. 원본은 왼쪽 아래 원점이므로 웹 Canvas의 왼쪽 위 원점으로 y 좌표를 변환했다. 회전 프레임의 폭이 8/6/4픽셀로 달라지므로 확대 비율을 유지한 채 중앙 정렬한다. 픽셀 아트가 흐려지지 않도록 스프라이트를 그릴 때만 보간을 끈다.

`public/coin-renderer.js`에서 이미지 로딩과 렌더링을 담당한다. 코인과 다이아몬드는 약 167ms마다, 블랙매터는 100ms마다 프레임을 바꾼다. Unity 클립의 전체 타이밍을 그대로 재생하는 방식은 아니며 웹용 반복 연출로 조정했다. 약한 부유와 빛 효과를 더하고, 코인마다 위상을 달리해 동시에 뒤집히는 현상을 피한다. 블랙매터 출현은 서버가 보내는 `coinAppearances`의 생성 시각을 기준으로 한 번 재생한다.

획득 시 플레이어 상태의 `coinBurstAt`, `coinBurstValue`, `coinBurstPosition`, `coinBurstBoosted`로 650ms 동안 반짝임과 획득 점수를 표시한다. x2의 마지막 사용에서도 두 배 점수를 표시하고 입자를 늘린다. 마지막으로 획득한 코인 한 개의 연출을 보관하므로 짧은 간격의 연속 획득은 최신 연출로 교체된다. 이동·점수·아이템 규칙은 바꾸지 않았다.

OS의 동작 줄이기 설정을 사용하면 반복 프레임과 부유·입자 이동을 멈추고 점수 표시를 유지한다. 브라우저 검증에서 다섯 종류의 이미지 표시, 프레임 변화, 출현 및 획득 효과를 확인한다.
