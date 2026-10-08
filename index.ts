import { createServerMonitor, resolveProjectDirectory } from "./discovery.mjs";
import { DevServersRpc } from "./rpc.ts";

interface ServerContext {
  session: {
    get(input: { sessionID: string }): Promise<{ location: { directory: string } }>;
  };
  rpc: {
    register(definition: typeof DevServersRpc, handlers: Record<string, (
      input: unknown,
      request: { signal: AbortSignal },
    ) => Promise<unknown>>): Promise<{ dispose(): Promise<void> }>;
  };
}

export default {
  id: "local.dev-servers",
  async setup(ctx: ServerContext) {
    const monitor = createServerMonitor();
    const scope = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID });
      return resolveProjectDirectory(session.location.directory);
    };
    const registration = await ctx.rpc.register(DevServersRpc, {
      list: async (input, request) => {
        const { sessionID } = input as { sessionID: string };
        const directory = await scope(sessionID);
        request.signal.throwIfAborted();
        return monitor.list(directory, request.signal);
      },
      stop: async (input, request) => {
        const { sessionID, token, force = false } = input as {
          sessionID: string;
          token: string;
          force?: boolean;
        };
        const directory = await scope(sessionID);
        request.signal.throwIfAborted();
        return monitor.stop(directory, token, force, request.signal);
      },
    });
    return () => registration.dispose();
  },
};
