// Types for git-server.mjs, so the tests that import it typecheck with `allowJs` off.
export interface GitServer {
  /** The temp directory holding the bare repositories. */
  root: string;
  /** Creates a bare repository that accepts pushes; returns its URL. */
  create(name: string): string;
  /** Runs git in the named repository and returns its stdout. */
  git(name: string, ...args: string[]): string;
  close(): Promise<void>;
}

export function startGitServer(): Promise<GitServer>;
