/**
 * 哪一条回答属于这一轮。
 *
 * 通话里最贵的一次 bug 是「上一轮的答案被再念一遍」：说话 effect 认的是「消息列表里最后一条
 * assistant」，而用户说完话到 submit 之间还有一次渲染与一次上传，那时最后一条 assistant 仍是
 * 上一轮的长回答，于是它被从头念一遍——用户听到的就是"读很久很久"。
 *
 * 所以「本轮回答」必须是一个有名字的东西：submit 生成本轮 assistant id 时绑定它，朗读只认它。
 * 纯函数、无 React 依赖，Node 可直接测（S0-1 就是钉这条）。
 */

export type SpeechTurn = {
  /** 新回合开始（用户说完一句话）。清掉上一轮的 id 与已念句数。 */
  begin: () => void;
  /** 绑定本轮的回答 id（submit 里生成的那一个）。重复绑定同一个 id 不动进度。 */
  bind: (messageId: string) => void;
  /** 这条 assistant 消息是不是本轮允许朗读的那一条。 */
  owns: (messageId: string | null | undefined) => boolean;
  /** 本轮回答的 id；还没绑定时为 null。 */
  id: () => string | null;
  /** 已经交给朗读队列的句数（绝对计数，只由 advance 写）。 */
  spoken: () => number;
  /** 记下已入队的句数（传绝对数，不是增量）。 */
  advance: (count: number) => void;
  /** 还剩多少句没念；总数小于已念时返回 0。 */
  remaining: (total: number) => number;
};

export function createSpeechTurn(): SpeechTurn {
  let messageId: string | null = null;
  let spoken = 0;
  return {
    begin: () => {
      messageId = null;
      spoken = 0;
    },
    bind: (next) => {
      messageId = next;
    },
    owns: (candidate) => messageId !== null && candidate === messageId,
    id: () => messageId,
    spoken: () => spoken,
    advance: (count) => {
      if (count > spoken) spoken = count;
    },
    remaining: (total) => Math.max(0, total - spoken),
  };
}
