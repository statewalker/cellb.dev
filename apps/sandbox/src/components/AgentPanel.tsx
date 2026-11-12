import { Bot, ChevronRight, Copy, Send, Square, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AgentEvent } from "@/sandbox/agent/events";
import type { AgentMode, FlueAgent, ModelChoice } from "@/sandbox/agent/flue";

type ProviderKind = ModelChoice["provider"];

const DEFAULT_MODELS: Record<ProviderKind, string> = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-oss:20b",
};

const MODES: { value: AgentMode; label: string; hint: string }[] = [
  { value: "yolo", label: "Edit", hint: "read and write the project (within the scope)" },
  { value: "plan", label: "Plan", hint: "read everything, write only under /plans/" },
  { value: "readonly", label: "Read-only", hint: "read and answer: every write is refused" },
];

type Settings = ModelChoice & {
  remember: boolean;
  mode: AgentMode;
  scope: string;
  /** The session's model budget: turns and tokens (empty: unlimited). */
  maxTurns: string;
  maxTokens: string;
};

const limit = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null);

type Entry = { key: number } & (
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; output?: string; ok?: boolean }
  | { kind: "note"; text: string; error?: boolean }
);

let entryKey = 0;
const nextKey = () => ++entryKey;

const SETTINGS_KEY = "cellb-sandbox-agent";

function loadSettings(): Settings {
  const fallback: Settings = {
    provider: "anthropic",
    model: DEFAULT_MODELS.anthropic,
    apiKey: "",
    baseUrl: "",
    remember: false,
    mode: "yolo",
    scope: "",
    maxTurns: "",
    maxTokens: "",
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s.remember ? s : { ...s, apiKey: "" }));
  } catch {}
}

