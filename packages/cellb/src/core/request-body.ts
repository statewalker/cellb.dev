/**
 * Firefox has no `Request.body`, and stores a `ReadableStream` given as a request body as the
 * text `[object ReadableStream]`. Whether the host takes stream bodies is read as webrun-http-streams
 * reads it: `Request.prototype` owns a `body` accessor.
 */
const streamsBodies = () => Object.getOwnPropertyDescriptor(Request.prototype, "body") != null;

/**
 * Where `Request.body` is missing, Worker code reading `request.body` gets a `ReadableStream` read
 * from `arrayBuffer()` on its first pull, so only reading it uses the body up; `null` for GET and
 * HEAD. The getter sits on a prototype inserted below `Request.prototype`: there it does not answer
 * `streamsBodies()`, and webrun-http-streams keeps buffering the bodies it builds requests from.
 */
export function installRequestBody(): void {
  if ("body" in Request.prototype) return;
  const streams = new WeakMap<Request, ReadableStream<Uint8Array>>();
  const below = Object.create(Object.getPrototypeOf(Request.prototype), {
    body: {
      configurable: true,
      get(this: Request) {
        if (this.method === "GET" || this.method === "HEAD") return null;
        let s = streams.get(this);
        if (!s) {
          const req = this;
          s = new ReadableStream<Uint8Array>(
            {
              async pull(c) {
                const bytes = new Uint8Array(await req.arrayBuffer());
                if (bytes.byteLength) c.enqueue(bytes);
                c.close();
              },
            },
            { highWaterMark: 0 }, // pulled on the first read, not when created
          );
          streams.set(this, s);
        }
        return s;
      },
    },
  });
  Object.setPrototypeOf(Request.prototype, below);
}

/** The request under `url` (itself if that is its URL): its body streamed where the host takes that, read whole where not. */
export async function withUrl(req: Request, url: string | URL): Promise<Request> {
  if (req.url === String(url)) return req;
  const bodyless = req.method === "GET" || req.method === "HEAD";
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: bodyless ? null : streamsBodies() ? req.body : await req.blob(),
    signal: req.signal,
    duplex: "half",
  } as RequestInit);
}
