import { useState } from "react";

export function App({ name }: { name: string }) {
  const [n, setN] = useState(0);
  return (
    <main className="app">
      <h1>Hello from {name}</h1>
      <p>TSX served as ESM by the platform; React from its ESM CDN.</p>
      <button type="button" id="inc" onClick={() => setN(n + 1)}>
        clicked {n} times
      </button>
    </main>
  );
}
