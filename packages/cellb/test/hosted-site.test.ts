// newHostedSiteBuilder's request rewrite: webrun-http-browser hands the page a request rebuilt as
// http://<host>/…; on an https page it must reach the handler as https://<host>/….
import { describe, expect, it } from "vitest";
import { withScheme } from "../src/project/hosted-site.js";

describe("withScheme", () => {
  it("gives a request of this host the page's scheme", () => {
    const r = withScheme(
      new Request("http://cellb.dev/sandbox/app/k/api?x=1"),
      "https:",
      "cellb.dev",
    );
    expect(r.url).toBe("https://cellb.dev/sandbox/app/k/api?x=1");
  });

  it("keeps the method, headers and body", async () => {
    const r = withScheme(
      new Request("http://cellb.dev/k/tasks", {
        method: "POST",
        headers: { "content-type": "application/json", "x-a": "1" },
        body: JSON.stringify({ title: "t" }),
      }),
      "https:",
      "cellb.dev",
    );
    expect(r.method).toBe("POST");
    expect(r.headers.get("x-a")).toBe("1");
    expect(await r.json()).toEqual({ title: "t" });
  });

  it("leaves a request already at the scheme, or of another host, as it is", () => {
    const same = new Request("https://cellb.dev/k/");
    expect(withScheme(same, "https:", "cellb.dev")).toBe(same);
    const other = new Request("http://example.com/k/");
    expect(withScheme(other, "https:", "cellb.dev")).toBe(other);
  });
});
