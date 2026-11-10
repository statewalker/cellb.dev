/**
 * Rewrites the module specifiers of an ES module's own imports: `import … from "x"`,
 * `import "x"`, `export … from "x"` and `import("x")`, and only those. The text is scanned as
 * code, so the same words inside a string, a template literal's text, a comment or a regular
 * expression are left alone (a regex over the whole text would rewrite them, e.g. a code
 * generator's template that contains `from "cloudflare:workers"`).
 *
 * A small scanner rather than a parser: the browser module loader runs in every isolate and
 * shard worker, where a full JS parser would add its whole size.
 *
 * `resolve(spec)` returns the replacement specifier, or undefined to keep it.
 */
export function rewriteModuleSpecifiers(
  code: string,
  resolve: (spec: string) => string | undefined,
): string {
  const edits: { start: number; end: number; text: string }[] = [];
  const n = code.length;
  let i = 0;
  // The last significant token, to tell a regular expression from a division.
  let prev = "";
  // Template literals being scanned and, for each `${`, the brace depth it opened at.
  const braces: number[] = [];
  let depth = 0;

  const isIdStart = (c: string) => /[A-Za-z_$\u0080-￿]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);
  const REGEX_AFTER_WORD = new Set([
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "throw",
    "case",
    "do",
    "else",
    "yield",
    "await",
  ]);
  const regexAllowed = () =>
    prev === "" || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || REGEX_AFTER_WORD.has(prev);

  const skipSpace = (from: number): number => {
    let j = from;
    for (;;) {
      while (j < n && /\s/.test(code[j] as string)) j++;
      if (code.startsWith("//", j)) {
        while (j < n && code[j] !== "\n") j++;
      } else if (code.startsWith("/*", j)) {
        const end = code.indexOf("*/", j + 2);
        j = end < 0 ? n : end + 2;
      } else return j;
    }
  };
  /** The end (exclusive) of the quoted string starting at `from`. */
  const stringEnd = (from: number): number => {
    const q = code[from];
    let j = from + 1;
    while (j < n && code[j] !== q) {
      if (code[j] === "\\") j++;
      else if (code[j] === "\n") break;
      j++;
    }
    return j + 1;
  };
  /** A string literal at `from` (after spaces and comments): its range, or undefined. */
  const stringAt = (from: number) => {
    const j = skipSpace(from);
    const q = code[j];
    if (q !== '"' && q !== "'") return undefined;
    return { start: j, end: stringEnd(j) };
  };
  const take = (s: { start: number; end: number } | undefined) => {
    if (!s) return;
    // The text between the quotes (no eval: isolates and CSP pages refuse it). A specifier
    // with an escape in it is left as it is.
    const spec = code.slice(s.start + 1, s.end - 1);
    if (spec.includes("\\")) return;
    const to = resolve(spec);
    if (to !== undefined) edits.push({ start: s.start, end: s.end, text: JSON.stringify(to) });
  };
  /** Scans template text from `from` (just after a backtick or a `}` closing `${…}`). */
  const templateText = (from: number): number => {
    let j = from;
    while (j < n) {
      const c = code[j];
      if (c === "\\") j += 2;
      else if (c === "`") return j + 1;
      else if (c === "$" && code[j + 1] === "{") {
        braces.push(depth);
        depth++;
        return j + 2;
      } else j++;
    }
    return n;
  };

  while (i < n) {
    const c = code[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (code.startsWith("//", i) || code.startsWith("/*", i)) {
      i = skipSpace(i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = stringEnd(i);
      prev = "str";
      continue;
    }
    if (c === "`") {
      i = templateText(i + 1);
      prev = "str";
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && code[j] !== "\n") {
        const d = code[j];
        if (d === "\\") j++;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < n && isId(code[j] as string)) j++;
      i = j;
      prev = "re";
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isId(code[j] as string)) j++;
      const word = code.slice(i, j);
      const member = prev === ".";
      if (!member && word === "from") take(stringAt(j));
      else if (!member && word === "import") {
        const k = skipSpace(j);
        if (code[k] === "(") take(stringAt(k + 1));
        else take(stringAt(j)); // a side-effect import of a bare string
      }
      i = j;
      prev = word;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (braces.length && braces[braces.length - 1] === depth) {
        braces.pop();
        i = templateText(i + 1);
        prev = "str";
        continue;
      }
    }
    prev = c;
    i++;
  }

  let out = "";
  let at = 0;
  for (const e of edits) {
    out += code.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + code.slice(at);
}
