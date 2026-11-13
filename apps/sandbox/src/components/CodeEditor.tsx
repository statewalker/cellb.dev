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
import { Compartment, EditorState, type Extension, Prec, StateEffect } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import type { Remote } from "comlink";
import { useEffect, useRef } from "react";
import type { TsWorker } from "@/sandbox/ts.worker";

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

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i;
// Codes not worth a red line while types are still arriving: a module whose types are not there
// (yet: automatic type acquisition fetches them), an untyped module.
const IGNORED = [2307, 7016];

/** The open project, for the language service: its scripts, and where its two runtimes are. */
export interface Project {
  /** Changes when another project is open (the service starts afresh). */
  key: string;
  files(): [string, string][];
  /** The client's folder ("/" for a site at the root), if any. */
  clientRoot?: string;
  /** The folder of the Wrangler `main`, if the project has a server. */
  serverRoot?: string;
}

/** Types fetched for the imports have arrived: the open file is linted again. */
const typesArrived = StateEffect.define<null>();

/** The TypeScript language service (ts.worker.ts): one for the page, started with the first script. */
let tsWorker: Promise<Remote<TsWorker>> | undefined;
function languageService() {
  tsWorker ??= (async () => {
    const Comlink = await import("comlink");
    // A worker's script can be refused (a cross-origin isolated page takes only scripts sent with
    // its headers, which the ServiceWorker adds; a request that misses it is blocked): one that
    // fails, or does not answer, is replaced.
    for (let attempt = 1; ; attempt++) {
      const inner = new Worker(new URL("../sandbox/ts.worker.ts", import.meta.url), {
        type: "module",
      });
      const worker = Comlink.wrap<TsWorker>(inner);
      try {
        await new Promise<void>((resolve, reject) => {
          inner.addEventListener("error", (e) => reject(new Error(e.message || "it did not load")));
          setTimeout(() => reject(new Error("no answer in 60 s")), 60_000);
          worker.initialize().then(resolve, reject);
        });
        return worker;
      } catch (err) {
        inner.terminate();
        if (attempt >= 3) throw err;
        console.warn(
          `the TypeScript language service: ${(err as Error).message}; starting it again`,
        );
      }
    }
  })();
  tsWorker.catch(() => {
    tsWorker = undefined;
  });
  return tsWorker;
}

/** Lint, completion, hover and go-on-typing sync for a script file, from the language service. */
async function typescriptFor(path: string, project?: Project) {
  const [cm, lint, worker] = await Promise.all([
    import("@valtown/codemirror-ts"),
    import("@codemirror/lint"),
    languageService(),
  ]);
  // The other files first: imports and their types resolve against the project.
  if (project)
    await worker.syncProject(project.files(), {
      key: project.key,
      clientRoot: project.clientRoot,
      serverRoot: project.serverRoot,
    });
  return {
    worker,
    extension: [
      cm.tsFacetWorker.of({ worker: worker as never, path }),
      cm.tsSyncWorker(),
      // The linter, here rather than tsLinterWorker's: it also runs again when types arrive
      // (forceLinting only hurries a lint already due after an edit).
      lint.linter(() => worker.getLints({ path, diagnosticCodesToIgnore: IGNORED }), {
        needsRefresh: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(typesArrived))),
      }),
      lint.lintGutter(),
      // Ctrl/Cmd+Shift+M: the list of the file's problems; F8: the next one.
      keymap.of(lint.lintKeymap),
      autocompletion({ override: [cm.tsAutocompleteWorker()] }),
      cm.tsHoverWorker(),
    ] as Extension,
  };
}

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
  /** The project's scripts and runtimes: types, errors and completion across files. */
  project?: Project;
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
    const types = new Compartment();
    const completion = new Compartment();
    let unlisten = () => {};
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
          completion.of(autocompletion()),
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
          types.of([]),
        ],
      }),
    });
    view.current = v;
    let alive = true;
    void languageFor(props.path).then((ext) => {
      if (alive && ext) v.dispatch({ effects: language.reconfigure(ext) });
    });
    // TypeScript and JavaScript files get the language service (its completion replaces the
    // plain one). The editor works without it: it loads in the background, and a failure to
    // load (no network for the libraries) leaves the editor as it was.
    if (SCRIPT.test(props.path))
      void typescriptFor(`/${props.path.replace(/^\/+/, "")}`, callbacks.current.project)
        .then(async ({ worker, extension }) => {
          if (!alive) return;
          v.dispatch({ effects: [types.reconfigure(extension), completion.reconfigure([])] });
          // Types fetched for the imports arrive later: lint again then.
          const Comlink = await import("comlink");
          const listener = await worker.onTypes(
            Comlink.proxy(() => {
              if (alive) v.dispatch({ effects: typesArrived.of(null) });
            }),
          );
          // Unregistered with the editor (a file switch, a project closed).
          if (alive) unlisten = () => void worker.offTypes(listener);
          else void worker.offTypes(listener);
        })
        .catch((err) => console.warn("the TypeScript language service:", err));
    const applyTheme = () =>
      void themeOf().then((t) => alive && v.dispatch({ effects: theme.reconfigure(t) }));
    applyTheme();
    // The page's theme toggles a class on <html>.
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      alive = false;
      unlisten();
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
