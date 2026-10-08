import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import {
  candidatesFor, createServerMonitor, isProtected, isWithin, localAddresses,
  parseListeners, parseProcesses, resolveProjectDirectory,
} from "./discovery.mjs";

const TEMP_BASE = process.env.OPENCODE_TEST_TMPDIR || tmpdir();

test("lsof parser handles dual-stack listeners, multiple ports, and spaces", () => {
  const sockets = parseListeners("p42\0cnode\0\nf10\0tIPv6\0n*:3000\0\nf11\0tIPv4\0n127.0.0.1:3001\0\np73\0cPython\0\nf6\0tIPv6\0n[::1]:8000\0\n");
  assert.deepEqual(sockets, [
    { pid: 42, command: "node", family: "IPv6", address: "*", port: 3000 },
    { pid: 42, command: "node", family: "IPv4", address: "127.0.0.1", port: 3001 },
    { pid: 73, command: "Python", family: "IPv6", address: "::1", port: 8000 },
  ]);
});

test("ps parser preserves identity and command arguments", () => {
  const processInfo = parseProcesses(" 42  1  501 Thu Oct  8 08:44:57 2026 node /a project/server.js\n").get(42);
  assert.equal(processInfo.startedAt, "Thu Oct  8 08:44:57 2026");
  assert.equal(processInfo.command, "node /a project/server.js");
  assert.equal(processInfo.uid, 501);
});

test("project matching uses path boundaries rather than string prefixes", () => {
  assert.equal(isWithin("/projects/app", "/projects/app"), true);
  assert.equal(isWithin("/projects/app/packages/web", "/projects/app"), true);
  assert.equal(isWithin("/projects/app-other", "/projects/app"), false);
  assert.equal(isWithin("/projects/other", "/projects/app"), false);
});

test("OpenCode and language servers cannot be selected for stopping", () => {
  const info = { pid: 999999, command: "node server.js" };
  assert.equal(isProtected(info, "opencode.exe"), true);
  assert.equal(isProtected({ ...info, command: "node typescript-language-server --stdio" }, "node"), true);
  assert.equal(isProtected(info, "node"), false);
});

test("LAN candidates depend on the actual bind address", () => {
  const lan = ["192.168.1.13"];
  const socket = { pid: 1, command: "node", port: 3000, family: "IPv4" };
  assert.deepEqual(candidatesFor([{ ...socket, address: "127.0.0.1" }], lan), [
    { host: "127.0.0.1", display: "localhost", label: "Local" },
  ]);
  assert.deepEqual(candidatesFor([{ ...socket, address: "192.168.1.13" }], lan), [
    { host: "192.168.1.13", display: "192.168.1.13", label: "LAN" },
  ]);
  assert.deepEqual(candidatesFor([{ ...socket, address: "*" }], lan).map((item) => item.host), ["127.0.0.1", "192.168.1.13"]);
});

test("LAN discovery excludes loopback and tunnels", () => {
  assert.deepEqual(localAddresses({
    lo0: [{ internal: true, family: "IPv4", address: "127.0.0.1" }],
    en0: [{ internal: false, family: "IPv4", address: "192.168.1.13" }],
    utun0: [{ internal: false, family: "IPv4", address: "10.8.0.1" }],
  }), ["192.168.1.13"]);
});

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(TEMP_BASE, "dev-servers-test-")));
  const root = join(base, "app with spaces");
  const other = join(base, "app with spaces-other");
  const nested = join(root, "packages", "web");
  await mkdir(nested, { recursive: true });
  await mkdir(other);
  await writeFile(join(root, ".git"), "gitdir: /not-needed-for-discovery\n");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { root, other, nested };
}

