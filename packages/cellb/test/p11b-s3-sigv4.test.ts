import { describe, expect, it, vi } from "vitest";
import { signV4 } from "../src/bucket/s3-object-store.js";

// AWS's published SigV4 example for S3 (GET Object with a Range header).
describe("P11b S3 Signature V4", () => {
  it("matches AWS's documented example signature", async () => {
    const h = await signV4(
      "GET",
      new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      { range: "bytes=0-9" },
      undefined,
      {
        region: "us-east-1",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
      new Date("2013-05-24T00:00:00Z"),
    );
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  // Every S3 request is signed; the signing key changes once a day (it depends on the date, the
  // region and the secret). Deriving it each time cost four HMACs, each with a WebCrypto key
  // import, per request (statewalker/cellb.dev#208, a fleet node's CPU profile).
  it("derives the signing key once per day, region and secret", async () => {
    const o = { region: "us-east-1", accessKeyId: "AK", secretAccessKey: "cached-secret" };
    const url = new URL("http://127.0.0.1:9200/cells/x");
    const day = new Date("2026-11-22T10:00:00Z");
    const first = await signV4("GET", url, {}, undefined, o, day);
    const spy = vi.spyOn(crypto.subtle, "importKey");
    try {
      for (let i = 0; i < 10; i++)
        await signV4("GET", url, {}, undefined, o, new Date(day.getTime() + i * 1000));
      expect(spy.mock.calls.length).toBeLessThanOrEqual(10); // one per signature, not five
      // the same inputs still sign the same way
      expect(await signV4("GET", url, {}, undefined, o, day)).toEqual(first);
      spy.mockClear();
      await signV4("GET", url, {}, undefined, o, new Date("2026-11-23T00:00:01Z")); // a new day
      expect(spy.mock.calls.length).toBe(5);
    } finally {
      spy.mockRestore();
    }
  });
});
