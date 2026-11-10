// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the test inputs are JavaScript source text
import { describe, expect, it } from "vitest";
import { rewriteModuleSpecifiers } from "../src/project/module-specifiers.js";

// The browser Worker Loader rewrites a loaded module's imports (cloudflare:workers → the shim,
// relative paths → sibling Blob URLs); only the module's own imports, never the same words in
// its strings, templates, comments or regular expressions.
const mark = (code: string) =>
  rewriteModuleSpecifiers(code, (spec) =>
    spec === "cloudflare:workers" || spec.startsWith("./") ? `blob:${spec}` : undefined,
  );

describe("rewriteModuleSpecifiers", () => {
  it("rewrites every form of import and re-export", () => {
    const code = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "import a, { b as c } from './a.js';",
      "import * as ns from'./ns.js';",
      'import "./side.js";',
      'export { x } from "./x.js";',
      "export * from './all.js';",
      "const m = await import(\"./lazy.js\"); const n = import( /* c */ './lazy2.js' );",
      'import other from "pkg";',
    ].join("\n");
    const out = mark(code);
    for (const s of [
      "cloudflare:workers",
      "./a.js",
      "./ns.js",
      "./side.js",
      "./x.js",
      "./all.js",
      "./lazy.js",
      "./lazy2.js",
    ])
      expect(out).toContain(`"blob:${s}"`);
    expect(out).toContain('from "pkg"');
  });

  it("leaves the same words in strings, templates, comments and regexes alone", () => {
    const code = [
      'const t = (spec) => `\\nimport { WorkerEntrypoint } from "cloudflare:workers";\\nimport x from "${spec}";`;',
      "const s = 'import y from \"./y.js\"';",
      'const d = "from \\"./z.js\\"";',
      '// import z from "./z.js"',
      '/* export * from "./w.js" */',
      'const r = /from "\\.\\/r\\.js"/g;',
      'const o = { from: "./not.js" }; o.from; o.import("./member.js");',
    ].join("\n");
    expect(mark(code)).toBe(code);
  });

  it("finds imports inside template expressions, and divisions are not regexes", () => {
    const code =
      'const html = `<p>${await import("./in-expr.js").then((m) => m.v)}</p>`;\n' +
      'const half = a / 2; import q from "./after-division.js"; const b = c / d / e;';
    const out = mark(code);
    expect(out).toContain('"blob:./in-expr.js"');
    expect(out).toContain('"blob:./after-division.js"');
    expect(out).toContain("<p>${");
  });

  it("tells regexes from divisions where a lexer must (review cases)", () => {
    const after = 'import("./p.js")';
    const cases = [
      "export default /[`]/;\n", // a regex after `default`
      "class A extends /x/.constructor {}\n",
      "if (x) /`/.test(y);\n", // a regex after the head of if
      "while (a) /`/.test(b);\n",
      "const v = a++ / 2; const w = b / 3;\n", // postfix ++ then a division
      "const z = a++ / 2\n", // a division over a line end
      "#!/usr/bin/env node --x=`\n", // a hashbang with a backtick
      'const s = "a\\\r\nb";\n', // a CRLF line continuation in a string
    ];
    for (const c of cases) expect(mark(c + after), JSON.stringify(c)).toContain('"blob:./p.js"');
  });

  it("dynamic imports: whole literals only, templates without substitutions", () => {
    expect(mark('import("./locales/" + lang + ".js")')).toBe('import("./locales/" + lang + ".js")');
    expect(mark("import(`./t.js`)")).toBe('import("blob:./t.js")');
    expect(mark("import(`./${x}.js`)")).toBe("import(`./${x}.js`)");
    expect(mark('import("./o.js", { with: { type: "json" } })')).toContain('"blob:./o.js"');
  });

  it("decodes simple escapes; `from` as a variable is not an import", () => {
    expect(mark('import a from "./\\u0061.js";')).toBe('import a from "blob:./a.js";');
    const asi = 'let from = 1\nfrom\n"./fp.js"';
    expect(mark(asi)).toBe(asi);
  });

  it("keeps code without imports byte for byte", () => {
    const code = "export default class { fetch() { return new Response(`ok ${1 + 1}`); } }";
    expect(mark(code)).toBe(code);
  });
});
