export const ALGORITHM_LANGUAGES = [
  { id: 'javascript', name: 'JavaScript', extension: '.js', mime: 'text/javascript' },
  { id: 'csharp', name: 'C#', extension: '.cs', mime: 'text/plain' },
];
export const DEFAULT_CAPABILITIES = {
  contractVersion: 1,
  languages: [
    { id: 'javascript', enabled: true, requiresLogin: false },
    {
      id: 'csharp',
      enabled: false,
      requiresLogin: true,
      reason: 'C# 베타가 활성화되지 않았습니다.',
    },
  ],
};
export function algorithmLanguage(id = 'javascript') {
  id ??= 'javascript';
  const language = ALGORITHM_LANGUAGES.find((item) => item.id === id);
  if (!language) throw new Error('지원하지 않는 알고리즘 언어입니다.');
  return language;
}
export function languageFromFilename(name) {
  const language = ALGORITHM_LANGUAGES.find((item) => name.toLowerCase().endsWith(item.extension));
  if (!language) throw new Error('.js 또는 .cs 알고리즘 파일을 선택하세요.');
  return language.id;
}
export function unavailableLanguage(capabilities, id, authenticated) {
  algorithmLanguage(id);
  const language = capabilities.languages?.find((item) => item.id === id);
  if (language?.requiresLogin && !authenticated) return 'C# 베타는 로그인 후 사용할 수 있습니다.';
  return language?.enabled === true ? '' : language?.reason || '이 언어의 지원이 비활성입니다.';
}
export function emptyAlgorithmFor(id) {
  algorithmLanguage(id);
  return id === 'csharp'
    ? `public class Player {
    public void Initialize(int myNumber, int column, int row) {
    }

    public string GetName() {
        return "새 알고리즘";
    }

    public int MoveNext(int[] map, int myPosition, int[] items) {
        return -1;
    }
}`
    : `module.exports = class Player {
  initialize(myNumber, column, row) {
  }

  getName() {
  }

  moveNext(map, myPosition, items) {
  }
};`;
}
export function diagnosticPosition(diagnostic, source) {
  const detail =
    diagnostic?.details?.find(
      (item) => Number.isInteger(item.line) && Number.isInteger(item.column),
    ) || diagnostic?.detail;
  const position = Number.isInteger(diagnostic?.line) ? diagnostic : detail;
  if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.column))
    return null;
  const lines = source.split('\n');
  if (position.line < 1 || position.line > lines.length) return null;
  const offset =
    lines.slice(0, position.line - 1).reduce((n, line) => n + line.length + 1, 0) +
    Math.max(0, Math.min(position.column - 1, lines[position.line - 1].length));
  return { line: position.line, column: position.column, offset };
}
