// The Worker: Astro's handler, plus a Durable Object the pages use.

import { DurableObject } from "cloudflare:workers";
import handler from "@astrojs/cloudflare/entrypoints/server";

export class Visits extends DurableObject {
  hit(page: string): number {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS visits (page TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    sql.exec(
      "INSERT INTO visits (page, n) VALUES (?, 1) ON CONFLICT(page) DO UPDATE SET n = n + 1",
      page,
    );
    return sql.exec<{ n: number }>("SELECT n FROM visits WHERE page = ?", page).one().n;
  }
}

export default handler;
