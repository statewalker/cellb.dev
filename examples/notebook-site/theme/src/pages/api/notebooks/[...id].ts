// Writes one page model (PUT, JSON) or removes it (DELETE). Unauthenticated: a demo of editing
// content without rebuilding the theme, not something to expose as is.
import { env } from "cloudflare:workers";

export const PUT = async ({ params, request }) => {
  await env.NOTEBOOKS.put(`page:${params.id}`, JSON.stringify(await request.json()));
  return new Response(null, { status: 204 });
};

export const DELETE = async ({ params }) => {
  await env.NOTEBOOKS.delete(`page:${params.id}`);
  return new Response(null, { status: 204 });
};
