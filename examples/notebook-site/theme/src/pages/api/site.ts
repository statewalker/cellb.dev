// Writes the site model (PUT, JSON): its title and the list of pages the navigation shows.
import { env } from "cloudflare:workers";

export const PUT = async ({ request }) => {
  await env.NOTEBOOKS.put("site", JSON.stringify(await request.json()));
  return new Response(null, { status: 204 });
};
