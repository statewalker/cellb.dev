// Node.js compatibility (nodejs_compat): the modules and globals Workers code most often uses.
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { format, inspect, promisify, types } from "node:util";

export default {
  async fetch() {
    const out = {};
    const b = Buffer.from("héllo wörld");
    out.buffer = {
      hex: b.toString("hex"),
      base64: b.toString("base64"),
      len: b.length,
      concat: Buffer.concat([Buffer.from("a"), Buffer.from("b")]).toString(),
      isBuffer: Buffer.isBuffer(b),
      readUInt16BE: Buffer.from([1, 2]).readUInt16BE(0),
      globalBuffer: typeof globalThis.Buffer,
    };
    out.crypto = {
      sha256: createHash("sha256").update("abc").digest("hex"),
      md5: createHash("md5").update("abc").digest("base64"),
      hmac: createHmac("sha256", "key").update("data").digest("hex"),
      uuid: /^[0-9a-f-]{36}$/.test(randomUUID()),
      tse: timingSafeEqual(Buffer.from("x"), Buffer.from("x")),
    };
    const em = new EventEmitter();
    const seen = [];
    em.on("e", (v) => seen.push(v));
    em.once("e", (v) => seen.push(`once:${v}`));
    em.emit("e", 1);
    em.emit("e", 2);
    out.events = { seen, count: em.listenerCount("e") };
    out.path = {
      join: path.join("/a/b", "../c", "d.txt"),
      ext: path.extname("x/y.tar.gz"),
      base: path.basename("/p/q/file.js", ".js"),
      resolve: path.resolve("/root", "x", "..", "y"),
    };
    out.util = {
      format: format("%s=%d %j", "n", 42, { a: 1 }),
      inspect: inspect({ a: [1, { b: 2 }] }),
      promisified: await promisify((x, cb) => cb(null, x * 2))(21),
      isDate: types.isDate(new Date()),
    };
    const als = new AsyncLocalStorage();
    out.als = await als.run({ id: 7 }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return als.getStore()?.id;
    });
    out.process = { env: typeof process.env, nextTick: typeof process.nextTick };
    return Response.json(out);
  },
};
