import { describe, expect, it } from "vitest";
import { closingWith } from "../src/core/object-host.js";

// closingWith gives a request the host's closing signal without copying it: a copy and a merged
// signal on every request cost as much as a small handler's turn (2026-11: 80k → 40k requests a
// second in process).
describe("P34b closingWith", () => {
  it("returns the same request, and leaves the signal unbuilt until it is read", () => {
    const req = new Request("http://x/");
    const closing = new AbortController();
    expect(closingWith(req, closing.signal)).toBe(req);
    expect(req.signal.aborted).toBe(false);
    closing.abort(new Error("closing"));
    expect(req.signal.aborted).toBe(true);
    expect(req.signal.reason).toEqual(new Error("closing"));
  });

  it("still aborts with the request's own signal", () => {
    const client = new AbortController();
    const req = new Request("http://x/", { signal: client.signal });
    closingWith(req, new AbortController().signal);
    const seen = req.signal;
    client.abort();
    expect(seen.aborted).toBe(true);
  });

  it("chains: a request given to a stub aborts when either host closes", () => {
    for (const which of [0, 1]) {
      const runtime = new AbortController();
      const object = new AbortController();
      const req = closingWith(closingWith(new Request("http://x/"), runtime.signal), object.signal);
      [runtime, object][which].abort();
      expect(req.signal.aborted).toBe(true);
    }
  });

  it("keeps what cellb set on the request (cf, an upgrade's headers)", () => {
    const req = new Request("http://x/");
    const cf = { colo: "x" };
    Object.defineProperty(req, "cf", { value: cf, enumerable: true });
    const headers = new Headers({ upgrade: "websocket" });
    Object.defineProperty(req, "headers", { value: headers });
    const r = closingWith(req, new AbortController().signal) as Request & { cf: unknown };
    expect(r.cf).toBe(cf);
    expect(r.headers.get("upgrade")).toBe("websocket");
  });

  it("does nothing once the host is closing: the request keeps its own signal", () => {
    const closing = new AbortController();
    closing.abort();
    const req = new Request("http://x/");
    const own = req.signal;
    closingWith(req, closing.signal);
    expect(req.signal).toBe(own);
  });
});
