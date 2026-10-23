/** workerd's `scheduler` global as a JS expression, for browser bundles (see workers-globals.ts). */
export const SCHEDULER_EXPRESSION =
  "({ wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) })";
