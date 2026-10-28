export const REPO = "https://github.com/statewalker/cellb.dev";
/** Links into the repository's default branch. */
export const repoFile = (path: string) => `${REPO}/blob/HEAD/${path}`;
export const repoDoc = (name: string) => repoFile(`packages/cellb/docs/${name}`);
export const CELLD = "https://celld.dev";
