/**
 * `HostedSiteBuilder` (webrun-site-host) for sites hosted on pages served over https as well.
 *
 * webrun-http-browser (0.12) moves a request from the ServiceWorker to the page as HTTP/1.1: an
 * origin-form target (`GET /key/path`) and a `Host` header. The page reads it back as
 * `http://<host>/key/path`, whatever the page's own scheme. Its handlers are registered under the
 * page's URL (`https://<host>/key/`), and they are found by prefix, so on an https page no request
 * reached its handler: every one got "404 Error 404: Not found". Locally (http) nothing showed.
 *
 * The adapter made here gives each incoming request of this origin the page's scheme back before
 * the handler is looked up. When webrun-http-browser keeps the scheme itself, this changes nothing.
 */
import { SwHttpAdapter } from "@statewalker/webrun-http-browser";
import { type AdapterFactory, HostedSiteBuilder } from "@statewalker/webrun-site-host";

/** `request` at `scheme` ("https:"), if it is for `host` under another scheme; else `request`. */
export function withScheme(request: Request, scheme: string, host: string): Request {
  const url = new URL(request.url);
  if (url.protocol === scheme || url.host !== host) return request;
  if (url.protocol !== "http:" && url.protocol !== "https:") return request;
  url.protocol = scheme;
  const body = request.body;
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
    signal: request.signal,
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** The default adapter (`SwHttpAdapter`), with requests at the page's scheme. */
const pageSchemeAdapter: AdapterFactory = ({ key, serviceWorkerUrl }) => {
  const adapter = new SwHttpAdapter({ key, serviceWorkerUrl });
  const location = (globalThis as { location?: Location }).location;
  if (!location || location.protocol === "http:") return adapter;
  // Every request from the ServiceWorker goes through `_handleHttpRequest` (the adapter's
  // endpoint calls it as `this._handleHttpRequest(request)`), before the handler lookup.
  const inner = adapter as unknown as { _handleHttpRequest?: (r: Request) => Promise<Response> };
  const handle = inner._handleHttpRequest?.bind(adapter);
  if (typeof handle !== "function") return adapter;
  inner._handleHttpRequest = (request) =>
    handle(withScheme(request, location.protocol, location.host));
  return adapter;
};

/** A `HostedSiteBuilder` whose sites answer on https pages too. */
export function newHostedSiteBuilder(): HostedSiteBuilder {
  return new HostedSiteBuilder({ adapterFactory: pageSchemeAdapter });
}
