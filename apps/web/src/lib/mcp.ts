export type McpTool = { name: string; description?: string };

export type ServerInfo = {
  id: string;
  label: string;
  description?: string;
  connected: boolean;
  tools: McpTool[];
  error?: string;
};

export type BridgeInfo = {
  servers: ServerInfo[];
  home: string;
  workspaces: string;
};

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export async function fetchBridge(): Promise<BridgeInfo> {
  return json<BridgeInfo>(await fetch("/api/servers"));
}

export async function callTool<T = unknown>(server: string, tool: string, args: unknown): Promise<T> {
  const data = await json<{ result: T; isError?: boolean }>(
    await fetch("/api/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server, tool, arguments: args }),
    }),
  );
  return data.result;
}