export function AgentPanel(props: {
  agent: FlueAgent;
  /** Called in the click that sends: asks for write access to the folder while a click allows it. */
  prepare(): Promise<void>;
  hasProject: boolean;
  mcpUrl?: string;
  webmcp: boolean;
  /** The rights of the IDE's tools for other agents (their own capability). */
  outsideMode: AgentMode;
  onOutsideMode(mode: AgentMode): void;
}) {
  const [settings, setSettings] = useState(loadSettings);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(
    () => settings.provider === "anthropic" && !settings.apiKey,
  );
  // One conversation per panel: the studio keeps its history (per capability).
  const conversation = useRef(crypto.randomUUID());
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => saveSettings(settings), [settings]);
  const count = entries.length;
  useEffect(() => {
    if (count) end.current?.scrollIntoView({ block: "end" });
  }, [count]);

  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const needsKey = settings.provider === "anthropic";
  const note = (text: string, error = false) =>
    setEntries((e) => [...e, { key: nextKey(), kind: "note", text, error }]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    if (needsKey && !settings.apiKey) return note("Add an API key first.", true);
    try {
      await props.prepare();
    } catch (err) {
      return note((err as Error).message, true);
    }
    setInput("");
    setBusy(true);
    setEntries((e) => [...e, { key: nextKey(), kind: "user", text }]);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const onEvent = (ev: AgentEvent) =>
      setEntries((list) => {
        switch (ev.type) {
          case "text":
            return [...list, { key: nextKey(), kind: "text", text: ev.text }];
          case "tool_call":
            return list.some((x) => x.kind === "tool" && x.id === ev.id)
              ? list
              : [
                  ...list,
                  { key: nextKey(), kind: "tool", id: ev.id, name: ev.name, input: ev.input },
                ];
          case "tool_result":
            return list.map((x) =>
              x.kind === "tool" && x.id === ev.id ? { ...x, output: ev.output, ok: ev.ok } : x,
            );
          case "error":
            return [...list, { key: nextKey(), kind: "note", text: ev.message, error: true }];
          case "done":
            return [
              ...list,
              {
                key: nextKey(),
                kind: "note",
                text: `done in ${ev.steps} turn${ev.steps === 1 ? "" : "s"}`,
              },
            ];
        }
      });
    try {
      const r = await props.agent.send(text, {
        mode: settings.mode,
        scope: settings.scope,
        model: settings,
        session: conversation.current,
        budget: { turns: limit(settings.maxTurns), tokens: limit(settings.maxTokens) },
        onEvent,
        signal: ctrl.signal,
      });
      if (r.error) onEvent({ type: "error", message: r.error });
      onEvent({ type: "done", steps: r.turns });
      const left = r.budget;
      if (left && (left.turnsLeft !== null || left.tokensLeft !== null))
        note(`budget left: ${left.turnsLeft ?? "∞"} turns · ${left.tokensLeft ?? "∞"} tokens`);
    } catch (err) {
      onEvent({ type: "error", message: (err as Error).message });
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  const field = "bg-background h-8 rounded-md border px-2";
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-panel">
      <details
        className="border-b px-3 py-2 text-sm"
        open={showSettings}
        onToggle={(e) => setShowSettings((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer select-none font-medium">
          Flue agent:{" "}
          <span className="font-mono text-xs">
            {settings.provider} · {settings.model || DEFAULT_MODELS[settings.provider]} ·{" "}
            {MODES.find((m) => m.value === settings.mode)?.label}
            {settings.scope ? ` · /${settings.scope.replace(/^\/+/, "")}` : ""}
          </span>
        </summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1">
            <span className="text-muted-foreground text-xs">Provider</span>
            <select
              aria-label="Provider"
              className={field}
              value={settings.provider}
              onChange={(e) => {
                const provider = e.target.value as ProviderKind;
                update({ provider, model: DEFAULT_MODELS[provider] });
              }}
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI-compatible (local or gateway)</option>
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground text-xs">Model</span>
            <input
              aria-label="Model"
              className={`${field} font-mono text-xs`}
              value={settings.model}
              onChange={(e) => update({ model: e.target.value })}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground text-xs">Rights (the agent's capability)</span>
            <select
              aria-label="Rights"
              className={field}
              value={settings.mode}
              onChange={(e) => update({ mode: e.target.value as AgentMode })}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}: {m.hint}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground text-xs">
              Scope: a folder (empty: the whole project)
            </span>
            <input
              aria-label="Scope"
              className={`${field} font-mono text-xs`}
              placeholder="client"
              value={settings.scope}
              onChange={(e) => update({ scope: e.target.value })}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground text-xs">
              Budget: model turns per session (empty: unlimited)
            </span>
            <input
              aria-label="Max turns"
              inputMode="numeric"
              className={`${field} font-mono text-xs`}
              placeholder="unlimited"
              value={settings.maxTurns}
              onChange={(e) => update({ maxTurns: e.target.value })}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground text-xs">Budget: tokens per session</span>
            <input
              aria-label="Max tokens"
              inputMode="numeric"
              className={`${field} font-mono text-xs`}
              placeholder="unlimited"
              value={settings.maxTokens}
              onChange={(e) => update({ maxTokens: e.target.value })}
            />
          </label>
          {settings.provider === "openai" && (
            <label className="grid gap-1 sm:col-span-2">
              <span className="text-muted-foreground text-xs">
                Endpoint (Chat Completions API root)
              </span>
              <input
                aria-label="Endpoint"
                className={`${field} font-mono text-xs`}
                placeholder="http://localhost:11434/v1"
                value={settings.baseUrl ?? ""}
                onChange={(e) => update({ baseUrl: e.target.value })}
              />
            </label>
          )}
          <label className="grid gap-1 sm:col-span-2">
            <span className="text-muted-foreground text-xs">
              API key {settings.provider === "openai" && "(optional)"}: sent only to the model's
              API, from this tab
            </span>
            <input
              aria-label="API key"
              type="password"
              autoComplete="off"
              className={`${field} font-mono text-xs`}
              value={settings.apiKey}
              onChange={(e) => update({ apiKey: e.target.value })}
            />
          </label>
          <label className="text-muted-foreground flex items-center gap-2 text-xs sm:col-span-2">
            <input
              type="checkbox"
              className="accent-primary"
              checked={settings.remember}
              onChange={(e) => update({ remember: e.target.checked })}
            />
            Remember the key in this browser
          </label>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          A Flue agent in a Durable Object on CellB, in this tab. Its tools hold a Biscuit
          capability: the rights and the scope are checked on every file it touches, and its writes
          come back to the project here. Other agents use the IDE's tools through{" "}
          <code className="font-mono">window.cellbSandbox</code>
          {props.webmcp && ", WebMCP"}
          {props.mcpUrl && (
            <>
              {" "}
              and MCP at{" "}
              <button
                type="button"
                className="hover:text-foreground inline-flex items-center gap-1 font-mono underline-offset-2 hover:underline"
                title="Copy the MCP endpoint (reachable from this browser's tabs)"
                onClick={() => navigator.clipboard?.writeText(props.mcpUrl as string)}
              >
                {props.mcpUrl} <Copy className="size-3" />
              </button>
            </>
          )}
          .
        </p>
        <label className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 text-xs">
          Rights of other agents (their tools' capability):
          <select
            aria-label="Rights of other agents"
            className="bg-background h-7 rounded-md border px-1"
            value={props.outsideMode}
            onChange={(e) => props.onOutsideMode(e.target.value as AgentMode)}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </details>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3 text-sm" aria-live="polite">
        {entries.length === 0 && (
          <div className="text-muted-foreground mx-auto max-w-prose space-y-2 py-6 text-center">
            <Bot className="mx-auto size-6" />
            <p>
              Ask for a change: “add a delete button to each task”, “add an endpoint that counts
              done tasks and test it”. The agent works with its capability, runs the app and checks
              it; its changes come back here (and to disk when a folder is open).
            </p>
          </div>
        )}
        <ol className="space-y-2" data-testid="agent-transcript">
          {entries.map((e) => (
            <li key={e.key}>
              {e.kind === "user" && (
                <div className="bg-primary/10 ml-auto max-w-[85%] rounded-lg px-3 py-2 whitespace-pre-wrap">
                  {e.text}
                </div>
              )}
              {e.kind === "text" && <div className="max-w-[95%] whitespace-pre-wrap">{e.text}</div>}
              {e.kind === "note" && (
                <div
                  className={cn("text-xs", e.error ? "text-destructive" : "text-muted-foreground")}
                >
                  {e.text}
                </div>
              )}
              {e.kind === "tool" && (
                <details className="bg-muted/40 rounded-md border px-2 py-1 font-mono text-xs">
                  <summary className="flex cursor-pointer items-center gap-1.5 select-none">
                    <ChevronRight className="size-3" />
                    <Wrench className="size-3" />
                    <span data-testid="tool-call">{e.name}</span>
                    <span className="text-muted-foreground truncate">{summarize(e.input)}</span>
                    <span
                      data-testid="tool-status"
                      className={cn(
                        "ml-auto",
                        e.ok === undefined
                          ? "text-muted-foreground"
                          : e.ok
                            ? "text-emerald-600"
                            : "text-destructive",
                      )}
                    >
                      {e.ok === undefined ? "…" : e.ok ? "ok" : "error"}
                    </span>
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap">
                    {JSON.stringify(e.input, null, 2)}
                  </pre>
                  {e.output && (
                    <pre className="mt-1 max-h-64 overflow-auto border-t pt-1 whitespace-pre-wrap">
                      {e.output}
                    </pre>
                  )}
                </details>
              )}
            </li>
          ))}
        </ol>
        <div ref={end} />
      </div>

      <form
        className="flex items-end gap-2 border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Message to the agent"
          className="bg-background focus-visible:ring-ring/40 min-h-10 flex-1 resize-y rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
          rows={2}
          placeholder={props.hasProject ? "Ask the agent…" : "Open a folder or a template first"}
          disabled={!props.hasProject}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy ? (
          <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
            <Square /> Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!props.hasProject || !input.trim()}>
            <Send /> Send
          </Button>
        )}
      </form>
    </div>
  );
}

function summarize(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.path ?? o.pattern ?? o.command ?? o.query;
  return typeof v === "string" ? v : "";
}
