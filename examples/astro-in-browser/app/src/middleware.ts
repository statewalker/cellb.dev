import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.requestId = crypto.randomUUID().slice(0, 8);
  const response = await next();
  response.headers.set("x-built-in", "browser");
  return response;
});
