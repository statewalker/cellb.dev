// The chooser (start.html): each app's saved build (builds.ts), and links to launch it (its
// saved build, or compiled when there is none) or to compile it again. Under /__cellb/, so the
// ServiceWorker always serves it; a navigation that finds no tab running the site lands here
// with the path it asked for as ?next=.
import { type AppName, savedBuildMeta } from "./builds.ts";
import { nextPath } from "./next-path.ts";

const NAMES: Record<AppName, string> = { app: "the small Astro app", emdash: "EmDash" };
/** About how long a compile takes, cold (packages downloaded) and warm. */
const COMPILE: Record<AppName, string> = {
  app: "a few seconds",
  emdash: "about two minutes the first time, one minute after that",
};

const safeNext = nextPath();

let last: { app?: AppName; at?: number } | undefined;
try {
  last = JSON.parse(localStorage.getItem("cellb:last-build") ?? "null") ?? undefined;
} catch {}

if (safeNext) {
  const el = document.getElementById("next") as HTMLElement;
  el.hidden = false;
  el.textContent = `No tab is running an app for ${safeNext}: launch one below, and its page links to it once it runs.`;
}

for (const row of document.querySelectorAll<HTMLTableRowElement>("tr[data-app]")) {
  const app = row.dataset.app as AppName;
  const state = row.querySelector(".state") as HTMLElement;
  const launch = row.querySelector<HTMLAnchorElement>("a.launch");
  const rebuild = row.querySelector<HTMLAnchorElement>("a.rebuild");
  if (safeNext)
    for (const a of [launch, rebuild]) {
      const href = a?.getAttribute("href") ?? "";
      a?.setAttribute(
        "href",
        `${href}${href.includes("?") ? "&" : "?"}${new URLSearchParams({ next: safeNext })}`,
      );
    }
  const meta = await savedBuildMeta(app);
  if (meta) {
    state.textContent = `Saved build of ${new Date(meta.at).toLocaleString()} (${meta.routes} routes): launches in seconds.`;
  } else {
    state.textContent = `Not built in this browser yet: launching compiles it (${COMPILE[app]}).`;
    if (launch) launch.textContent = "Build and launch";
    rebuild?.remove();
  }
  if (last?.app === app) {
    row.dataset.last = "";
    state.append(` Launched last: ${NAMES[app]} is at / while its tab is open.`);
  }
}
document.body.dataset.ready = "true";
