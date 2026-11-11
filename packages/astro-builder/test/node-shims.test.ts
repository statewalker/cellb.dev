// node:crypto as build-time code gets it (buildTimeNodeModule): createHash("sha256") must give
// Node's answers. EmDash 1.5 hashes its virtual modules' imports at build time.
import { createHash as nodeHash, randomBytes as nodeRandom } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildTimeNodeModule } from "../src/node-shims.js";

type Hash = { update(d: unknown, enc?: string): Hash; digest(enc?: string): string | Uint8Array };
const shim = (await import(
  `data:text/javascript,${encodeURIComponent(buildTimeNodeModule("node:crypto") as string)}`
)) as { createHash(alg: string): Hash };

describe("build-time node:crypto createHash", () => {
  it("gives Node's SHA-256 for every length around the block boundaries", () => {
    for (const len of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 70_000]) {
      const data = new Uint8Array(nodeRandom(len));
      expect(shim.createHash("sha256").update(data).digest("hex"), `length ${len}`).toBe(
        nodeHash("sha256").update(data).digest("hex"),
      );
    }
  });

  it("hashes strings as UTF-8, joins updates, and takes hex and base64 input", () => {
    const text = 'import x from "virtual:emdash/config";\nÄ, 日本, 🙂';
    const expected = nodeHash("sha256").update(text).digest("hex");
    expect(shim.createHash("sha256").update(text).digest("hex")).toBe(expected);
    expect(
      shim.createHash("SHA-256").update(text.slice(0, 7)).update(text.slice(7)).digest("hex"),
    ).toBe(expected);
    const bytes = Buffer.from("abc");
    expect(shim.createHash("sha256").update(bytes.toString("hex"), "hex").digest("hex")).toBe(
      nodeHash("sha256").update(bytes).digest("hex"),
    );
    expect(
      shim.createHash("sha256").update(bytes.toString("base64"), "base64").digest("base64"),
    ).toBe(nodeHash("sha256").update(bytes).digest("base64"));
  });

  it("returns the raw digest without an encoding, and base64url", () => {
    const d = shim.createHash("sha256").update("x").digest() as Uint8Array;
    expect(Buffer.from(d).equals(nodeHash("sha256").update("x").digest())).toBe(true);
    expect(shim.createHash("sha256").update("x").digest("base64url")).toBe(
      nodeHash("sha256").update("x").digest("base64url"),
    );
  });

  it("names the algorithms it does not have", () => {
    expect(() => shim.createHash("md5")).toThrow(/only sha256/);
  });
});
