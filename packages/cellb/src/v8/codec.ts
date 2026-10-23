import type { ValueCodec } from "../ports.js";
import { deserialize, serialize } from "./serialize.js";

/** Storage values in V8's serialization format — what celld (and workerd) store. */
export const v8Codec: ValueCodec = { encode: serialize, decode: deserialize };
