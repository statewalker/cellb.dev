/** Deterministic `_key` generator: `p1-b0`, `p1-b1`, ... */
export type KeyGen = (kind: string) => string;

export function createKeyGen(prefix = ""): KeyGen {
  const counters = new Map<string, number>();
  return (kind) => {
    const n = counters.get(kind) ?? 0;
    counters.set(kind, n + 1);
    return `${prefix}${kind}${n.toString(36)}`;
  };
}
