import { execFile } from "node:child_process";
import type { MouseEvent } from "@opentui/core";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { DevServersRpc, type DevServer, type ServerSnapshot } from "./rpc";

const REFRESH_INTERVAL_MS = 5_000;

function openUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only web server URLs can be opened.");
  return new Promise((accept, reject) => {
    execFile("/usr/bin/open", [url], { timeout: 5_000 }, (error) => error ? reject(error) : accept());
  });
}

function clicked(event: MouseEvent, action: () => void) {
  if (event.button !== 0 || event.isDragging) return;
  event.preventDefault();
  event.stopPropagation();
  action();
}

function DevServers(props: { plugin: any; sessionID: string }) {
  const { plugin } = props;
  const rpc = plugin.client.rpc(DevServersRpc);
  const [snapshot, setSnapshot] = createSignal<ServerSnapshot>();
  const [failure, setFailure] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal<string>();
  const [forceToken, setForceToken] = createSignal<string>();
  let active = true;
  let generation = 0;
  let pending = false;

  const notifyError = (error: unknown) => plugin.ui.toast.show({
    title: "Dev servers",
    message: error instanceof Error ? error.message : "Server action failed",
    variant: "error",
  });

  const refresh = async () => {
    if (pending || !active) return;
    pending = true;
    const version = generation;
    const sessionID = props.sessionID;
    try {
      const next = await rpc.list({ sessionID }) as ServerSnapshot;
      if (active && version === generation && sessionID === props.sessionID) {
        setSnapshot(next);
        setFailure("");
      }
    } catch (error) {
      if (active && version === generation) {
        setFailure(error instanceof Error ? error.message : "Server discovery failed");
      }
    } finally {
      if (version === generation) {
        pending = false;
        setLoading(false);
      }
    }
  };

  const stopServer = async (server: DevServer, force = false) => {
    if (busy()) return;
    const sessionID = props.sessionID;
    const version = generation;
    setBusy(server.token);
    try {
      const ports = server.endpoints.map((endpoint) => endpoint.port).join(", ");
      const confirmed = await plugin.ui.dialog.confirm({
        title: force ? "Force-stop server?" : "Stop server?",
        message: `${server.name} · PID ${server.pid} · port${server.endpoints.length > 1 ? "s" : ""} ${ports}\n${server.directory}\n\n${force ? "SIGKILL stops it immediately, without cleanup." : "Stop this process with SIGTERM. All its local and LAN URLs will stop."}`,
        label: { confirm: force ? "Force-stop" : "Stop", cancel: "Cancel" },
      });
      if (!confirmed || !active || version !== generation || sessionID !== props.sessionID) return;
      const result = await rpc.stop({ sessionID, token: server.token, force }) as { stopped: boolean; message: string };
      if (!active || version !== generation) return;
      setForceToken(result.stopped ? undefined : server.token);
      plugin.ui.toast.show({
        title: "Dev servers",
        message: result.stopped ? result.message : `${result.message} Use Force to stop it immediately.`,
        variant: result.stopped ? "success" : "warning",
      });
      await refresh();
    } catch (error) {
      notifyError(error);
    } finally {
      if (active && version === generation) setBusy(undefined);
    }
  };

  const open = async (url: string) => {
    try { await openUrl(url); } catch (error) { notifyError(error); }
  };

  const manage = async () => {
    await refresh();
    const servers = snapshot()?.servers ?? [];
    if (!servers.length) {
      plugin.ui.toast.show({ message: failure() || snapshot()?.notice || "No running servers in this project." });
      return;
    }
    const sessionID = props.sessionID;
    const version = generation;
    const token = await plugin.ui.dialog.select({
      title: "Project servers",
      options: servers.map((server) => ({
        title: `${server.name} · ${server.endpoints.map((endpoint) => endpoint.port).join(", ")}`,
        description: `PID ${server.pid} · ${server.directory}`,
        value: server.token,
      })),
    });
    if (!active || version !== generation || sessionID !== props.sessionID) return;
    const server = servers.find((item) => item.token === token);
    if (!server) return;
    const action = await plugin.ui.dialog.select({
      title: `${server.name} · PID ${server.pid}`,
      options: [
        ...server.endpoints.flatMap((endpoint) => endpoint.urls.map((item) => ({
          title: item.url,
          description: `Open ${item.label.toLowerCase()} URL in your browser`,
          value: item.url,
        }))),
        { title: "Stop server", description: "Graceful shutdown (SIGTERM)", value: "stop" },
        ...(forceToken() === server.token ? [{ title: "Force-stop server", description: "Immediate shutdown (SIGKILL)", value: "force" }] : []),
      ],
    });
    if (!active || version !== generation || sessionID !== props.sessionID) return;
    if (action === "stop" || action === "force") await stopServer(server, action === "force");
    else if (action) await open(action);
  };

  plugin.keymap.layer(() => ({
    mode: "global",
    commands: [
      { id: "local.dev-servers.manage", title: "Dev servers: Open or stop a server", group: "Dev servers", palette: true, slash: { name: "servers" }, run: manage },
      { id: "local.dev-servers.refresh", title: "Dev servers: Refresh", group: "Dev servers", palette: true, run: refresh },
    ],
  }));

  createEffect(() => {
    // A moved session can keep its ID while changing projects.
    const location = plugin.data.session.get(props.sessionID)?.location?.directory;
    void location;
    generation++;
    pending = false;
    setSnapshot(undefined);
    setFailure("");
    setBusy(undefined);
    setForceToken(undefined);
    setLoading(true);
    void refresh();
  });
  const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  onCleanup(() => { active = false; generation++; clearInterval(timer); });

  return (
    <box flexDirection="column" gap={1} paddingTop={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={plugin.theme.text.base}><strong>Dev servers</strong></text>
        <text fg={plugin.theme.text.muted} selectable={false} onMouseUp={(event) => clicked(event, () => void refresh())}>[Refresh]</text>
      </box>
      <Show when={loading() && !snapshot()}><text fg={plugin.theme.text.muted}>Finding servers…</text></Show>
      <Show when={failure()}><text fg={plugin.theme.text.muted}>{failure()}</text></Show>
      <Show when={snapshot()?.notice}><text fg={plugin.theme.text.muted}>{snapshot()?.notice}</text></Show>
      <Show when={!loading() && snapshot() && !snapshot()!.servers.length && !snapshot()?.notice && !failure()}>
        <text fg={plugin.theme.text.muted}>No running servers</text>
      </Show>
      <For each={snapshot()?.servers ?? []}>
        {(server) => (
          <box flexDirection="column" gap={0}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={plugin.theme.text.base}><strong>{server.name}</strong></text>
              <text
                fg={plugin.theme.text.base}
                selectable={false}
                onMouseUp={(event) => clicked(event, () => void stopServer(server, forceToken() === server.token))}
              >{busy() === server.token ? "Stopping…" : forceToken() === server.token ? "[Force]" : "[Stop]"}</text>
            </box>
            <text fg={plugin.theme.text.muted}>PID {server.pid}</text>
            <For each={server.endpoints}>
              {(endpoint) => (
                <box flexDirection="column">
                  <Show when={endpoint.protocol === "tcp"}>
                    <text fg={plugin.theme.text.muted}>TCP :{endpoint.port} (HTTP not detected)</text>
                  </Show>
                  <For each={endpoint.urls}>
                    {(item) => (
                      <text fg={plugin.theme.text.base} selectable={false} onMouseUp={(event) => clicked(event, () => void open(item.url))}>
                        <u>{item.url.replace(/^https?:\/\//, "")}</u> {item.label === "LAN" ? "· LAN" : ""}{endpoint.protocol === "https" ? " · HTTPS" : ""}
                      </text>
                    )}
                  </For>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}

export default {
  id: "local.dev-servers.tui",
  setup(context: any) {
    return context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }: { sessionID: string }) => <DevServers plugin={context} sessionID={sessionID} />,
    });
  },
};
