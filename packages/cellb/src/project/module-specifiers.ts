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
 * `resolve(spec)` returns the replacement specifier, or undefined to keep it. A dynamic import
 * is rewritten only when its argument is one literal (a string, or a template without `${`).
 */
export function rewriteModuleSpecifiers(
  code: string,
  resolve: (spec: string) => string | undefined,
): string {
  const edits: { start: number; end: number; text: string }[] = [];
  const n = code.length;
  // The last significant token, to tell a regular expression from a division: a punctuator
  // (`(`, `=`, …), "id" (an identifier or a keyword not in REGEX_AFTER_WORD), "num", "str",
  // "re", "++"/"--", or ")" / "]" / "}" (a division follows, unless the `)` closed the head of
  // `if`/`while`/`for`/`with`, which a statement, and so a regex, may follow).
  let prev = "";
  let prevWord = ""; // the identifier `prev` stands for, when it is "id"
  // Template literals being scanned: for each `${`, the brace depth it opened at.
  const templates: number[] = [];
  let depth = 0;
  // For each open `(`: whether it is the head of if/while/for/with.
  const parens: boolean[] = [];

  const WORD_START = new Uint8Array(128);
  const WORD = new Uint8Array(128);
  for (let c = 0; c < 128; c++) {
    const ch = String.fromCharCode(c);
    WORD_START[c] = /[A-Za-z_$]/.test(ch) ? 1 : 0;
    WORD[c] = /[A-Za-z0-9_$]/.test(ch) ? 1 : 0;
  }
  const isIdStart = (c: number) => (c < 128 ? WORD_START[c] === 1 : c > 0xa0 || c === 0x5c);
  const isId = (c: number) => (c < 128 ? WORD[c] === 1 : c > 0xa0 || c === 0x5c);
  const isSpace = (c: number) =>
    c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029;

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
    "default",
    "extends",
  ]);
  const HEADS = new Set(["if", "while", "for", "with"]);
  const regexAllowed = () => {
    if (prev === "id") return REGEX_AFTER_WORD.has(prevWord);
    if (prev === "" || prev === "head)") return true;
    return /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev);
  };

  const skipSpace = (from: number): number => {
    let j = from;
    for (;;) {
      while (j < n && isSpace(code.charCodeAt(j))) j++;
      if (code.startsWith("//", j)) {
        while (j < n && code[j] !== "\n" && code[j] !== "\r") j++;
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
      if (code[j] === "\\") {
        j++;
        if (code[j] === "\r" && code[j + 1] === "\n") j++; // a CRLF line continuation
      } else if (code[j] === "\n" || code[j] === "\r") break;
      j++;
    }
    return j + 1;
  };
  /** The string's value, decoding the simple escapes; undefined for anything else. */
  const decode = (raw: string): string | undefined => {
    let out = "";
    for (let j = 0; j < raw.length; j++) {
      const c = raw[j] as string;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = raw[++j];
      const hex = (len: number) => {
        const h = raw.slice(j + 1, j + 1 + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(h)) return undefined;
        j += len;
        return String.fromCharCode(Number.parseInt(h, 16));
      };
      const d =
        e === "x"
          ? hex(2)
          : e === "u"
            ? hex(4)
            : e === "'" || e === '"' || e === "\\" || e === "/"
              ? e
              : undefined;
      if (d === undefined) return undefined;
      out += d;
    }
    return out;
  };
  /** A string literal (or, for import(), a template without `${`) at `from`, after spaces. */
  const literalAt = (from: number, template: boolean) => {
    const j = skipSpace(from);
    const q = code[j];
    if (q === '"' || q === "'") return { start: j, end: stringEnd(j) };
    if (template && q === "`") {
      const end = code.indexOf("`", j + 1);
      if (end < 0) return undefined;
      const raw = code.slice(j + 1, end);
      if (raw.includes("${") || raw.includes("\\")) return undefined;
      return { start: j, end: end + 1 };
    }
    return undefined;
  };
  const take = (s: { start: number; end: number } | undefined) => {
    if (!s) return;
    const spec = decode(code.slice(s.start + 1, s.end - 1));
    if (spec === undefined) return;
    const to = resolve(spec);
    if (to !== undefined) edits.push({ start: s.start, end: s.end, text: JSON.stringify(to) });
  };
  /** Scans template text from `from` (just after a backtick, or a `}` closing `${…}`). */
  const templateText = (from: number): number => {
    let j = from;
    while (j < n) {
      const c = code[j];
      if (c === "\\") j += 2;
      else if (c === "`") return j + 1;
      else if (c === "$" && code[j + 1] === "{") {
        templates.push(depth);
        depth++;
        return j + 2;
      } else j++;
    }
    return n;
  };

  let i = 0;
  if (code.startsWith("#!")) while (i < n && code[i] !== "\n") i++; // a hashbang line
  while (i < n) {
    const cc = code.charCodeAt(i);
    const c = code[i] as string;
    if (isSpace(cc)) {
      i++;
      continue;
    }
    if (c === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
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
      let closed = false;
      while (j < n && code[j] !== "\n" && code[j] !== "\r") {
        const d = code[j];
        if (d === "\\") j++;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        j++;
        while (j < n && isId(code.charCodeAt(j))) j++; // flags
      }
      i = j;
      prev = "re";
      continue;
    }
    if (isIdStart(cc)) {
      let j = i + 1;
      while (j < n && isId(code.charCodeAt(j))) j++;
      const word = code.slice(i, j);
      const member = prev === "." || prev === "?.";
      if (!member && word === "from" && (prev === "}" || prev === "*" || prev === "id"))
        take(literalAt(j, false));
      else if (!member && word === "import") {
        const k = skipSpace(j);
        if (code[k] === "(") {
          // import(x): only a whole literal argument (not "./a/" + b).
          const s = literalAt(k + 1, true);
          const after = s && code[skipSpace(s.end)];
          if (after === ")" || after === ",") take(s);
        } else take(literalAt(j, false)); // a side-effect import of a bare string
      }
      i = j;
      prev = "id";
      prevWord = word;
      continue;
    }
    if (cc >= 48 && cc <= 57) {
      let j = i + 1;
      while (j < n && (isId(code.charCodeAt(j)) || code[j] === ".")) j++;
      i = j;
      prev = "num";
      continue;
    }
    if ((c === "+" || c === "-") && code[i + 1] === c) {
      // `a++ / b` divides; `x = ++a` has the operator before an operand, which then sets prev.
      prev = c + c;
      i += 2;
      continue;
    }
    if (c === "?" && code[i + 1] === "." && !/[0-9]/.test(code[i + 2] ?? "")) {
      prev = "?.";
      i += 2;
      continue;
    }
    if (c === "(") {
      parens.push(prev === "id" && HEADS.has(prevWord));
      prev = "(";
      i++;
      continue;
    }
    if (c === ")") {
      prev = parens.pop() ? "head)" : ")";
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (templates.length && templates[templates.length - 1] === depth) {
        templates.pop();
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
