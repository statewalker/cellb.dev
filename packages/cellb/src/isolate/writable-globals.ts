/**
 * workerd's globals are plain properties that Worker code may assign: Kitesurf's DOM shim sets
 * `globalThis.navigator` and `globalThis.location`. The realm an isolate runs in has getters
 * without setters for some of its own (Node's `navigator`; a Dedicated Worker's `location`,
 * `navigator`, `origin`, … on WorkerGlobalScope.prototype), and assigning one throws in strict
 * mode. The isolate is the loaded Worker's realm, so each such global becomes a writable data
 * property of `globalThis` holding the value it has now.
 */
export function makeGlobalsWritable(): string[] {
  const changed: string[] = [];
  const seen = new Set<PropertyKey>();
  for (
    let o: object | null = globalThis;
    o && o !== Object.prototype;
    o = Object.getPrototypeOf(o)
  ) {
    for (const key of Reflect.ownKeys(o)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const d = Object.getOwnPropertyDescriptor(o, key);
      if (!d?.get || d.set) continue;
      if (o === globalThis && !d.configurable) continue;
      let value: unknown;
      try {
        value = Reflect.get(globalThis, key);
      } catch {
        continue; // a getter that throws here (an API this realm refuses) stays as it is
      }
      try {
        Object.defineProperty(globalThis, key, {
          value,
          writable: true,
          configurable: true,
          enumerable: d.enumerable,
        });
        changed.push(String(key));
      } catch {
        // not redefinable in this realm
      }
    }
  }
  return changed;
}
