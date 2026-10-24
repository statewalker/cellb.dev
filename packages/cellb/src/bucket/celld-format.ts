/** Byte and name helpers shared by the celld bucket layout (celld-cells) and its LTX log. */
export const pad16 = (n: bigint) => n.toString(16).padStart(16, "0");
export const equal = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
export const pageSizeOf = (image: Uint8Array) => {
  const v = (image[16] << 8) | image[17];
  return v === 1 ? 65536 : v;
};
/**
 * celld's cells run in WAL mode (header bytes 18–19 = 2); a restored image is switched to a
 * rollback journal (1/1) so any driver can open it from memory; SQLite rewrites them when a
 * runtime sets WAL again.
 */
export const toRollback = (image: Uint8Array) => {
  if (image.length > 19 && image[18] === 2) {
    image[18] = 1;
    image[19] = 1;
  }
  return image;
};
