import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const COMMAND_TIMEOUT_MS = 4_000;
const PROJECT_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "composer.json", "Gemfile"];

async function run(file, args, signal, emptyExit = false) {
  return new Promise((accept, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal, env: { ...process.env, LC_ALL: "C" } }, (error, stdout, stderr) => {
      if (!error || (emptyExit && error.code === 1 && !stderr.trim())) return accept(stdout);
      reject(new Error(`${basename(file)}: ${stderr.trim() || error.message}`));
    });
  });
}

export function isWithin(directory, root) {
  const path = relative(root, directory);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

// Git worktrees have a .git file, which is deliberately treated like a directory.
export async function resolveProjectDirectory(directory) {
  const start = await realpath(directory);
  let packageRoot;
  for (let current = start; current !== dirname(current); current = dirname(current)) {
    if (current === homedir()) break;
    if (await exists(resolve(current, ".git"))) return current;
    if (!packageRoot && (await Promise.all(PROJECT_MARKERS.map((name) => exists(resolve(current, name))))).some(Boolean)) {
      packageRoot = current;
    }
  }
  return packageRoot ?? start;
}

export function parseListeners(output) {
  const sockets = [];
  let pid;
  let command = "";
  let family = "IPv4";
  for (const field of output.split(/\0|\n/)) {
    const value = field.slice(1);
    if (field[0] === "p") pid = Number(value);
    if (field[0] === "c") command = value;
    if (field[0] === "f") family = "IPv4";
    if (field[0] === "t") family = value;
    if (field[0] !== "n" || !pid) continue;
    const match = value.match(/^(.*):(\d+)$/);
    if (!match) continue;
    const port = Number(match[2]);
    if (port < 1 || port > 65535) continue;
    sockets.push({ pid, command, family, address: match[1].replace(/^\[|\]$/g, ""), port });
  }
  return sockets;
}

function parseDirectories(output) {
  const result = new Map();
  let pid;
  for (const field of output.split(/\0|\n/)) {
    if (field[0] === "p") pid = Number(field.slice(1));
    if (field[0] === "n" && pid) result.set(pid, field.slice(1));
  }
  return result;
}

export function parseProcesses(output) {
  const result = new Map();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    if (!match) continue;
    const [, pid, parent, uid, startedAt, command] = match;
    result.set(Number(pid), { pid: Number(pid), parent: Number(parent), uid: Number(uid), startedAt, command });
  }
  return result;
}

export function isProtected(processInfo, socketCommand) {
  return processInfo.pid === process.pid || processInfo.pid === process.ppid ||
    /^opencode(?:\.exe)?$/i.test(socketCommand) ||
    /(?:language-server|tsserver|typingsInstaller|eslintServer|pyright|rust-analyzer|gopls)(?:\b|\.)/i.test(processInfo.command);
}

function nameFor(command) {
  for (const [pattern, name] of [
    [/\bastro\b/i, "Astro"], [/\bnext(?:-server)?\b/i, "Next.js"], [/\bvite\b/i, "Vite"],
    [/\bnuxt\b/i, "Nuxt"], [/\bwebpack\b/i, "Webpack"], [/\buvicorn\b/i, "Uvicorn"],
    [/\bgunicorn\b/i, "Gunicorn"], [/\bmanage\.py\b/i, "Django"], [/\bhttp-server\b/i, "HTTP server"],
  ]) {
    if (pattern.test(command)) return name;
  }
  return basename(command.split(/\s+/)[0]) || "Server";
}

function fingerprint(info, directory) {
  return createHash("sha256").update(JSON.stringify([info.pid, info.uid, info.startedAt, info.command, directory])).digest("hex");
}

