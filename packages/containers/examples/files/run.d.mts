export function runFilesExample(wasmer: unknown): Promise<{
  report: { files: number; words: number; hiddenSeen: boolean; writeToInput: string };
  hostOutput: string;
}>;
