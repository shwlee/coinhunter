import { TURN_LIMIT_MS } from './policy.js';

const labels = {
  syntax: '구문 검사',
  policy: '사용 제한 검사',
  references: '변수·함수 선언 검사',
  compile: 'JavaScript 컴파일',
  load: '코드 로딩·인스턴스 생성',
  initialize: 'initialize 실행',
  getName: 'getName 실행',
  moveNext: 'moveNext 샘플 실행',
  environment: '검사 환경 준비',
};

// Only host-created metadata and bounded primitive guest messages reach this function.
export function validationDiagnostic(error) {
  const info = error.validation || { stage: 'environment' };
  const detail = (info.detail || error.message || '상세 오류 메시지가 없습니다.').slice(0, 500);
  let hint;
  if (info.status === 'timeout')
    hint = `각 호출의 제한은 ${TURN_LIMIT_MS}ms입니다. 무한 반복과 과도한 탐색·출력을 확인하세요.`;
  else if (detail.includes('module.exports must be a class'))
    hint =
      'Player 클래스 자체를 내보내세요. class Player를 선언했다면 module.exports = Player; 로 작성하세요. module.exports = { Player }; 는 클래스가 아닌 객체입니다.';
  else if (detail.includes('Required player method'))
    hint =
      'initialize(myNumber, column, row), getName(), moveNext(map, myPosition, items)를 일반 동기 메서드로 모두 구현하세요.';
  else if (info.stage === 'getName')
    hint = "getName()이 문자열을 반환하는지 확인하세요. 예: return '내 알고리즘';";
  else if (info.status === 'invalid-result')
    hint =
      '정수 -1, 0, 1, 2, 3 중 하나를 반환하세요. 0=왼쪽, 1=위, 2=오른쪽, 3=아래, -1=이번 턴 제자리입니다.';
  else if (info.stage === 'syntax')
    hint =
      '표시된 줄·열 주변의 괄호·따옴표·문법을 확인하세요. 설명 문장과 마크다운 코드 블록 구분자는 제외하고 JavaScript 코드만 붙여 넣으세요.';
  else if (info.stage === 'references')
    hint =
      '이름의 오타나 누락된 선언을 확인하세요. 외부 라이브러리·호스트 API는 사용할 수 없습니다.';
  else if (info.stage === 'policy')
    hint =
      '동기 JavaScript와 제공되는 built-in만 사용하세요. try/catch/finally·재귀·async/await·generator·import·클래스 static은 사용할 수 없습니다.';
  else if (info.stage === 'initialize')
    hint =
      'initialize(myNumber, column, row)의 숫자 인자를 확인하세요. 이 호출에는 맵이나 현재 위치를 전달하지 않습니다.';
  else if (info.stage === 'moveNext')
    hint =
      'map은 1차원 정수 배열, myPosition은 위치 인덱스, items는 신발·망치·x2·점프 위치의 길이 4 배열입니다. debug.print로 중간 값을 확인하세요.';
  else if (info.stage === 'load' || info.stage === 'compile')
    hint = '파일 최상위 코드와 constructor, 클래스 내보내기 및 필수 메서드를 확인하세요.';
  else hint = '검사 환경을 준비하지 못했습니다. 잠시 후 다시 검사하세요.';

  return {
    stage: info.stage,
    ...(info.code ? { code: info.code } : {}),
    ...(info.profileVersion ? { profileVersion: info.profileVersion } : {}),
    ...(Number.isFinite(info.elapsedMs)
      ? { elapsedMs: info.elapsedMs, limitMs: info.limitMs }
      : {}),
    stageLabel: labels[info.stage] || '코드 검사',
    detail,
    hint,
    logs: info.logs || [],
    droppedLogs: info.droppedLogs || 0,
    ...(info.context ? { context: info.context } : {}),
    ...(Number.isInteger(error.pos) && error.loc
      ? {
          offset: error.pos,
          line: error.loc.line,
          column: error.loc.column + 1,
        }
      : {}),
  };
}
