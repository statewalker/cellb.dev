import add from "./add.wasm";
import addModule from "./add.wasm?module";
import data from "./bytes.dat";
import greeting from "./greeting.md";

export default {
  fetch(request) {
    const url = new URL(request.url);
    const a = Number(url.searchParams.get("a"));
    const b = Number(url.searchParams.get("b"));
    const sum = new WebAssembly.Instance(add, {}).exports.add(a, b);
    return Response.json({
      sum,
      module: add instanceof WebAssembly.Module,
      sameModuleRule: new WebAssembly.Instance(addModule).exports.add(a, b),
      greeting,
      data: data instanceof ArrayBuffer ? [...new Uint8Array(data)] : null,
    });
  },
};
