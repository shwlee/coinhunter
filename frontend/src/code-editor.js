import { EditorView, basicSetup } from 'codemirror';
import { Decoration } from '@codemirror/view';
import { EditorState, StateEffect, StateField, Compartment } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { StreamLanguage } from '@codemirror/language';
import { undo, redo, isolateHistory } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';

// Display lexer only. Roslyn and the execution preflight own C# diagnostics.
const csharpKeywords = new Set(
  'public private protected internal class void return if else for foreach while do break continue new this using namespace const static int long double bool char string true false null var in switch case default sizeof'.split(
    ' ',
  ),
);
const csharp = StreamLanguage.define({
  startState: () => ({ blockComment: false }),
  token(stream, state) {
    if (state.blockComment) {
      if (stream.skipTo('*/')) {
        stream.match('*/');
        state.blockComment = false;
      } else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.blockComment = true;
      return 'comment';
    }
    if (stream.match(/@?"(?:[^"\\]|\\.|"")*"?/) || stream.match(/'(?:[^'\\]|\\.)*'/))
      return 'string';
    if (stream.match(/\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[uUlLfFdDmM]*\b/))
      return 'number';
    const word = stream.match(/^@?[\p{L}_][\p{L}\p{N}_]*/u);
    if (word) return csharpKeywords.has(word[0]) ? 'keyword' : 'variableName';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
});

export function createCodeEditor(textarea, parent, cursor) {
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  const languageMode = new Compartment();
  let language = 'javascript';
  const languageExtensions = () => [
    language === 'csharp' ? csharp : javascript(),
    EditorView.contentAttributes.of({
      'aria-label': `${language === 'csharp' ? 'C#' : 'JavaScript'} 알고리즘 코드`,
      spellcheck: 'false',
    }),
  ];
  const markError = StateEffect.define();
  const errorLine = StateField.define({
    create: () => Decoration.none,
    update(value, transaction) {
      if (transaction.docChanged) return Decoration.none;
      for (const effect of transaction.effects)
        if (effect.is(markError))
          return effect.value === null
            ? Decoration.none
            : Decoration.set([
                Decoration.line({ class: 'cm-code-error' }).range(
                  transaction.state.doc.lineAt(effect.value).from,
                ),
              ]);
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  const extensions = [
    basicSetup,
    errorLine,
    oneDark,
    EditorView.cspNonce.of(document.querySelector('meta[name="style-nonce"]').content),
    EditorView.theme(
      {
        '&': { height: '490px', backgroundColor: '#0d1420', color: '#e4eaf2' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace', fontSize: '14px' },
        '.cm-gutters': { backgroundColor: '#192331', color: '#a4b5c9', border: 'none' },
        '.cm-content': { caretColor: '#b6f36e' },
        '.cm-code-error': { backgroundColor: '#652f3b', borderLeft: '3px solid #ff8b98' },
        '&.cm-focused .cm-cursor': { borderLeftColor: '#b6f36e' },
      },
      { dark: true },
    ),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        nativeValue.set.call(textarea, update.state.doc.toString());
        textarea.dispatchEvent(new Event('input'));
      }
      const state = update.state;
      cursor.textContent = `줄 ${state.doc.lineAt(state.selection.main.head).number} · ${new TextEncoder().encode(state.doc.toString()).length} bytes`;
    }),
  ];
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: textarea.value,
      extensions: [...extensions, languageMode.of(languageExtensions())],
    }),
  });
  Object.defineProperty(textarea, 'value', {
    get: () => view.state.doc.toString(),
    set: (value) => {
      nativeValue.set.call(textarea, value);
      view.setState(
        EditorState.create({
          doc: value,
          extensions: [...extensions, languageMode.of(languageExtensions())],
        }),
      );
    },
  });
  Object.defineProperty(textarea, 'selectionEnd', { get: () => view.state.selection.main.to });
  textarea.setSelectionRange = (from, to) => {
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    view.focus();
  };
  textarea.hidden = true;
  return {
    setLanguage(value) {
      if (!['javascript', 'csharp'].includes(value))
        throw new Error('Unsupported editor language.');
      language = value;
      view.dispatch({ effects: languageMode.reconfigure(languageExtensions()) });
    },
    showError(offset) {
      const at = Math.max(0, Math.min(offset, view.state.doc.length));
      view.dispatch({ effects: markError.of(at), selection: { anchor: at }, scrollIntoView: true });
      view.focus();
    },
    clearError: () => view.dispatch({ effects: markError.of(null) }),
    replace(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: isolateHistory.of('full'),
      });
      view.focus();
    },
    undo: () => {
      undo(view);
      view.focus();
    },
    redo: () => {
      redo(view);
      view.focus();
    },
    refresh: () => view.requestMeasure(),
  };
}
