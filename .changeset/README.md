# Changesets

Each change to a published package (today `@statewalker/cellb`) carries a changeset:
`pnpm changeset` asks which packages it touches, how (patch, minor, major) and what to say in
the changelog. Releases are made by hand from a local checkout (see `packages/cellb/README.md`,
"Releasing"); CI never publishes.
