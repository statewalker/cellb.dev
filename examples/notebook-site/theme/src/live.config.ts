// Notebooks are data, not sources: page models live in the NOTEBOOKS KV namespace, written by the
// notebook build (or the edit endpoints under /api), and read at request time. Changing a
// notebook never rebuilds this theme.
//   "site"        → SiteModel  { title, pages: [{ id, path, title }] }
//   "page:<id>"   → PageModel  { id, path, title, outline, blocks, script, stylesUrl }
import { defineLiveCollection } from "astro:content";
import { env } from "cloudflare:workers";

const kv = () => env.NOTEBOOKS;
const readSite = async () => (await kv().get("site", "json")) ?? { title: "Notebooks", pages: [] };

export const collections = {
  site: defineLiveCollection({
    loader: {
      name: "notebook-site",
      loadCollection: async () => ({ entries: [{ id: "site", data: await readSite() }] }),
      loadEntry: async () => ({ id: "site", data: await readSite() }),
    },
  }),
  notebooks: defineLiveCollection({
    loader: {
      name: "notebook-pages",
      loadCollection: async () => ({
        entries: (await readSite()).pages.map((p) => ({ id: p.id, data: p })),
      }),
      loadEntry: async ({ filter }) => {
        const data = await kv().get(`page:${filter.id}`, "json");
        return data ? { id: filter.id, data } : undefined;
      },
    },
  }),
};
