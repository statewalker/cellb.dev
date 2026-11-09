export const HOSTS: string[];
export function celldBin(): string;
export interface RunningHost {
  host: string;
  url: string;
  logs: string[];
  stop(): Promise<void>;
}
export function startHost(
  host: string,
  dir: string,
  options?: { port?: number; quiet?: boolean; timeoutMs?: number },
): Promise<RunningHost>;
