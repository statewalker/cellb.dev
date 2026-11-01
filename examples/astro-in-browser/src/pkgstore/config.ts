/** The package store's wrangler config (one Durable Object class with SQLite storage). */
export const pkgstoreConfig = {
  name: "pkgstore",
  main: "worker.js",
  compatibility_date: "2026-02-24",
  durable_objects: { bindings: [{ name: "STORE", class_name: "PackageStore" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["PackageStore"] }],
};