async function readListeners(signal) {
  return parseListeners(await run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F0pcnft"], signal, true));
}

async function readProcesses(pids, signal) {
  if (!pids.length) return { info: new Map(), directories: new Map() };
  const selection = pids.join(",");
  const [processes, directories] = await Promise.all([
    run("/bin/ps", ["-p", selection, "-o", "pid=,ppid=,uid=,lstart=,args="], signal, true),
    run("/usr/sbin/lsof", ["-a", "-p", selection, "-d", "cwd", "-F0pn"], signal, true),
  ]);
  return { info: parseProcesses(processes), directories: parseDirectories(directories) };
}

export function localAddresses(interfaces = networkInterfaces()) {
  return [...new Set(Object.entries(interfaces).flatMap(([name, addresses]) => {
    if (/^(utun|tun|tap|awdl|llw|docker|veth)/.test(name)) return [];
    return (addresses ?? []).filter((item) => !item.internal && item.family === "IPv4").map((item) => item.address);
  }))];
}

function reachable(host, port, signal) {
  return new Promise((accept) => {
    if (signal?.aborted) return accept(false);
    const socket = net.connect({ host, port });
    const finish = (result) => { signal?.removeEventListener("abort", abort); socket.destroy(); accept(result); };
    const abort = () => finish(false);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setTimeout(350, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function respondsToHttp(host, port, secure, signal) {
  return new Promise((accept) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      accept(result);
    };
    const request = (secure ? https : http).request({
      host, port, method: "HEAD", path: "/", agent: false, signal,
      // Probe only the discovered local listener. Browsers still validate its certificate.
      rejectUnauthorized: false,
    }, (response) => { response.resume(); finish(true); });
    // An absolute deadline also covers TLS handshakes and peers that trickle bytes.
    timer = setTimeout(() => finish(false), 800);
    request.once("error", () => finish(false));
    request.end();
  });
}

export function candidatesFor(sockets, lan) {
  const result = new Map();
  const add = (host, label, display = host) => result.set(host, { host, label, display });
  for (const socket of sockets) {
    const { address, family } = socket;
    if (address === "*" || address === "0.0.0.0" || address === "::") {
      if (family === "IPv6" || address === "::") add("::1", "Local", "[::1]");
      // A reachability check below prevents advertising IPv4 for IPv6-only listeners.
      add("127.0.0.1", "Local", "localhost");
      for (const ip of lan) add(ip, "LAN");
    } else if (address === "::1") {
      add(address, "Local", "[::1]");
    } else if (address.startsWith("127.")) {
      add(address, "Local", address === "127.0.0.1" ? "localhost" : address);
    } else if (!address.includes("%")) {
      add(address, "LAN", address.includes(":") ? `[${address}]` : address);
    }
  }
  return [...result.values()].sort((left, right) => {
    const rank = (item) => item.display === "localhost" ? 0 : item.label === "Local" ? 1 : 2;
    return rank(left) - rank(right) || left.display.localeCompare(right.display);
  });
}

async function endpointFor(sockets, lan, signal, allSockets) {
  const port = sockets[0].port;
  const candidates = candidatesFor(sockets, lan).filter((candidate) => {
    const family = net.isIP(candidate.host) === 4 ? "IPv4" : "IPv6";
    const binds = (socket) => socket.family === family &&
      (socket.address === "*" || socket.address === "0.0.0.0" || socket.address === "::" || socket.address === candidate.host);
    // A successful connection alone cannot attribute IPv4 to an IPv6 listener:
    // another project may own the same port on IPv4 while this one is IPv6-only.
    return sockets.some(binds) || !allSockets.some((socket) => socket.pid !== sockets[0].pid && socket.port === port && binds(socket));
  });
  const reachableCandidates = (await Promise.all(candidates.map(async (item) => (
    await reachable(item.host, port, signal) ? item : undefined
  )))).filter(Boolean);
  const probe = reachableCandidates[0];
  let protocol = "tcp";
  if (probe) {
    if (await respondsToHttp(probe.host, port, false, signal)) protocol = "http";
    else if (await respondsToHttp(probe.host, port, true, signal)) protocol = "https";
  }
  // Prefer localhost over a duplicate loopback URL, but keep IPv6-only servers visible.
  const visible = reachableCandidates.filter((item) => item.host !== "::1" || !reachableCandidates.some((other) => other.host === "127.0.0.1"));
  return {
    port, protocol,
    bindings: [...new Set(sockets.map((socket) => `${socket.address}:${port}`))],
    urls: protocol === "tcp" ? [] : visible.map((item) => ({ url: `${protocol}://${item.display}:${port}`, label: item.label })),
  };
}

async function mapLimited(items, concurrency, fn) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await fn(items[index]);
    }
  }));
  return result;
}

