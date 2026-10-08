const sessionInput = {
  sessionID: { type: "string", minLength: 1 },
};

export const DevServersRpc = {
  id: "dev-servers",
  methods: {
    list: {
      input: {
        type: "object",
        properties: sessionInput,
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          directory: { type: "string" },
          servers: { type: "array", items: { type: "object", additionalProperties: true } },
          updatedAt: { type: "string" },
          notice: { type: "string" },
        },
        required: ["directory", "servers", "updatedAt"],
        additionalProperties: false,
      },
    },
    stop: {
      input: {
        type: "object",
        properties: {
          ...sessionInput,
          token: { type: "string", minLength: 1 },
          force: { type: "boolean" },
        },
        required: ["sessionID", "token"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          stopped: { type: "boolean" },
          message: { type: "string" },
        },
        required: ["stopped", "message"],
        additionalProperties: false,
      },
    },
  },
  events: {},
};

export interface ServerEndpoint {
  port: number;
  protocol: "http" | "https" | "tcp";
  urls: { url: string; label: "Local" | "LAN" }[];
  bindings: string[];
}

export interface DevServer {
  pid: number;
  token: string;
  name: string;
  directory: string;
  endpoints: ServerEndpoint[];
}

export interface ServerSnapshot {
  directory: string;
  servers: DevServer[];
  updatedAt: string;
  notice?: string;
}
