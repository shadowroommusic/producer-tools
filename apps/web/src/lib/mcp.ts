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

/**
 * 工具调用的硬超时（QA 发现 3）：桥进程不可达时 TCP 既不响应也不拒绝，没有这个超时的 fetch
 * 会永远挂着——用户看到的是「导出中…」卡住 300 秒（实测）也不报错。150s 盖过桥内部的
 * CALL_TIMEOUT_MS（120s，慢任务预算）；分轨这类更长的活走 job 轮询，不经过这里。
 */
const CALL_TIMEOUT_MS = 150_000;

export async function callTool<T = unknown>(server: string, tool: string, args: unknown): Promise<T> {
  let data: { result: T; isError?: boolean };
  try {
    data = await json<{ result: T; isError?: boolean }>(
      await fetch("/api/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ server, tool, arguments: args }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      }),
    );
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new Error(`工具桥没响应（pnpm serve 起了吗）——${server}.${tool} 等了 ${Math.round(CALL_TIMEOUT_MS / 1000)} 秒`);
    }
    throw cause;
  }
  return data.result;
}
