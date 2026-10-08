# OpenCode dev servers

Discover and manage the current project's running servers from the OpenCode V2
terminal sidebar. macOS only. No API keys or personal paths are required.

## Install

For a local checkout, add its absolute path to `plugins` in
`~/.config/opencode/opencode.jsonc` (preserve your other settings):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-dev-servers"]
}
```

After publishing this repository on GitHub, replace `YOUR_USERNAME` and run:

```sh
opencode plugin add github:YOUR_USERNAME/opencode-dev-servers
```

To pin a release, use `github:YOUR_USERNAME/opencode-dev-servers#v0.1.0`
once that tag exists. Use `opencode plugin check` to check package updates,
and `opencode plugin update` to apply them.

Restart the OpenCode service and reopen the TUI after installing:

```sh
opencode service restart
```

The package exports both the server plugin and `./tui`; OpenCode loads the
terminal component automatically. Do not also load a copy from
`~/.config/opencode/plugins/`. This is a full server-and-TUI plugin, not a
CLI-only plugin to configure in `cli.json`.

## Requirements

- OpenCode V2 with plugin RPC, sidebar slots, and OpenTUI 0.5.10-compatible APIs.
  OpenCode V1 is not supported.
- macOS with `lsof`, `ps`, and `open` in their standard system locations.
- A local OpenCode service: discovery runs on the server, not the TUI device.
  Remote OpenCode services are not supported.
- Set `session.sidebar` to `"auto"` in `~/.config/opencode/cli.json` and use a
  terminal wide enough to show the sidebar. `"hide"` hides this plugin too.

## Features

- Detects TCP listeners owned by your user, with a working directory inside the
  current session's project. Git roots and worktrees are kept separate; without
  Git, the nearest package/project manifest determines the root.
- Groups URLs and ports by server process. Servers launched outside OpenCode are
  included. Language servers and OpenCode's own service are excluded.
- Refreshes every five seconds while the sidebar is mounted.
- Probes local listeners with HEAD requests to distinguish HTTP, HTTPS, and
  non-HTTP TCP. LAN URLs are shown only for network-capable bindings, with an
  additional local TCP check. A firewall can still block access from other devices.
- Clicking a URL uses macOS `open` to open the default browser. HTTPS detection
  accepts local self-signed certificates; your browser still applies its normal
  certificate checks.
- Stop asks for confirmation, verifies process identity, UID, project directory,
  and listening ports, then sends SIGTERM to that PID only. If it is still
  listening, Force becomes available with a separate confirmation for SIGKILL.
  No process groups, parent shells, or unrelated servers are terminated.
- Use `/servers` or the **Dev servers: Open or stop a server** palette command
  for keyboard access. The panel also has a clickable Refresh control.

## Limitations

No Docker, remote hosts, or Windows/Linux support. A process that changes its
working directory outside the project cannot be attributed reliably and is not
shown. Supervisors may restart a stopped child; the replacement will reappear.
The plugin does not stop supervisors or shells automatically. No servers are
stopped when the plugin unloads.

## Development

Use Node.js 22.18+ and pnpm. No build step is required; OpenCode loads the
TypeScript entrypoints. OpenTUI and Solid are host peers, with pinned development
copies for typechecking.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm pack
```

Tests create and terminate only their own temporary server processes. They do
not open a browser or stop existing development servers.

Tests use your OS temporary directory. Set `OPENCODE_TEST_TMPDIR` to an existing
directory to override it. Integration tests run only on macOS and require
OpenSSL to generate a temporary self-signed certificate.

## Privacy and safety

The plugin reads local process metadata, inspects TCP listeners, and sends local
TCP/HTTP/HTTPS probes. It does not upload project information or store credentials.
LAN URLs do not expose a loopback-only server or change any bind address. Stop
controls terminate only a selected, revalidated process after confirmation.

## License

No license has been selected. All rights reserved. `private: true` prevents
accidental npm publication; it does not prevent GitHub installation or determine
GitHub repository visibility. Choose a license before distributing this project
as open source.

See the [OpenCode V2 plugin documentation](https://opencode.ai/v2/docs/plugins).
