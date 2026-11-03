import path from "node:path";
import { docHref, repoPages } from "./docs";

interface Node {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

/**
 * Rewrites the relative links of a repository Markdown file rendered on the site: a link to
 * another rendered file (or to a directory whose README.md is rendered) goes to its page; any
 * other file of the repository goes to GitHub, as the relative link would not exist on the site.
 */
export function rehypeRepoLinks({ root }: { root: string }) {
  const rendered = new Set(repoPages.map((page) => page.file));

  const rewrite = (from: string, href: string) => {
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return href;
    const [target = "", hash = ""] = href.split(/(?=#)/);
    let file = path.posix
      .normalize(path.posix.join(path.posix.dirname(from), target))
      .replace(/\/$/, "");
    if (file.startsWith("..")) return href;
    if (rendered.has(`${file}/README.md`)) file = `${file}/README.md`;
    return docHref(file) + hash;
  };

  return (tree: Node, vfile: { path?: string }) => {
    const from = vfile.path && path.relative(root, vfile.path).split(path.sep).join("/");
    if (!from || !rendered.has(from)) return;
    const visit = (node: Node) => {
      const href = node.tagName === "a" ? node.properties?.href : undefined;
      if (node.properties && typeof href === "string") node.properties.href = rewrite(from, href);
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