async function startServer(t, cwd, options = {}) {
  const code = `
    const http = require('node:http');
    const https = require('node:https');
    const net = require('node:net');
    const fs = require('node:fs');
    const opts = JSON.parse(process.argv[1]);
    if (opts.stubborn) process.on('SIGTERM', () => {});
    process.on('message', (message) => {
      if (message.chdir) { process.chdir(message.chdir); process.send({ changed: true }); }
    });
    const servers = [];
    const portList = [];
    for (let i = 0; i < (opts.count || 1); i++) {
      const handler = (req, res) => { res.end('ok'); };
      const server = opts.tcp ? net.createServer((s) => s.destroy()) : opts.secure ?
        https.createServer({ key: fs.readFileSync(opts.key), cert: fs.readFileSync(opts.cert) }, handler) : http.createServer(handler);
      servers.push(server);
      server.listen({ port: opts.port || 0, host: opts.host || '127.0.0.1', ipv6Only: opts.ipv6Only || false }, () => {
        portList.push(server.address().port);
        if (portList.length === (opts.count || 1)) process.send({ ports: portList });
      });
    }
  `;
  const child = spawn(process.execPath, ["-e", code, JSON.stringify(options)], { cwd, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  const message = await Promise.race([
    once(child, "message").then(([value]) => value),
    once(child, "exit").then(() => { throw new Error(`Fixture exited: ${stderr}`); }),
    delay(5_000).then(() => { throw new Error("Fixture timed out"); }),
  ]);
  return { child, ports: message.ports };
}

test("project root resolves nested directories and .git worktree files", async (t) => {
  const { root, nested } = await fixture(t);
  await writeFile(join(nested, "package.json"), "{}\n");
  assert.equal(await resolveProjectDirectory(nested), root);
});

test("discovers separate servers and ports, excludes unrelated projects, stops only selected PID", { skip: process.platform !== "darwin" }, async (t) => {
  const { root, nested, other } = await fixture(t);
  const first = await startServer(t, root, { count: 2 });
  const second = await startServer(t, nested);
  const unrelated = await startServer(t, other);
  const monitor = createServerMonitor();
  const snapshot = await monitor.list(root);
  assert.equal(snapshot.servers.length, 2);
  const selected = snapshot.servers.find((server) => server.pid === first.child.pid);
  assert.deepEqual(selected.endpoints.map((endpoint) => endpoint.port).sort((a, b) => a - b), [...first.ports].sort((a, b) => a - b));
  for (const endpoint of selected.endpoints) {
    assert.equal(endpoint.protocol, "http");
    assert.deepEqual(endpoint.urls, [{ url: `http://localhost:${endpoint.port}`, label: "Local" }]);
  }
  await assert.rejects(monitor.stop(other, selected.token), /selection expired/i);
  await assert.rejects(monitor.stop(root, "unknown-token"), /selection expired/i);
  const stopped = await monitor.stop(root, selected.token);
  assert.equal(stopped.stopped, true);
  const remaining = await monitor.list(root);
  assert.deepEqual(remaining.servers.map((server) => server.pid), [second.child.pid]);
  assert.doesNotThrow(() => process.kill(unrelated.child.pid, 0));
});

test("wildcard binding publishes applicable LAN URLs", { skip: process.platform !== "darwin" }, async (t) => {
  const { root } = await fixture(t);
  const { child } = await startServer(t, root, { host: "0.0.0.0" });
  const snapshot = await createServerMonitor().list(root);
  const endpoint = snapshot.servers.find((server) => server.pid === child.pid).endpoints[0];
  assert.equal(endpoint.urls[0].label, "Local");
  for (const address of localAddresses()) assert.ok(endpoint.urls.some((item) => item.url === `http://${address}:${endpoint.port}` && item.label === "LAN"));
});

test("IPv6-only binding does not publish unsupported IPv4 addresses", { skip: process.platform !== "darwin" }, async (t) => {
  const { root } = await fixture(t);
  const { child } = await startServer(t, root, { host: "::", ipv6Only: true });
  const snapshot = await createServerMonitor().list(root);
  const endpoint = snapshot.servers.find((server) => server.pid === child.pid).endpoints[0];
  assert.deepEqual(endpoint.urls, [{ url: `http://[::1]:${endpoint.port}`, label: "Local" }]);
});

test("IPv6 listener does not advertise another project's IPv4 server on the same port", { skip: process.platform !== "darwin" }, async (t) => {
  const { root, other } = await fixture(t);
  const { child, ports } = await startServer(t, root, { host: "::", ipv6Only: true });
  await startServer(t, other, { host: "127.0.0.1", port: ports[0] });
  const snapshot = await createServerMonitor().list(root);
  const endpoint = snapshot.servers.find((server) => server.pid === child.pid).endpoints[0];
  assert.deepEqual(endpoint.urls, [{ url: `http://[::1]:${endpoint.port}`, label: "Local" }]);
});

test("non-HTTP listeners remain visible but are not browser links", { skip: process.platform !== "darwin" }, async (t) => {
  const { root } = await fixture(t);
  const { child } = await startServer(t, root, { tcp: true });
  const snapshot = await createServerMonitor().list(root);
  const endpoint = snapshot.servers.find((server) => server.pid === child.pid).endpoints[0];
  assert.equal(endpoint.protocol, "tcp");
  assert.deepEqual(endpoint.urls, []);
});

test("HTTPS discovery accepts a self-signed local certificate", { skip: process.platform !== "darwin" }, async (t) => {
  const { root } = await fixture(t);
  const key = join(root, "test-key.pem");
  const cert = join(root, "test-cert.pem");
  await promisify(execFile)("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"]);
  const { child } = await startServer(t, root, { secure: true, key, cert });
  const snapshot = await createServerMonitor().list(root);
  const endpoint = snapshot.servers.find((server) => server.pid === child.pid).endpoints[0];
  assert.equal(endpoint.protocol, "https");
  assert.deepEqual(endpoint.urls, [{ url: `https://localhost:${endpoint.port}`, label: "Local" }]);
});

test("stop refuses a process that moved outside the project", { skip: process.platform !== "darwin" }, async (t) => {
  const { root, other } = await fixture(t);
  const { child } = await startServer(t, root);
  const monitor = createServerMonitor();
  const server = (await monitor.list(root)).servers.find((item) => item.pid === child.pid);
  const changed = once(child, "message");
  child.send({ chdir: other });
  await changed;
  await assert.rejects(monitor.stop(root, server.token), /ownership changed/i);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});

test("force-stop is separate from graceful termination", { skip: process.platform !== "darwin" }, async (t) => {
  const { root } = await fixture(t);
  const { child } = await startServer(t, root, { stubborn: true });
  const monitor = createServerMonitor();
  const server = (await monitor.list(root)).servers.find((item) => item.pid === child.pid);
  assert.equal((await monitor.stop(root, server.token)).stopped, false);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  assert.equal((await monitor.stop(root, server.token, true)).stopped, true);
});
