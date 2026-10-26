import type { ValueCodec } from "../ports.js";
import { deserialize, type HostObjects, serialize } from "./serialize.js";

/** Storage values in V8's serialization format — what celld (and workerd) store. */
export const v8Codec: ValueCodec = { encode: serialize, decode: deserialize };

/** V8 serialization with an embedder's own objects (e.g. stored stubs). */
export const v8CodecWith = (host: HostObjects): ValueCodec => ({
  encode: (v) => serialize(v, host),
  decode: (b) => deserialize(b, host),
});
