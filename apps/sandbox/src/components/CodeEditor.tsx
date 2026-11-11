// The file editor: CodeMirror 6, with the language picked by the file's extension (loaded when a
// file of that kind is first opened) and the theme following the page's (light or dark).
// Ctrl/Cmd+S saves. The parent keys this component by path: one editor state per file shown.

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, Prec } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

/** The language support for a file, by its extension; undefined for plain text. */
export async function languageFor(path: string): Promise<Extension | undefined> {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: true,
      });
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "json":
    case "jsonc":
    case "json5":
      return (await import("@codemirror/lang-json")).json();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "html":
    case "htm":
    case "svg":
      return (await import("@codemirror/lang-html")).html();
    case "md":
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    default:
      return undefined;
  }
}

const isDark = () => document.documentElement.classList.contains("dark");

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)", lineHeight: "1.6" },
  ".cm-content": { paddingBlock: "8px" },
  "&.cm-focused": { outline: "none" },
});

export function CodeEditor(props: {
  path: string;
  value: string;
  onChange(text: string): void;
  onSave(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The latest callbacks, for the editor's listeners (made once per path).
  const callbacks = useRef(props);
  callbacks.current = props;

  // biome-ignore lint/correctness/useExhaustiveDependencies: one editor per path; `value` seeds it.
  useEffect(() => {
    if (!host.current) return;
    const language = new Compartment();
    const theme = new Compartment();
    const themeOf = async () =>
      isDark() ? (await import("@codemirror/theme-one-dark")).oneDark : [];
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  callbacks.current.onSave();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) callbacks.current.onChange(u.state.doc.toString());
          }),
          baseTheme,
          language.of([]),
          theme.of([]),
        ],
      }),
    });
    view.current = v;
    let alive = true;
    void languageFor(props.path).then((ext) => {
      if (alive && ext) v.dispatch({ effects: language.reconfigure(ext) });
    });
    const applyTheme = () =>
      void themeOf().then((t) => alive && v.dispatch({ effects: theme.reconfigure(t) }));
    applyTheme();
    // The page's theme toggles a class on <html>.
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      alive = false;
      observer.disconnect();
      v.destroy();
      view.current = null;
    };
  }, [props.path]);

  // The file changed under the editor (on disk, with no unsaved edits here): show the new text.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== props.value)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
  }, [props.value]);

  return <div ref={host} className="h-full min-h-0" data-testid="code-editor" />;
}
