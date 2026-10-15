/**
 * 通话五态的**类型**（F-1）。
 *
 * 为什么与词表分居两个文件：tests/call-words.test.mjs 钉着一条守卫——通话条（Composer.tsx）
 * 不许引用词表模块，谁引谁就是把状态词又搬回 dock（F-2 刚收敛完的老病）。但它同时必须知道
 * 「一共有哪些态」，否则 props 里的联合类型只能手抄一份、永远是第三个真相。
 * 于是：类型住这里（两处都引，只有一份），词住 call-words.ts（只有球字幕与 App 引）。
 */
export type CallState = "listening" | "thinking" | "speaking" | "unclear" | "offline";
