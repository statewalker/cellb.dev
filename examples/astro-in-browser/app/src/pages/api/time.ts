import type { APIRoute } from "astro";

export const GET: APIRoute = ({ locals, url }) =>
  Response.json({ now: new Date().toISOString(), path: url.pathname, requestId: locals.requestId });
