import { describe, expect, it } from "vitest";
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
});
