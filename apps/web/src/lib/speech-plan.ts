/**
 * 「这一通电话用哪个声音」只有一个答案。
 *
 * 以前有两个读法：通话读 `shadowroom.voice`（系统音色）或 `shadowroom.tts.voice`（供应商音色），
 * 设置页试听又自己拼一份请求；结果就是「试听好听、通话里还是旧音色 / 干脆不出声」。
 * 这里把选择收成一个 `SpeechPlan`：供应商在不在、音色是哪个、实例 key 是什么，都在这一处决定。
 *
 * key 是给调用方重建 provider 用的：**key 变了就必须换实例**，否则旧音色会一直用到通话结束。
 * 纯函数，存储可注入，Node 可直接测。
 */
import { capabilityTarget, roleTarget, type ModelSettings } from "./providers.ts";
import { createBridgeTTS, createSystemTTS, type TTSProvider } from "./tts.ts";

/** 系统音色的存储键（通话和设置页共用）。 */
export const SYSTEM_VOICE_KEY = "shadowroom.voice";
/** 供应商音色的存储键（通话和设置页共用）。 */
export const PROVIDER_VOICE_KEY = "shadowroom.tts.voice";

/** 只需要 getItem，测试不必装整个 localStorage。 */
export type SpeechStorage = { getItem: (key: string) => string | null };

export type SystemSpeechPlan = {
  kind: "system";
  /** 实例 key：`system:<voice>`，音色变了 key 就变。 */
  key: string;
  voiceId?: string;
};

export type BridgeSpeechPlan = {
  kind: "bridge";
  /** 实例 key：供应商 + 模型 + 凭证 + 音色。 */
  key: string;
  providerId: string;
  providerName: string;
  baseUrl: string;
  credentialRef: string | null;
  protocol: string;
  model: string;
  voice?: string;
};

export type SpeechPlan = SystemSpeechPlan | BridgeSpeechPlan;

function defaultStorage(): SpeechStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function systemKey(voiceId: string): string {
  return `system:${voiceId}`;
}

function bridgeKey(providerId: string, model: string, credentialRef: string | null, voice: string): string {
  return `bridge:${providerId}:${model}:${credentialRef ?? ""}:${voice}`;
}

/**
 * 按设置决定这一通电话的声音。
 * @param settings - 当前模型设置（角色绑定以它为准）。
 * @param storage - 音色来源；测试注入。默认 localStorage，缺失时当作"没选音色"。
 */
export function resolveSpeechPlan(settings: ModelSettings, storage: SpeechStorage | null = defaultStorage()): SpeechPlan {
  const read = (key: string) => storage?.getItem(key) ?? "";
  const target = roleTarget(settings, "tts");
  if (target === undefined) {
    const voiceId = read(SYSTEM_VOICE_KEY);
    return { kind: "system", key: systemKey(voiceId), ...(voiceId === "" ? {} : { voiceId }) };
  }
  const capability = capabilityTarget(target.provider, "tts");
  const voice = read(PROVIDER_VOICE_KEY);
  return {
    kind: "bridge",
    key: bridgeKey(target.provider.id, target.model, target.provider.credentialRef, voice),
    providerId: target.provider.id,
    providerName: target.provider.name,
    baseUrl: capability.baseUrl,
    credentialRef: target.provider.credentialRef,
    protocol: capability.protocol,
    model: target.model,
    ...(voice === "" ? {} : { voice }),
  };
}

/**
 * 试听某个音色时的临时计划（不改变已保存的选择）。
 * 仍是同一个 plan 形状、同一条合成链路——只是把 voice 换成被点的那个。
 */
export function planWithVoice(plan: SpeechPlan, voice: string | undefined): SpeechPlan {
  const next = voice ?? "";
  if (plan.kind === "system") {
    return { kind: "system", key: systemKey(next), ...(next === "" ? {} : { voiceId: next }) };
  }
  return {
    kind: "bridge",
    key: bridgeKey(plan.providerId, plan.model, plan.credentialRef, next),
    providerId: plan.providerId,
    providerName: plan.providerName,
    baseUrl: plan.baseUrl,
    credentialRef: plan.credentialRef,
    protocol: plan.protocol,
    model: plan.model,
    ...(next === "" ? {} : { voice: next }),
  };
}

/** 按计划造一个 TTS provider；调用方负责在 plan.key 变化时重建。 */
export function createTTS(plan: SpeechPlan): TTSProvider {
  if (plan.kind === "system") return createSystemTTS();
  return createBridgeTTS({
    baseUrl: plan.baseUrl,
    credentialRef: plan.credentialRef,
    protocol: plan.protocol,
    model: plan.model,
    ...(plan.voice === undefined ? {} : { voice: plan.voice }),
  });
}
