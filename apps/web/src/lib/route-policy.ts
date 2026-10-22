/**
 * Whether a butler route may start by itself.
 *
 * Classification and authorization are different decisions. A confident music-making request
 * should flow straight into the target worker; only actions that can destroy or substantially
 * rewrite the user's work need an explicit confirmation card.
 */
import { isWorkerTarget, type RoutedAction } from "./butler-command.ts";

export type { RoutedAction } from "./butler-command.ts";

const DESTRUCTIVE_ACTION =
  /(删除|清空|移除|覆盖|替换|移动|移到|重命名|改名|永久|不可恢复|批量修改|delete|remove|clear|overwrite|replace|move|rename|erase|wipe)/i;

export function routeNeedsConfirmation(route: RoutedAction): boolean {
  if (!isWorkerTarget(route.target)) return false;
  return route.confidence < 0.7 || DESTRUCTIVE_ACTION.test(route.actionSummary);
}

export function routeCanRunDirectly(route: RoutedAction): boolean {
  return isWorkerTarget(route.target) && !routeNeedsConfirmation(route);
}
