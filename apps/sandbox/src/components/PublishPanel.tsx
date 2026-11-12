import { Radio, Unplug } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Publisher, PublishState } from "@/sandbox/mesh/publish";

/**
 * Publishing this tab in an HTTPeers mesh: its hub (apps/sandbox-hub) gives invitations, and the
 * members it invited reach the running app and the IDE's tools here, as their role allows.
 */
export function PublishPanel(props: {
  publisher: Publisher;
  state: PublishState;
  log(text: string, level?: "info" | "error"): void;
}) {
  const { publisher, state } = props;
  const [invitation, setInvitation] = useState("");
  const [busy, setBusy] = useState(false);
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
