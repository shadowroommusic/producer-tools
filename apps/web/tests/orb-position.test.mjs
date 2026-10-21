/**
 * 悬浮球的位置纯逻辑（lib/orb-position.ts）：夹取/吸附/持久化。
 * 离屏可验——viewport 与坐标都由测试喂进来，不碰 window/document。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ORB_SCALE,
  MAX_ORB_SCALE,
  MIN_ORB_SCALE,
  ORB_ACTIVE_SIZE,
  ORB_MIN_HIT_PX,
  ORB_SCALE_KEY,
  ORB_SIZE,
  POSITION_KEY,
  clampOrbScale,
  clampToViewport,
  defaultPosition,
  loadOrbScale,
  loadPosition,
  orbHitSize,
  orbSizeAtScale,
  saveOrbScale,
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

test("大小偏好：25%–125% 五档、往返持久化、坏值回默认", () => {
  assert.equal(MIN_ORB_SCALE, 0.25);
  assert.equal(MAX_ORB_SCALE, 1.25);
  assert.equal(clampOrbScale(-4), 0.25);
  assert.equal(clampOrbScale(9), 1.25);
  assert.equal(clampOrbScale(0.62), 0.5, "菜单与持久化共用一档量化口径（0.62 → 0.5）");
  assert.equal(clampOrbScale(0.63), 0.75, "过半向上归档（0.63 → 0.75）");
  assert.equal(clampOrbScale(Number.NaN), DEFAULT_ORB_SCALE);
  assert.equal(orbSizeAtScale(0.25), 21);
  assert.equal(orbSizeAtScale(1), 84);
  assert.equal(orbSizeAtScale(1.25), 105);

  const storage = memoryStorage();
  assert.equal(loadOrbScale(storage), 1);
  saveOrbScale(storage, 1.25);
  assert.equal(storage.getItem(ORB_SCALE_KEY), "1.25");
  assert.equal(loadOrbScale(storage), 1.25);
  storage.setItem(ORB_SCALE_KEY, "not-a-number");
  assert.equal(loadOrbScale(storage), 1);
});

test("通话径按同一档比例缩放；命中圆不随视觉缩小到 32px 以下", () => {
  // 通话基准 124：0.25 档 = 31px、1 档 = 124px、1.25 档 = 155px（Kimi 主审口径）。
  assert.equal(orbSizeAtScale(0.25, ORB_ACTIVE_SIZE), 31);
  assert.equal(orbSizeAtScale(1, ORB_ACTIVE_SIZE), 124);
  assert.equal(orbSizeAtScale(1.25, ORB_ACTIVE_SIZE), 155);
  // 命中兜底：21px 视觉球仍有 32px 命中圆；≥32px 的视觉球命中=视觉。
  assert.equal(ORB_MIN_HIT_PX, 32);
  assert.equal(orbHitSize(orbSizeAtScale(0.25)), 32);
  assert.equal(orbHitSize(orbSizeAtScale(0.5)), 42);
  assert.equal(orbHitSize(orbSizeAtScale(1)), 84);
});

test("defaultPosition：首次出现在屏幕中下方，之后由用户自由摆放", () => {
  assert.deepEqual(defaultPosition(VIEWPORT), {
    x: (VIEWPORT.width - ORB_SIZE) / 2,
    y: VIEWPORT.height - ORB_SIZE - 140,
  });
  assert.deepEqual(defaultPosition({ width: 100, height: 100 }), { x: 12, y: 12 });
});

test("F-7：通话态 124px 也完整落在视口内（四角吸附 + 越界夹取）", () => {
  const ACTIVE = 124;
  // 按闲置尺寸夹到右/下缘的存档坐标，按通话尺寸重夹后不许出界
  const right = clampToViewport(VIEWPORT.width - ORB_SIZE - 12, VIEWPORT.height - ORB_SIZE - 12, VIEWPORT, ACTIVE);
  assert.equal(right.x, VIEWPORT.width - ACTIVE - 12);
  assert.equal(right.y, VIEWPORT.height - ACTIVE - 12);
  for (const corner of [
    { x: -100, y: -100 },
    { x: 9999, y: -100 },
    { x: -100, y: 9999 },
    { x: 9999, y: 9999 },
  ]) {
    const snapped = snapToViewport(corner, VIEWPORT, ACTIVE);
    assert.ok(snapped.x >= 12 && snapped.x + ACTIVE <= VIEWPORT.width - 12 + 0.001, JSON.stringify(snapped));
    assert.ok(snapped.y >= 12 && snapped.y + ACTIVE <= VIEWPORT.height - 12 + 0.001, JSON.stringify(snapped));
  }
});
