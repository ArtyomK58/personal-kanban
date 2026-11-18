import type { Priority, TaskSummary } from "./api";

type OrderableTask = Pick<TaskSummary, "priority"> & Partial<Pick<TaskSummary, "frozen">>;
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

function rank(task?: OrderableTask): number {
  return task?.frozen ? 3 : PRIORITY_RANK[task?.priority ?? "normal"];
}

/** Keep saved order within each group, including a user's drag preview. */
export function sortTaskIdsForBoard(ids: readonly number[], tasks: ReadonlyMap<number, OrderableTask>): number[] {
  return [...ids].sort((a, b) => rank(tasks.get(a)) - rank(tasks.get(b)));
}

/** Save against a peer of the same group; other groups may have interleaved stored positions. */
export function boardMovePlacement(ids: readonly number[], activeId: number, tasks: ReadonlyMap<number, OrderableTask>): { before_id: number } | { after_id: number } | { index: number } {
  const group = rank(tasks.get(activeId));
  const peers = ids.filter((id) => rank(tasks.get(id)) === group);
  const i = peers.indexOf(activeId);
  if (i < 0) throw new Error("Moved task is missing from the destination column");
  if (peers[i + 1] !== undefined) return { before_id: peers[i + 1] };
  if (peers[i - 1] !== undefined) return { after_id: peers[i - 1] };
  return { index: 0 };
}
