self.onmessage = (e) => {
  (self as any).kept = e.data.port;
  (e.data.port as MessagePort).start();
  postMessage("held");
};
