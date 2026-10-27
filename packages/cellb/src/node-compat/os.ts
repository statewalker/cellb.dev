/** `node:os` for browsers (nodejs_compat): constants and harmless answers, no host facts. */
export const EOL = "\n";
export const devNull = "/dev/null";
export const platform = () => "linux";
export const type = () => "Linux";
export const arch = () => "wasm";
export const release = () => "";
export const hostname = () => "localhost";
export const homedir = () => "/";
export const tmpdir = () => "/tmp";
export const endianness = () => "LE";
export const cpus = () => [];
export const totalmem = () => 0;
export const freemem = () => 0;
export const uptime = () => 0;
export const loadavg = () => [0, 0, 0];
export const networkInterfaces = () => ({});

export default {
  EOL,
  devNull,
  platform,
  type,
  arch,
  release,
  hostname,
  homedir,
  tmpdir,
  endianness,
  cpus,
  totalmem,
  freemem,
  uptime,
  loadavg,
  networkInterfaces,
};
