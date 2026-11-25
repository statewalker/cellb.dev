import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// The fragment DO: a counter its entrypoint reaches.
export class Fragment extends DurableObject {
  bump() {
    const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return n;
  }
}

// The contract other fragments call: cloneable values and streams.
export class Api extends WorkerEntrypoint {
  hello(name) {
    return `hello ${name} from ${this.env.LABEL}, props ${JSON.stringify(this.ctx.props)}`;
  }
  count() {
    return this.env.FRAGMENT.getByName("gamma").bump();
  }
  echo(value) {
    return value;
  }
  // A stream in, a stream out: the bytes upper-cased.
  upper(stream) {
    return stream
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TransformStream({ transform: (s, c) => c.enqueue(s.toUpperCase()) }))
      .pipeThrough(new TextEncoderStream());
  }
  fail() {
    throw new RangeError("gamma refused");
  }
  giveFunction() {
    return { f: () => 1 };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    return new Response(
      `${env.LABEL} default ${request.method} ${url.pathname}${url.search} ${await request.text()}`,
      { status: 201, headers: { "x-from": env.LABEL } },
    );
  },
};
