// Calls readDir("") on each mount id it is given, through the synchronous host-filesystem client,
// and reports what each answered.
import { parentPort, workerData } from "node:worker_threads";
import { syncHostFiles } from "../../src/files/sync-client.ts";

const { port, ids } = workerData as { port: MessagePort; ids: number[] };
const results = ids.map((id) => {
  try {
    return {
      id,
      names: (syncHostFiles(port as never, id)("readDir", [""]) as { name: string }[]).map(
        (e) => e.name,
      ),
    };
  } catch (e) {
    return { id, error: (e as { code?: string }).code };
  }
});
parentPort?.postMessage(results);
