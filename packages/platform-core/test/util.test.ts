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

describe("upload paths", () => {
  it("refuses .., backslashes and NUL, and resolves the rest", async () => {
    const { safeUploadPath } = await import("../src/util.js");
    expect(safeUploadPath("src/a.ts")).toBe("/src/a.ts");
    expect(safeUploadPath("/./src//a.ts")).toBe("/src/a.ts");
    for (const bad of ["../snap/x", "a/../../b", "a\\b", "a\0b", ".."])
      expect(() => safeUploadPath(bad)).toThrow(/refused/);
  });

  it("unzip refuses an entry that climbs out of its tree", async () => {
    const files = new Map([["/../snap/x/index.html", new TextEncoder().encode("x")]]);
    await expect(unzip(zip(files))).rejects.toThrow(/refused/);
  });

  it("unzip reports a truncated archive, and a limit on inflated bytes", async () => {
    const z = zip(new Map([["/a.txt", new Uint8Array(1000)]]));
    await expect(unzip(z.subarray(0, z.length - 30))).rejects.toThrow(/not a ZIP|corrupt/);
    await expect(unzip(z, { maxBytes: 10 })).rejects.toThrow(/inflates past/);
  });
});

describe("parseRegistryPath", () => {
  it("accepts only packuments and tarballs", async () => {
    const { parseRegistryPath } = await import("../src/registry-fetch.js");
    expect(parseRegistryPath("/react")).toEqual({ name: "react", kind: "packument" });
    expect(parseRegistryPath("/@scope%2fpkg")).toEqual({ name: "@scope/pkg", kind: "packument" });
    expect(parseRegistryPath("/JSONStream")).toEqual({ name: "JSONStream", kind: "packument" });
    expect(parseRegistryPath("/@s/p/-/p-1.0.0.tgz")).toEqual({
      name: "@s/p",
      kind: "tarball",
      file: "p-1.0.0.tgz",
    });
    for (const bad of [
      "/react/latest",
      "/react/18.2.0",
      "/react/-/../x.tgz",
      "/",
      "/%E0%A4%A",
      "/a/-/b/c.tgz",
    ])
      expect(parseRegistryPath(bad)).toBeUndefined();
  });
});
