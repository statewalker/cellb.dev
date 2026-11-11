# AGENTS.md — agent-ui

A screen described as data. The server keeps a **spec** (a flat JSON tree, the json-render /
A2UI shape) per surface in a `Surface` Durable Object; the client renders it with a fixed
**catalog** and posts user actions back. Change the screen by sending a spec, not by writing
client code.

## The spec

```json
{
  "root": "main",
  "elements": {
    "main": { "type": "Stack", "children": ["title", "hello"] },
    "title": { "type": "Heading", "props": { "text": "Hello" } },
    "hello": { "type": "Button", "props": { "label": "Say hi", "action": "say", "params": { "text": "hi" } } }
  },
  "state": { "messages": [] }
}
```

Catalog (`client/src/catalog.ts`, the only types the client renders): `Stack` (`gap`, `direction`:
"row"|"column"), `Card` (`title`), `Heading` (`text`), `Text` (`text`, or `bind`: a path in `state`
such as "/count"), `Badge` (`text`, `tone`: "neutral"|"good"|"bad"), `Button` (`label`, `action`,
`params`), `TextField` (`name`, `placeholder`; its value goes with the next action as
`params.fields[name]`), `List` (`bind`: a path to an array of strings in `state`).

## The API (relative URLs)

- `GET api/surfaces/:id` → `{ spec, version }`
- `PUT api/surfaces/:id` with a spec → replaces the screen (the client picks it up within a second)
- `POST api/surfaces/:id/actions` `{ action, params }` → runs a built-in action and returns the new spec.
  Built-ins: `set` `{ path, value }`, `push` `{ path, value }` (appends to an array), `increment` `{ path }`.
  A Button may name any action: unknown ones are recorded in `state.actions` for the agent to read.

Try it: `run_app`, then `http_request` `PUT api/surfaces/main` with a new spec, and
`GET api/surfaces/main` to read what people did (`state.actions`).
