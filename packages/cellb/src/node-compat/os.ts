/** `node:os` for browsers (nodejs_compat): the platform constants code reads at load time. */
export const EOL = "\n";
export const platform = () => "browser";
export const tmpdir = () => "/tmp";
export const homedir = () => "/";
export default { EOL, platform, tmpdir, homedir };
