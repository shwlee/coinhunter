import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { undo, redo, isolateHistory } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';

export function createCodeEditor(textarea, parent, cursor) {
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  const extensions = [
    basicSetup,
    javascript(),
    oneDark,
    EditorView.cspNonce.of(document.querySelector('meta[name="style-nonce"]').content),
    EditorView.contentAttributes.of({
      'aria-label': 'JavaScript 알고리즘 코드',
      spellcheck: 'false',
    }),
    EditorView.theme(
      {
        '&': { height: '490px', backgroundColor: '#0d1420', color: '#e4eaf2' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace', fontSize: '14px' },
        '.cm-gutters': { backgroundColor: '#192331', color: '#a4b5c9', border: 'none' },
        '.cm-content': { caretColor: '#b6f36e' },
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
    state: EditorState.create({ doc: textarea.value, extensions }),
  });
  Object.defineProperty(textarea, 'value', {
    get: () => view.state.doc.toString(),
    set: (value) => {
      nativeValue.set.call(textarea, value);
      view.setState(EditorState.create({ doc: value, extensions }));
    },
  });
  Object.defineProperty(textarea, 'selectionEnd', { get: () => view.state.selection.main.to });
  textarea.setSelectionRange = (from, to) => {
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    view.focus();
  };
  textarea.hidden = true;
  return {
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
