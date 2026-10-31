/**
 * workerd's `MessageChannel` on a Node host. In workerd an open port does not keep anything
 * alive; on Node a port with a `message` handler is ref'd and holds the event loop open until it
 * is closed. Libraries create such ports at module scope and never close them (React DOM's
 * server renderer schedules its work over one), so a Worker bundle that imports them would keep
 * the Node process alive after its runtime is closed.
 *
 * The ports of this channel are unref'd and hold the loop open only while a message posted to
 * one of them waits for its handler, so a pending render still completes. Messages, transfers
 * and `close()` are the real ports'. Where ports have no `unref` (browsers), it is the plain
 * `MessageChannel`.
 */

type NodePort = MessagePort & { ref(): NodePort; unref(): NodePort };
type Listener = EventListenerOrEventListenerObject;

/** Makes `port` unref'd except while messages posted to it wait for a handler. */
function weakPort(port: NodePort, peer: NodePort): void {
  const realRef = port.ref.bind(port);
  const realUnref = port.unref.bind(port);
  let pending = 0; // messages posted to this port, not yet dispatched
  let handlers = 0; // `onmessage` and `message` listeners
  let held = false;
  const sync = () => {
    const hold = pending > 0 && handlers > 0;
    if (hold === held) return;
    held = hold;
    if (hold) realRef();
    else realUnref();
  };
  // Node refs a port when a handler is attached: keep that to `sync`.
  port.ref = () => port;
  port.unref = () => port;

  const dispatched = new WeakSet<Event>();
  const delivered = (event: Event) => {
    if (dispatched.has(event)) return;
    dispatched.add(event);
    pending = Math.max(0, pending - 1);
    sync();
  };
  const wrappers = new WeakMap<Listener, Listener>();
  const wrap = (listener: Listener): Listener => {
    let wrapped = wrappers.get(listener);
    if (!wrapped) {
      wrapped = function (this: unknown, event: Event) {
        delivered(event);
        return typeof listener === "function"
          ? listener.call(this, event)
          : listener.handleEvent(event);
      };
      wrappers.set(listener, wrapped);
    }
    return wrapped;
  };

  const proto = Object.getPrototypeOf(port) as object;
  const onmessage = findAccessor(proto, "onmessage");
  let current: ((event: MessageEvent) => unknown) | null = null;
  if (onmessage?.set && onmessage.get) {
    Object.defineProperty(port, "onmessage", {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (fn: ((event: MessageEvent) => unknown) | null) => {
        if (typeof fn === "function" && !current) handlers++;
        if (typeof fn !== "function" && current) handlers--;
        current = typeof fn === "function" ? fn : null;
        onmessage.set?.call(port, current && wrap(current as EventListener));
        realUnref();
        held = false;
        sync();
      },
    });
  }
  const add = port.addEventListener.bind(port);
  const remove = port.removeEventListener.bind(port);
  const registered = new Set<Listener>();
  port.addEventListener = ((type: string, listener: Listener | null, options?: unknown) => {
    if (type !== "message" || !listener) return add(type, listener as Listener, options as never);
    add(type, wrap(listener), options as never);
    if (!registered.has(listener)) {
      registered.add(listener);
      handlers++;
    }
    realUnref();
    held = false;
    sync();
  }) as typeof port.addEventListener;
  port.removeEventListener = ((type: string, listener: Listener | null, options?: unknown) => {
    if (type !== "message" || !listener)
      return remove(type, listener as Listener, options as never);
    remove(type, wrappers.get(listener) ?? listener, options as never);
    if (registered.delete(listener)) handlers--;
    sync();
  }) as typeof port.removeEventListener;

  // Posting from the peer: one more message waits on this port.
  const post = peer.postMessage.bind(peer) as (...args: unknown[]) => void;
  peer.postMessage = ((...args: unknown[]) => {
    post(...args);
    pending++;
    sync();
  }) as typeof peer.postMessage;
  const close = port.close.bind(port);
  port.close = () => {
    pending = 0;
    handlers = 0;
    sync();
    close();
  };
  realUnref();
}

function findAccessor(proto: object | null, name: string): PropertyDescriptor | undefined {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d) return d;
  }
  return undefined;
}

const Base = globalThis.MessageChannel;

export const WorkerdMessageChannel: typeof MessageChannel | undefined =
  typeof Base === "function"
    ? class MessageChannel extends Base {
        constructor() {
          super();
          const port1 = this.port1 as NodePort;
          const port2 = this.port2 as NodePort;
          if (typeof port1.unref !== "function" || typeof port1.ref !== "function") return;
          weakPort(port1, port2);
          weakPort(port2, port1);
        }
      }
    : Base;
