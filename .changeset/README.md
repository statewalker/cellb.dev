# Changesets

Each change to a published package (today `@statewalker/cellb`) carries a changeset:
`pnpm changeset` asks which packages it touches, how (patch, minor, major) and what to say in
the changelog. Releases go through CI (see `packages/cellb/README.md`, "Releasing"): merged changesets become a
"chore: version packages" pull request, and merging it publishes after a maintainer approves.
Without a changeset, the release planner writes a patch for every package whose published
contents changed since npm's `latest` (a minor, on 0.x, when a dependency moved to another
breaking line).
