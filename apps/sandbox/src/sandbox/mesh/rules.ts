// The sandbox mesh's rules: one document, read by its hub (apps/sandbox-hub, which mints tokens
// stating roles and checks invitations against them) and by every sandbox tab that publishes
// (whose mounts are guarded by `withAccess` with these rules). Policy names capabilities, never
// roles; `std:` is the mesh protocol's, `sandbox:` the sandbox's.
//
//   viewer     opens the running app        /app/… (a tab), /apps/<name>/… (hosted by the hub)
//   agent      + reads the project (MCP)    /mcp/read
//   editor     + changes it (MCP)           /mcp/edit
//   admin      + the hub's admin endpoints, deploys
//   publisher  a tab that serves (its app, its tools by the roles above)
//   deployer   + deploys its builds to the hub: /host/apps/<name>. A deploy RUNS CODE ON THE HUB'S
//              MACHINE, in the hub's process: give it only to whom you would give a shell there.
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
    // A publishing sandbox: a member that serves, and ships its builds to the hub.
    'role("member") <- role("publisher");',
    'capability("sandbox:app")         <- role("publisher");',
    'role("publisher") <- role("deployer");',
    'capability("sandbox:host.deploy") <- role("deployer");',
    'capability("sandbox:host.deploy") <- role("admin");',
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
    // The hub as a host: hosted apps (any method: they have their own APIs), what is hosted, deploys.
    'allow if capability("sandbox:app"), resource($r), $r.starts_with("/apps/")' +
      ' or capability("sandbox:app"), resource("/apps");',
    'allow if capability("sandbox:app"), operation("GET"), resource("/host/apps");',
    'allow if capability("sandbox:host.deploy"), resource($r), $r.starts_with("/host/apps/");',
  ],
};

export const MESH_ROLES = ["viewer", "agent", "editor", "admin", "publisher", "deployer"] as const;
export type MeshRole = (typeof MESH_ROLES)[number];

/** What a publishing sandbox advertises: other members find it by this id. */
export const SANDBOX_ADVERT = "cellb-sandbox";
