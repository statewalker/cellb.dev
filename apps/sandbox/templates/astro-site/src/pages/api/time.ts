import type { APIRoute } from "astro";

export const GET: APIRoute = () => Response.json({ now: new Date().toISOString(), ok: true });
