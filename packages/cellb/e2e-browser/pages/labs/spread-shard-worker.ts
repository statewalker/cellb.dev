/// <reference lib="webworker" />
// The spread probe's shard worker, served from /labs/ so that it and the LTX store worker it
// starts are cross-origin isolated (vite.config's isolatedLabs keys on the referer).
import "../spread/shard-worker.ts";
