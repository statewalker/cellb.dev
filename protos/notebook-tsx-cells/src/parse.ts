// PROTOTYPE (statewalker/statewalker-root#236). Splits a notebook page into prose and code cells.
export type CellMode = "js" | "ts" | "jsx" | "tsx";
export type Cell = { id: number; mode: CellMode; source: string; line: number }; // line: 1-based Markdown line of the first source line
export type Block = { kind: "prose"; text: string } | { kind: "cell"; cell: Cell };

const MODES: Record<string, CellMode> = { js: "js", javascript: "js", ts: "ts", typescript: "ts", jsx: "jsx", tsx: "tsx" };

export function parsePage(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let prose: string[] = [];
  let id = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\w+)\s*(.*)$/.exec(lines[i]);
    const mode = open && MODES[open[1]];
    if (!open || !mode || /\brun=false\b/.test(open[2])) {
      prose.push(lines[i]);
      if (open) for (i++; i < lines.length; i++) { prose.push(lines[i]); if (lines[i].startsWith("```")) break; }
      continue;
    }
    const start = i + 1;
    const body: string[] = [];
    for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
    if (prose.length) blocks.push({ kind: "prose", text: prose.join("\n") });
    prose = [];
    blocks.push({ kind: "cell", cell: { id: ++id, mode, source: body.join("\n"), line: start + 1 } });
  }
  if (prose.length) blocks.push({ kind: "prose", text: prose.join("\n") });
  return blocks;
}
