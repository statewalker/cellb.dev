// The sandbox mesh's rules: one document, read by its hub (apps/sandbox-hub, which mints tokens
// stating roles and checks invitations against them) and by every sandbox tab that publishes
// (whose mounts are guarded by `withAccess` with these rules). Policy names capabilities, never
// roles; `std:` is the mesh protocol's, `sandbox:` the sandbox's.
//
//   viewer  opens the running app        /app/…
//   agent   + reads the project (MCP)    /mcp/read
//   editor  + changes it (MCP)           /mcp/edit
//   admin   + the hub's admin endpoints
//
// Roles are given by the hub, in the invitation: `sandbox-hub invite editor`.

export const MESH_RULES = {
  version: 1,
  rules: [
    'capability("std:mesh.read")      <- role("member");',
    'capability("std:presence.write") <- role("member");',
    'capability("std:mesh.admin")     <- role("admin");',
    'capability("sandbox:app")        <- role("viewer");',
    'capability("sandbox:mcp.read")   <- role("agent");',
    'capability("sandbox:mcp.edit")   <- role("editor");',
    'role("member") <- role("viewer");',
    'role("viewer") <- role("agent");',
    'role("agent")  <- role("editor");',
    'role("editor") <- role("admin");',
    // A publishing sandbox: a member that serves, and reads the mesh to find its peers.
    'role("member") <- role("publisher");',
  ],
  policies: [
    'allow if capability("std:mesh.read"), resource("/.well-known")' +
      ' or capability("std:mesh.read"), resource($r), $r.starts_with("/.well-known/");',
    'allow if capability("std:mesh.admin"), resource("/admin")' +
      ' or capability("std:mesh.admin"), resource($r), $r.starts_with("/admin/");',
    'allow if capability("sandbox:app"), resource("/app")' +
      ' or capability("sandbox:app"), resource($r), $r.starts_with("/app/");',
    'allow if capability("sandbox:mcp.read"), resource("/mcp/read");',
    'allow if capability("sandbox:mcp.edit"), resource("/mcp/edit");',
  ],
};

export const MESH_ROLES = ["viewer", "agent", "editor", "admin", "publisher"] as const;
export type MeshRole = (typeof MESH_ROLES)[number];

/** What a publishing sandbox advertises: other members find it by this id. */
export const SANDBOX_ADVERT = "cellb-sandbox";
