import { describe, expect, it } from "vitest";
import { boardMovePlacement, sortTaskIdsForBoard } from "../web/src/board-order";
import type { Priority } from "../web/src/api";

const tasks = new Map<number, { priority: Priority }>([[1, { priority: "low" }], [2, { priority: "high" }], [3, { priority: "normal" }], [4, { priority: "high" }], [5, { priority: "low" }]]);

describe("board priority order", () => {
  it("keeps frozen cards below active cards and saves moves against frozen peers", () => {
    const mixed = new Map([
      [1, { priority: "low", frozen: false }],
      [2, { priority: "high", frozen: true }],
      [3, { priority: "high", frozen: false }],
      [4, { priority: "normal", frozen: true }],
    ] as const);
    const ids = [4, 2, 1, 3];
    expect(sortTaskIdsForBoard(ids, mixed)).toEqual([3, 1, 4, 2]);
    expect(boardMovePlacement([3, 1, 2, 4], 2, mixed)).toEqual({ before_id: 4 });
    const thawed = new Map<number, { priority: Priority; frozen: boolean }>(mixed);
    thawed.set(2, { priority: "high", frozen: false });
    expect(sortTaskIdsForBoard(ids, thawed)).toEqual([2, 3, 1, 4]);
  });
  it("groups high, normal, low and keeps the saved order within each group", () => {
    const saved = [1, 4, 3, 2, 5];
    expect(sortTaskIdsForBoard(saved, tasks)).toEqual([4, 2, 3, 1, 5]);
    expect(saved).toEqual([1, 4, 3, 2, 5]);
  });
  it("keeps a manual peer reorder but does not let a low task precede a high task", () => {
    expect(sortTaskIdsForBoard([5, 2, 4, 3, 1], tasks)).toEqual([2, 4, 3, 5, 1]);
  });
  it("repositions a task after its priority changes", () => {
    const updated = new Map(tasks); updated.set(1, { priority: "high" });
    expect(sortTaskIdsForBoard([1, 4, 3, 2, 5], updated)).toEqual([1, 4, 2, 3, 5]);
  });
  it("saves the last high task after a high peer, never before a low task with an earlier stored position", () => {
    expect(boardMovePlacement([4, 2, 3, 1, 5], 2, tasks)).toEqual({ after_id: 4 });
    expect(boardMovePlacement([4, 2, 3, 1, 5], 4, tasks)).toEqual({ before_id: 2 });
  });
  it("uses a destination index when there are no peers of that priority", () => {
    expect(boardMovePlacement([4, 2, 3, 1, 5], 3, tasks)).toEqual({ index: 0 });
    expect(boardMovePlacement([1], 1, tasks)).toEqual({ index: 0 });
  });
});
