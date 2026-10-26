const w = window as any;
w.__swReady = (async () => {
  await navigator.serviceWorker.register(new URL("./sw.ts", import.meta.url), {
    type: "module",
    scope: "./",
  });
  return (await navigator.serviceWorker.ready).active!;
})();

// A: does a MessagePort fire "close" when the entangled side's worker dies / is closed?
w.__portClose = async () => {
  const res: Record<string, unknown> = { hasOnclose: "onclose" in MessagePort.prototype };
  for (const how of ["terminate", "port.close"] as const) {
    const { port1, port2 } = new MessageChannel();
    let fired = -1;
    const t0 = performance.now();
    port1.addEventListener("close", () => (fired = Math.round(performance.now() - t0)));
    port1.start();
    const worker = new Worker(new URL("./holder.ts", import.meta.url), { type: "module" });
    worker.postMessage({ port: port2 }, [port2]);
    await new Promise((r) => (worker.onmessage = r));
    const t1 = performance.now();
    if (how === "terminate") worker.terminate();
    else port2 && worker.postMessage("noop"); // port2 is inside the worker; close from here via a new channel test below
    if (how === "port.close") {
      const c = new MessageChannel();
      let f = -1;
      c.port1.addEventListener("close", () => (f = Math.round(performance.now() - t1)));
      c.port1.start();
      c.port2.close();
      await new Promise((r) => setTimeout(r, 500));
      res[how] = f;
      worker.terminate();
      continue;
    }
    await new Promise((r) => setTimeout(r, 1000));
    res[how] = fired >= 0 ? Math.round(fired - (t1 - t0)) : "no event";
  }
  return res;
};
// B: hold a Web Lock; the SW watches it
w.__holdLock = (name: string) => {
  navigator.locks.request(name, () => new Promise(() => {}));
};
w.__sw = async (msg: unknown) => {
  const sw = await w.__swReady;
  return new Promise((r) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (e) => r(e.data);
    sw.postMessage(msg, [port2]);
  });
};
w.__heartbeat = (ms: number) =>
  setInterval(async () => (await w.__swReady).postMessage({ type: "ping" }), ms);
