/**
 * Talking to the bridge about providers.
 *
 * Every call that could touch a key goes through the bridge — the browser never holds one, so a
 * stolen profile or a shared project file is not a stolen secret. These wrappers exist so the
 * settings page reads like a form and not like a pile of fetches.
 */
import type { CapabilityKind, ProviderProfile } from "./providers";

export type CredentialInfo = { name: string; source: "file" | "env" | "missing"; masked: string; variable?: string };

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

/** Which credentials exist (names, sources, masks — never values). */
export async function listCredentials(): Promise<CredentialInfo[]> {
  const response = await fetch("/api/agent/credentials");
  const payload = (await response.json().catch(() => ({}))) as { credentials?: CredentialInfo[] };
  return payload.credentials ?? [];
}

export async function saveCredential(name: string, value: string): Promise<CredentialInfo> {
  return post<CredentialInfo>("/api/agent/credentials", { name, value });
}

export async function deleteCredential(name: string): Promise<void> {
  await fetch(`/api/agent/credentials?name=${encodeURIComponent(name)}`, { method: "DELETE" });
}

/** The provider's own model list, asked for when a dropdown opens. */
export async function listProviderModels(
  provider: Pick<ProviderProfile, "baseUrl" | "credentialRef" | "protocol">,
): Promise<{ models: string[]; error?: string }> {
  return post<{ models: string[]; error?: string }>("/api/agent/providers/models", {
    baseUrl: provider.baseUrl,
    credentialRef: provider.credentialRef,
    protocol: provider.protocol,
  });
}

/** The smallest request that proves a role works. */
export async function testRole(options: {
  provider: Pick<ProviderProfile, "baseUrl" | "credentialRef" | "protocol">;
  capability: CapabilityKind;
  model: string;
  voice?: string;
}): Promise<{ ok: boolean; detail: string; ms?: number }> {
  return post<{ ok: boolean; detail: string; ms?: number }>("/api/agent/providers/test", {
    baseUrl: options.provider.baseUrl,
    credentialRef: options.provider.credentialRef,
    protocol: options.provider.protocol,
    capability: options.capability,
    model: options.model,
    ...(options.voice === undefined ? {} : { voice: options.voice }),
  });
}
