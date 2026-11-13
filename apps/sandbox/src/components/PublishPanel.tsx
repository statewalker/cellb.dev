import { Radio, Server, Unplug } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type HostedApp,
  hostName,
  type Publisher,
  type PublishState,
} from "@/sandbox/mesh/publish";

/**
 * Publishing this tab in an HTTPeers mesh: its hub (apps/sandbox-hub) gives invitations, and the
 * members it invited reach the running app and the IDE's tools here, as their role allows.
 */
export function PublishPanel(props: {
  publisher: Publisher;
  state: PublishState;
  /** The project's name, and its deployable folder (Ship → Build). */
  name: string;
  build(opts?: { withData?: boolean }): Promise<{ files: Map<string, Uint8Array> }>;
  /** Public: the hub's gateway serves the app (and its deploys) to non-members; never the tools. */
  isPublic: boolean;
  onPublic(on: boolean): void;
  log(text: string, level?: "info" | "error"): void;
}) {
  const { publisher, state } = props;
  const [invitation, setInvitation] = useState("");
  const [busy, setBusy] = useState(false);
  const [hosted, setHosted] = useState<HostedApp[]>();
  const [deploying, setDeploying] = useState(false);
  const [withData, setWithData] = useState(false);
  const live = state.phase === "live";
  const act = (label: string, fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      props.log(`mesh: ${label}: ${(err as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-3" data-testid="publish-panel">
      <h2 className="flex items-center gap-2 font-semibold">
        <Radio className="size-4" /> Publish (HTTPeers)
      </h2>
      <p className="text-muted-foreground">
        This tab joins a mesh as a member and serves the members its hub invited, each as their role
        allows: <code className="font-mono">/app/</code> the running app (viewer),{" "}
        <code className="font-mono">/mcp/read</code> the IDE's tools read-only (agent),{" "}
        <code className="font-mono">/mcp/edit</code> the tools that change the project (editor). Run
        a hub with{" "}
        <code className="font-mono">pnpm --filter @statewalker/cellb-sandbox-hub start</code> and
        open the link it prints, or paste an invitation here.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="publish-status">
        <span className={live ? "text-emerald-600" : "text-muted-foreground"}>
          {live ? `Published (${state.hubLink ?? "?"} link to the hub)` : state.phase}
        </span>
        {state.peerId && (
          <span className="text-muted-foreground font-mono" title="This tab's peer id">
            {state.peerId}
          </span>
        )}
      </div>
      {live && state.hubLink === "relay" && (
        <p className="text-amber-600 text-xs">
          The hub is reached through the public relay only: other members cannot reach this tab (
          {state.note ?? "the WebRTC upgrade to the hub failed"}).
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-destructive text-xs">
          {state.error}
        </p>
      )}
      {state.controls.join && (
        <div className="flex flex-wrap items-end gap-2">
          <input
            aria-label="Invitation"
            className="bg-background h-8 min-w-64 flex-1 rounded-md border px-2 font-mono text-xs"
            placeholder="a join link or blob from sandbox-hub"
            value={invitation}
            onChange={(e) => setInvitation(e.target.value)}
          />
          <Button
            size="sm"
            disabled={busy || !invitation.trim()}
            onClick={act("join", async () => {
              const text = invitation.trim();
              const blob = text.includes("join=")
                ? (new URL(text).searchParams.get("join") ?? text)
                : text;
              await publisher.join(blob);
              setInvitation("");
            })}
          >
            <Radio /> Join and publish
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {state.controls.disconnect && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={act("disconnect", () => publisher.disconnect())}
          >
            <Unplug /> Stop publishing
          </Button>
        )}
        {state.controls.reconnect && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={act("reconnect", () => publisher.reconnect())}
          >
            <Radio /> Publish again
          </Button>
        )}
        {state.controls.reset && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title="Forget this tab's identity in the mesh (a new invitation is needed to join again)"
            onClick={act("reset", () => publisher.resetIdentity())}
          >
            Leave the mesh
          </Button>
        )}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          className="accent-primary"
          aria-label="Public"
          checked={props.isPublic}
          onChange={(e) => props.onPublic(e.target.checked)}
        />
        Public: the hub's gateway (if it runs one) serves this app, and what you deploy, to anyone
        who has its address. The tools stay for members.
      </label>
      {live && (
        <div className="grid gap-2 rounded-md border px-3 py-2" data-testid="hub-host">
          <p className="text-muted-foreground text-xs">
            Deploy to the hub: the deployable build runs on CellB in the hub's Node process, served
            to the mesh's viewers at{" "}
            <code className="font-mono">
              /peers/{state.hubPeerId?.slice(0, 12)}…/apps/{hostName(props.name)}/
            </code>
            , its Durable Objects' data kept from one deploy to the next.
          </p>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="accent-primary"
              aria-label="Deploy with the preview's data"
              checked={withData}
              onChange={(e) => setWithData(e.target.checked)}
            />
            With the preview's data: the hosted app's Durable Objects start from it (what it held on
            the hub is replaced)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || deploying}
              onClick={act("deploy", async () => {
                setDeploying(true);
                try {
                  const build = await props.build({ withData });
                  const app = await publisher.deploy(props.name, build.files, {
                    public: props.isPublic,
                    replaceData: withData,
                  });
                  props.log(
                    `mesh: ${app.name} deployed to the hub (${app.release}, ${app.files} files)`,
                  );
                  setHosted(await publisher.apps());
                } finally {
                  setDeploying(false);
                }
              })}
            >
              <Server /> {deploying ? "Building and deploying…" : "Deploy to the hub"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={act("list", async () => setHosted(await publisher.apps()))}
            >
              What it hosts
            </Button>
          </div>
          {hosted && (
            <ul className="text-xs" data-testid="hosted-apps">
              {hosted.length === 0 && <li className="text-muted-foreground">Nothing yet.</li>}
              {hosted.map((a) => (
                <li key={a.name}>
                  <code className="font-mono">{a.name}</code> {a.release}, {a.files} files,{" "}
                  {a.public ? "public, " : ""}
                  {new Date(a.deployedAt).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {live && state.peerId && (
        <p className="text-muted-foreground text-xs" data-testid="publish-reach">
          Members reach it at <code className="font-mono">/peers/{state.peerId}/app/</code>. On a
          computer,{" "}
          <code className="font-mono">
            pnpm --filter @statewalker/cellb-sandbox-hub bridge &lt;invitation&gt;
          </code>{" "}
          serves it at localhost: the app for a browser, the MCP endpoint for a desktop agent.
        </p>
      )}
    </section>
  );
}
