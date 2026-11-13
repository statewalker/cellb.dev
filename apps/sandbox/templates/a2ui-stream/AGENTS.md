# AGENTS.md — a2ui-stream

Screens as a stream of messages. The server keeps an append-only log of A2UI-style messages in a
`SurfaceStream` Durable Object. Every client follows the log and applies new messages in order, so
an agent builds and changes a screen step by step (a progress bar, a list filling in, a form
appearing) without writing client code, and without resending the whole screen.

## Messages (A2UI v0.9's shape, trimmed)

```jsonl
{"createSurface": {"surfaceId": "report", "title": "Weekly report"}}
{"updateComponents": {"surfaceId": "report", "components": [
  {"id": "root", "component": "Column", "children": ["h", "status", "rows"]},
  {"id": "h", "component": "Heading", "text": "Weekly report"},
  {"id": "status", "component": "Badge", "text": {"path": "/status"}, "tone": "neutral"},
  {"id": "rows", "component": "List", "items": {"path": "/rows"}}]}}
{"updateDataModel": {"surfaceId": "report", "path": "/status", "value": "working…"}}
{"updateDataModel": {"surfaceId": "report", "path": "/rows", "value": ["a", "b"]}}
{"deleteSurface": {"surfaceId": "report"}}
```

- A surface's root component has the id `root`. `children` name other component ids.
- `updateComponents` adds or replaces components by id, so a later message can change one
  component.
- A property is a literal, or a binding to the surface's data model: `{"path": "/rows"}`.
  `updateDataModel` sets one path; the parents are made as needed.

Catalog (`client/src/catalog.ts`; the server refuses anything else): `Column`, `Row`, `Card`
(`title`), `Heading` (`text`), `Text` (`text`), `Badge` (`text`, `tone`: neutral|good|bad), `Button`
(`label`, `action: {name, context}`; the context's bindings are read when it is clicked),
`TextField` (`label`, `value: {path}`: typing writes that path), `List` (`items`: an array).

## The API (relative URLs)

- `POST api/stream`: one message, a JSON array, or JSON Lines. Checked as a whole: one bad message
  and nothing is appended. Answers `{ last }`, the sequence number of the last message.
- `GET api/stream?since=N`: the messages after N, `{ messages: [{ seq, message }] }`. Clients
  poll this every half second.
- `GET api/actions?since=N`: what people did, `{ actions: [{ seq, at, surfaceId, name, context }] }`.
- `POST api/reset`: back to the welcome surface.
- `?stream=<name>` on any of them, and on the page, picks a stream other than `main`.

Try it: `run_app`. Then `http_request` `POST api/stream` with a message that updates the data
model, and `GET api/actions` after clicking the button.