export function createServerMonitor() {
  const issued = new Map();
  const stopping = new Set();
  return {
    async list(directory, signal) {
      const root = await realpath(directory);
      const snapshot = { directory: root, servers: [], updatedAt: new Date().toISOString() };
      if (process.platform !== "darwin") return { ...snapshot, notice: "Local server discovery currently supports macOS." };
      if (root === homedir() || root === dirname(root)) return { ...snapshot, notice: "Open a project directory to discover servers." };
      const sockets = await readListeners(signal);
      const pids = [...new Set(sockets.map((socket) => socket.pid))];
      const { info, directories } = await readProcesses(pids, signal);
      const groups = [];
      for (const pid of pids) {
        const processInfo = info.get(pid);
        const cwd = directories.get(pid);
        const listeners = sockets.filter((socket) => socket.pid === pid);
        if (!processInfo || processInfo.uid !== process.getuid() || !cwd || isProtected(processInfo, listeners[0].command)) continue;
        const canonical = await realpath(cwd).catch(() => undefined);
        if (!canonical || !isWithin(canonical, root)) continue;
        groups.push({ processInfo, directory: canonical, listeners });
      }
      const lan = localAddresses();
      snapshot.servers = await mapLimited(groups, 6, async (group) => {
        const { processInfo, directory: cwd, listeners } = group;
        const ports = [...new Set(listeners.map((socket) => socket.port))].sort((a, b) => a - b);
        const endpoints = await Promise.all(ports.map((port) => endpointFor(listeners.filter((socket) => socket.port === port), lan, signal, sockets)));
        const token = fingerprint(processInfo, cwd);
        issued.set(token, { pid: processInfo.pid, directory: cwd, root, ports, expiresAt: Date.now() + 120_000 });
        return { pid: processInfo.pid, token, name: nameFor(processInfo.command), directory: cwd, endpoints };
      });
      for (const [token, item] of issued) if (item.expiresAt < Date.now()) issued.delete(token);
      snapshot.servers.sort((a, b) => a.endpoints[0].port - b.endpoints[0].port || a.pid - b.pid);
      signal?.throwIfAborted();
      return snapshot;
    },
    async stop(directory, token, force = false, signal) {
      const root = await realpath(directory);
      const item = issued.get(token);
      if (!item || item.root !== root || item.expiresAt < Date.now()) throw new Error("Server selection expired. Refresh the list and try again.");
      if (stopping.has(token)) throw new Error("This server is already stopping.");
      stopping.add(token);
      try {
        const sockets = (await readListeners(signal)).filter((socket) => socket.pid === item.pid);
        const { info, directories } = await readProcesses([item.pid], signal);
        const current = info.get(item.pid);
        if (!current) return { stopped: true, message: "Server has already exited." };
        const rawCwd = directories.get(item.pid);
        const cwd = rawCwd ? await realpath(rawCwd).catch(() => undefined) : undefined;
        if (!cwd || current.uid !== process.getuid() || isProtected(current, sockets[0]?.command ?? "") ||
          !isWithin(cwd, root) || fingerprint(current, cwd) !== token) {
          throw new Error("Process identity or project ownership changed. Refusing to stop it.");
        }
        if (!sockets.length) return { stopped: true, message: "Server is no longer listening." };
        if (!sockets.some((socket) => item.ports.includes(socket.port))) throw new Error("Server ports changed. Refresh before stopping it.");
        signal?.throwIfAborted();
        try { process.kill(item.pid, force ? "SIGKILL" : "SIGTERM"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
        // Never signal a process group: it may contain another server or the user's shell.
        for (let attempt = 0; attempt < 8; attempt++) {
          await delay(200, undefined, { signal });
          const remaining = (await readListeners(signal)).filter((socket) => socket.pid === item.pid);
          if (!remaining.length) {
            issued.delete(token);
            return { stopped: true, message: force ? "Server force-stopped." : "Server stopped." };
          }
          const state = await readProcesses([item.pid], signal);
          const processInfo = state.info.get(item.pid);
          if (!processInfo || processInfo.startedAt !== current.startedAt || processInfo.command !== current.command) {
            issued.delete(token);
            return { stopped: true, message: "Original server exited." };
          }
        }
        return { stopped: false, message: "Server did not stop gracefully." };
      } finally {
        stopping.delete(token);
      }
    },
  };
}
