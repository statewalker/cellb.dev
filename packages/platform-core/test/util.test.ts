import { describe, expect, it } from "vitest";
import { packageNameOf } from "../src/registry-fetch.js";
import { parseJsonc, unzip, zip, zipStream } from "../src/util.js";

describe("zip", () => {
  it("round-trips, buffered and streamed", async () => {
    const files = new Map([
      ["/a.txt", new TextEncoder().encode("hello")],
      ["/dir/ü.bin", new Uint8Array([0, 1, 2, 255])],
    ]);
    expect(await unzip(zip(files))).toEqual(files);
    const streamed = new Uint8Array(
      await new Response(
        zipStream([...files.keys()], async (p) => files.get(p) as Uint8Array),
      ).arrayBuffer(),
    );
    expect(streamed).toEqual(zip(files));
  });
});

describe("parseJsonc", () => {
  it("strips comments and trailing commas, not inside strings", () => {
    expect(parseJsonc('{ // c\n "a": "x // y", /* z */ "b": [1, 2,], }')).toEqual({
      a: "x // y",
      b: [1, 2],
    });
  });
});

describe("packageNameOf", () => {
  it("names the package of a registry path", () => {
    expect(packageNameOf("/react")).toBe("react");
    expect(packageNameOf("/@scope%2fpkg")).toBe("@scope/pkg");
    expect(packageNameOf("/@scope/pkg/-/pkg-1.0.0.tgz")).toBe("@scope/pkg");
    expect(packageNameOf("/ms/-/ms-2.1.3.tgz")).toBe("ms");
  });
});
