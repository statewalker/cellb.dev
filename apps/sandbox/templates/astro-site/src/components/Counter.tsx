import { useState } from "react";

export default function Counter({ start }: { start: number }) {
  const [n, setN] = useState(start);
  return (
    <button type="button" id="island" onClick={() => setN(n + 1)}>
      island clicks: {n}
    </button>
  );
}
