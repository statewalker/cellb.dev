// Notebooks are data, not sources. The NotebookSite object loads this theme's build with the
// Worker Loader and passes the page models in its env as plain JSON:
//   env.NOTEBOOK_MODELS = { site: SiteModel, pages: { [id]: PageModel } }
// A notebook edit changes that data, never this theme's build. (PageModel and SiteModel are
// defined in packages/notebooks/src/page-models.ts.)
import { defineLiveCollection } from "astro:content";
import { env } from "cloudflare:workers";

const models = () =>
  env.NOTEBOOK_MODELS ?? { site: { title: "Notebooks", home: "/", pages: [] }, pages: {} };

export const collections = {
  site: defineLiveCollection({
    loader: {
      name: "notebook-site",
      loadCollection: async () => ({ entries: [{ id: "site", data: models().site }] }),
      loadEntry: async () => ({ id: "site", data: models().site }),
    },
  }),
  notebooks: defineLiveCollection({
    loader: {
      name: "notebook-pages",
      loadCollection: async () => ({
        entries: models().site.pages.map((p) => ({ id: p.id, data: p })),
      }),
      loadEntry: async ({ filter }) => {
        const data = models().pages[filter.id];
        return data ? { id: filter.id, data } : undefined;
      },
    },
  }),
};
