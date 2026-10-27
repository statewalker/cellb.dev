/**
 * `async`/`await` lowered to generators, for the modules an in-browser site serves (what
 * esbuild's `supported: { "async-await": false }` does for `bundleWorkerForBrowser`): each `await`
 * then resumes through `Promise.prototype.then`, which cellb's `node:async_hooks` polyfill makes
 * carry the AsyncLocalStorage stores (see `installAsyncContext`).
 *
 *   async function f(a) { BODY }    → function f(a) { return __cellbAsync(function* () { BODY }.apply(this, arguments)); }
 *   async (a) => EXPR               → (a) => __cellbAsync(function* () { return EXPR; }.call(this))
 *   await X                         → (yield X)
 *   for await (L of R) BODY         → a loop over `yield it.next()`, closing the iterator on exit
 *
 * Left as they are: async generators (their awaits stay native, as their bodies), functions that
 * use `super` or `new.target` (a generator nested in them cannot), and top-level await. Their
 * awaits resume in the polyfill's root frame: they see no store rather than another event's.
 */
import { type Node, parse } from "acorn";

// biome-ignore lint/suspicious/noExplicitAny: walking acorn's ESTree nodes by their properties
type AnyNode = Node & Record<string, any>;

const ASYNC_RUNNER =
  'function __cellbAsync(g){return new Promise(function(res,rej){function step(m,v){var r;try{r=g[m](v)}catch(e){rej(e);return}if(r.done)res(r.value);else Promise.resolve(r.value).then(function(x){step("next",x)},function(e){step("throw",e)})}step("next")})}';
const ASYNC_ITERATOR =
  "function __cellbIter(o){var m=o[Symbol.asyncIterator];if(m)return m.call(o);var it=o[Symbol.iterator](),w=function(r){return Promise.resolve(r.value).then(function(x){return{value:x,done:r.done}})};return{next:function(v){return w(it.next(v))},return:it.return&&function(v){return w(it.return(v))}}}";

const isFunction = (n: AnyNode) =>
  n.type === "FunctionDeclaration" ||
  n.type === "FunctionExpression" ||
  n.type === "ArrowFunctionExpression";

function childrenOf(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const key in node) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range")
      continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === "string") out.push(c);
    } else if (v && typeof v.type === "string") out.push(v);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** `super` or `new.target` in `fn`'s own body (not in the functions it declares). */
function usesSuperOrNewTarget(fn: AnyNode): boolean {
  let found = false;
  const visit = (n: AnyNode) => {
    if (found) return;
    if (n.type === "Super" || n.type === "MetaProperty") {
      found = true;
      return;
    }
    for (const c of childrenOf(n))
      if (!(isFunction(c) && c.type !== "ArrowFunctionExpression") && c.type !== "ClassBody")
        visit(c);
  };
  visit(fn.body);
  return found;
}

const lowered = (n: AnyNode) =>
  isFunction(n) && n.async && !n.generator && !usesSuperOrNewTarget(n);

/** `code` with its async functions lowered; `code` itself when it has none or does not parse. */
export function lowerAwait(code: string): string {
  if (!/\basync\b/.test(code)) return code;
  let program: AnyNode;
  try {
    program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
    }) as AnyNode;
  } catch {
    return code;
  }
  let changed = false;
  let iterUsed = false;
  let temp = 0;

  // `inLowered`: whether `await` here belongs to a function being lowered.
  const render = (node: AnyNode, inLowered: boolean): string => {
    if (isFunction(node)) return renderFunction(node);
    if (inLowered && node.type === "AwaitExpression")
      return `(yield ${render(node.argument, inLowered)})`;
    if (inLowered && node.type === "ForOfStatement" && node.await)
      return renderForAwait(node, "", inLowered);
    if (inLowered && node.type === "LabeledStatement") {
      let labels = "";
      let body = node;
      while (body.type === "LabeledStatement") {
        labels += `${body.label.name}: `;
        body = body.body;
      }
      if (body.type === "ForOfStatement" && body.await)
        return renderForAwait(body, labels, inLowered);
    }
    let text = generic(node, inLowered);
    // `async` of a lowered method sits before its key (`static async [k]() {}`).
    if (
      (node.type === "MethodDefinition" || (node.type === "Property" && node.method)) &&
      lowered(node.value)
    ) {
      const head = node.key.start - node.start - (node.computed ? 1 : 0);
      const prefix = text.slice(0, head).replace(/\basync\b\s*/, "");
      text = prefix + text.slice(head);
    }
    return text;
  };

  const generic = (
    node: AnyNode,
    inLowered: boolean,
    wrap?: (child: AnyNode, text: string) => string,
  ): string => {
    let out = "";
    let at = node.start;
    for (const c of childrenOf(node)) {
      if (c.start < at) continue; // the same node twice (a shorthand property's key and value)
      out += code.slice(at, c.start);
      const text = render(c, inLowered);
      out += wrap ? wrap(c, text) : text;
      at = c.end;
    }
    return out + code.slice(at, node.end);
  };

  const renderFunction = (fn: AnyNode): string => {
    if (!lowered(fn)) return generic(fn, false);
    changed = true;
    const arrow = fn.type === "ArrowFunctionExpression";
    const text = generic(fn, true, (child, body) => {
      if (child !== fn.body) return body;
      // An arrow's `arguments` is its enclosing function's: pass them on only when it reads them
      // (a module has none).
      const call = !arrow || /\barguments\b/.test(body) ? ".apply(this, arguments)" : ".call(this)";
      if (fn.expression) return `__cellbAsync(function* () { return ${body}; }${call})`;
      return `{ return __cellbAsync(function* () ${body}${call}); }`;
    });
    return text.replace(/^async\b\s*/, "");
  };

  const renderForAwait = (loop: AnyNode, labels: string, inLowered: boolean): string => {
    iterUsed = true;
    const n = temp++;
    const it = `__cellbIt${n}`;
    const step = `__cellbStep${n}`;
    const left = render(loop.left, inLowered);
    const assign =
      loop.left.type === "VariableDeclaration"
        ? `${left} = ${step}.value;`
        : `(${left} = ${step}.value);`;
    return (
      `{ const ${it} = __cellbIter(${render(loop.right, inLowered)}); let ${step}; ` +
      `try { ${labels}for (;;) { ${step} = undefined; ${step} = yield ${it}.next(); ` +
      `if (${step}.done) break; { ${assign} ${render(loop.body, inLowered)} } } } ` +
      `finally { if (${step} && !${step}.done && ${it}.return) yield ${it}.return(); } }`
    );
  };

  const out = render(program, false);
  if (!changed) return code;
  return `${out}\n${ASYNC_RUNNER}\n${iterUsed ? `${ASYNC_ITERATOR}\n` : ""}`;
}
