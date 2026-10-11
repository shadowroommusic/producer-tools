/**
 * 悬浮球 v5 的位置纯逻辑（lib/orb-position.ts）：夹取/吸附/保护退避/持久化。
 * 离屏可验——viewport 与受保护矩形都由测试喂进来，不碰 window/document。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ORB_SIZE,
  POSITION_KEY,
  clampToViewport,
  defaultPosition,
  loadPosition,
  savePosition,
  snapToViewport,
} from "../src/lib/orb-position.ts";

const VIEWPORT = { width: 1440, height: 900 };

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
};

test("clampToViewport：越界拉回 12px 边距，界内不动", () => {
  assert.deepEqual(clampToViewport(-500, 400, VIEWPORT), { x: 12, y: 400 });
  assert.deepEqual(clampToViewport(1300, 99999, VIEWPORT), { x: 1300, y: VIEWPORT.height - ORB_SIZE - 12 });
  const inside = clampToViewport(300, 300, VIEWPORT);
  assert.deepEqual(inside, { x: 300, y: 300 });
});

test("snapToViewport：离边 <48px 吸到边缘（12px 边距），中间位置不动", () => {
  const snapped = snapToViewport({ x: 40, y: 400 }, VIEWPORT);
  assert.equal(snapped.x, 12, "离左边 28px 应吸到 12px 边距");
  const right = snapToViewport({ x: VIEWPORT.width - ORB_SIZE - 40, y: 400 }, VIEWPORT);
  assert.equal(right.x, VIEWPORT.width - ORB_SIZE - 12, "离右边不足 48px 应吸右缘");
  const middle = snapToViewport({ x: 500, y: 400 }, VIEWPORT);
  assert.equal(middle.x, 500, "屏中间不吸");
});

test("snapToViewport：吸附点压到受保护控件时退让，永不落在控件矩形上", () => {
  // 左缘吸附点 (12,400) 上有一枚控件，退让后的位置不得再与任何控件相交
  const controls = [{ x: 0, y: 380, w: 120, h: 48 }];
  const moved = snapToViewport({ x: 40, y: 400 }, VIEWPORT, controls);
  const intersects = controls.some(
    (r) => !(moved.x > r.x + r.w || moved.x + ORB_SIZE < r.x || moved.y > r.y + r.h || moved.y + ORB_SIZE < r.y),
  );
  assert.equal(intersects, false, `退让后的位置 ${JSON.stringify(moved)} 仍压控件`);
  assert.ok(moved.x === 12 || moved.y !== 400, "要么还贴着左缘，要么已垂直让开");
});

test("位置持久化：存取往返一致；坏 JSON / 缺字段 / 非 JSON 都当没有", () => {
  const storage = memoryStorage();
  savePosition(storage, { x: 88, y: 240 });
  assert.equal(storage.getItem(POSITION_KEY), '{"x":88,"y":240}');
  assert.deepEqual(loadPosition(storage), { x: 88, y: 240 });
  storage.setItem(POSITION_KEY, "{not json");
  assert.equal(loadPosition(storage), null);
  storage.setItem(POSITION_KEY, '{"x":88}');
  assert.equal(loadPosition(storage), null);
  storage.setItem(POSITION_KEY, '{"x":"88","y":240}');
  assert.equal(loadPosition(storage), null);
  assert.equal(loadPosition(storage), null); // 空库 → null
});

test("defaultPosition：右下角 24px，不压受保护控件", () => {
  const plain = defaultPosition(VIEWPORT);
  assert.deepEqual(plain, { x: VIEWPORT.width - ORB_SIZE - 24, y: VIEWPORT.height - ORB_SIZE - 24 });
  const cornerControls = [{ x: VIEWPORT.width - 100, y: VIEWPORT.height - 60, w: 100, h: 60 }];
  const avoided = defaultPosition(VIEWPORT, cornerControls);
  const intersects = cornerControls.some(
    (r) => !(avoided.x > r.x + r.w || avoided.x + ORB_SIZE < r.x || avoided.y > r.y + r.h || avoided.y + ORB_SIZE < r.y),
  );
  assert.equal(intersects, false, `默认位 ${JSON.stringify(avoided)} 压到了右下角控件`);
});
