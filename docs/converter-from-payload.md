# 接口稿：`converter.from_payload`（我们的 set → Rekordbox XML / Serato crate）

> 状态：**草稿，未实现**。本轮（S5）只出接口，DeepSeek 评审通过后单独开一刀实现。
> 依据全部为已上线的真实代码，行号随仓库演进可能漂移，以函数名为准：
> - `rekordbox-serato-bridge/src/shadow_rb_serato/serato_export.py`：`SetTrack`、`markers_for`、`convert_set`
> - `rekordbox-serato-bridge/src/shadow_rb_serato/rekordbox_export.py`：`to_rekordbox_xml`、`cue_kind_for_index`、`_beat_loop_size`、头部实机实测注释
> - `rekordbox-serato-bridge/src/shadow_rb_serato/model.py`：`CuePoint`、`PAD_KINDS`
> - `library/src/shadow_library/core.py`：`VENDOR_CUE_RULES`（vendor 映射唯一真相）、`cues_set` 校验

## 定位

converter 的第 7 个 MCP 工具（现有：preview_rekordbox_to_serato / preview_serato_to_rekordbox /
stage_serato_cues / list_sets / convert_set / convert_set_to_rekordbox）。

现有工具的面是「vendor 库 ↔ vendor 库」；`from_payload` 补的是「**我们自己的 set**（library 的
tracks + cues，DJ 页看板正在编辑的那种）→ vendor 出口」。两路出口复用现有 writer，不重写格式层：

- `target: "rekordbox"` → `to_rekordbox_xml`（DJ_PLAYLISTS XML，不碰任何数据库）
- `target: "serato"` → `convert_set`（复制音频 + Markers2/BeatGrid 标签 + `.crate` + manifest 回读校验）

## 输入

```jsonc
{
  "name": "周五夜 warm-up",              // set 名；出口的文件/目录/crate 名都用它
  "target": "rekordbox",                 // "rekordbox" | "serato"，必填
  "out_dir": "~/Documents/ShadowRoom/exports",  // 可空；rekordbox 写 <out_dir>/<name>.rekordbox.xml，
                                        // serato 在 <out_dir>/ShadowRoom/<name>/ 与 <out_dir>/_Serato_/Subcrates/
  "dry_run": true,                       // 默认 true：只返回写入计划与计数，不落盘（沿用 converter 全家默认 dry-run 的规矩）
  "tracks": [                            // 有序，出口顺序 = 数组顺序
    {
      "id": 8,                           // 可空；library track_id，报告里原样回显供对账
      "path": "/abs/path/to/tune.wav",   // 必填，唯一真源；不存在 → 该首 status=missing，不硬失败
      "title": "tune", "artist": "someone",
      "bpm": 128.0,                      // 可空
      "key": "Am",                       // 可空；rekordbox 记法（XML Tonality 直写）
      "duration_ms": 383000,             // 可空
      "beat_anchor_ms": 112,             // 可空；serato BeatGrid 锚点 / rekordbox TEMPO Inizio
      "cues": [                          // 可空；形状与 library cues_set 的入参完全一致
        { "position_ms": 1551, "kind": "cue",  "cue_type": "hot",    "slot": 0,
          "name": "AI 进", "color": "#22cc88" },
        { "position_ms": 7345, "kind": "loop", "cue_type": "hot",    "slot": 1,
          "end_ms": 11345, "name": "AI loop" },
        { "position_ms": 90000, "kind": "cue", "cue_type": "memory", "name": "breakdown" }
      ]
    }
  ]
}
```

cue 字段口径（与 library 对齐）：`kind ∈ {cue, loop}`（loop 必带 `end_ms`）；`cue_type ∈ {memory, hot}`
或留空（= 我们自己打的点，导出按 hot 处理、自动分配槽）；`slot ∈ 0..7` 可空（memory 不许带 slot）；
`role ∈ {in, out, loop}` 可空 —— **接受但不导出**（见下）。校验规则整份照抄 `cues_set`
（position 越界 / loop 无 end_ms / slot 重复 / 同 (position,kind) 重复 → 整条 payload 报错，
不部分写入），让「library 里合法的 cue 集」与「本工具合法的 payload」恒等。

## 输出（两路共用一份报告骨架）

```jsonc
{
  "schema_version": 1,
  "tool": "from_payload",
  "target": "rekordbox",          // 或 "serato"
  "dry_run": true,
  "set": "周五夜 warm-up",
  "track_count": 4,
  "written": 4, "missing": 0, "failed": 0,
  "cues": {
    "written": 11,
    "dropped_memory": 2,          // 仅 serato：被丢弃的 memory cue 条数（规格见下）
    "overflow_to_memory": 0,      // 仅 rekordbox：hot 槽溢出降为 Num=-1 的条数
    "dropped_no_slot": 0          // 仅 serato：8 槽占满后无处可放的 hot cue 条数
  },
  "warnings": ["rekordbox XML 不带 cue 颜色，12 条 cue 的颜色未导出", "..."],
  "outputs": { "xml": "/…/周五夜 warm-up.rekordbox.xml" },
  // serato 时是 { "album_dir": "…", "crate": "…", "manifest": "…" }（convert_set 原样）
  "tracks": [ { "id": 8, "title": "tune", "status": "written", "cues_written": 3 }, "…" ]
}
```

dry_run=true 时 `outputs` 给**将要写**的路径，`tracks` 给计划，磁盘零写入。

## 要写的 vendor 字段

### Rekordbox（XML，`to_rekordbox_xml` 现有字段全集）

- `TRACK` 属性：`TrackID`（顺序号）、`Name`、`Artist`、`Kind`（扩展名+` File`）、`Size`（stat 实测）、
  `TotalTime`（秒）、`AverageBpm`（两位小数）、`DateAdded`、`Location`（`file://localhost`+quote）、
  `Tonality`（= payload `key`）
- `TEMPO` 子元素：`Bpm`、`Metro="4/4"`、`Battito="1"`；`Inizio` 现 writer 硬编码 `0.024` ——
  **本工具改为：payload 带 `beat_anchor_ms` 就用它（ms→s 三位小数），否则保持 0.024**（writer 小改，单列）
- `POSITION_MARK`：`Name`、`Type`（loop=4 / cue=0）、`Start`、`End`（loop 写秒值，cue 写 -1）、
  `Num`（映射见下表）
- `PLAYLISTS` NODE 树：ROOT 下一个 playlist 节点，条目顺序 = tracks 数组顺序

### Serato（`convert_set` 现有产物全集）

- 音频副本：`out_dir/ShadowRoom/<set 名>/`（重名加 `-<序号>`；U 盘场景，连音频一起走）
- `Markers2` GEOB：hot cue（`cue` 条目）与 saved loop（`loop` 条目）**两套独立槽位各 0..7**
  （`markers_for` 实机注释：loop 占 cue 序号会让后面的 cue 串位）
- `BeatGrid` GEOB：`bpm` + 锚点（`beat_anchor_ms` → 第一条 cue → 0 的现成回退链）
- `.crate`：`out_dir/_Serato_/Subcrates/<set 名>.crate`，`ptrk` 相对路径，顺序 = tracks 数组顺序
- `manifest.json`：写入与回读校验记录（现有格式原样）+ 本报告新增的 `cues` 计数块

## cue 映射（本稿的核心，逐字段）

| 我们的字段 | Rekordbox XML | Serato Markers2 |
| --- | --- | --- |
| `kind=cue` + `cue_type=hot` | `Type=0`，`Num=slot`；slot 空 → 自动取最低空号 0..7 | `cue` 条目，index 按 slot 顺序**致密**分配（见下注），name/color 带上 |
| `kind=loop` + `cue_type=hot` | `Type=4`，`Start/End` 都写，`Num=slot`（规则同上） | `loop` 条目进 **saved loop 独立槽位** 0..7，不占 cue 序号 |
| `cue_type=memory`（cue 或 loop） | `Num=-1`，`Type` 按 kind，**全量保留** | **丢弃**，报告 `dropped_memory: N`（`VENDOR_CUE_RULES` 既定口径） |
| `cue_type` 留空（我们打的点） | 按 hot 处理，`Num` 自动分配 | 按 hot 处理，index 自动分配 |
| hot 溢出（>8 条或 slot 全撞） | `Num=-1` 降为 memory + `overflow_to_memory: N`（数据不丢） | 无槽可放 → 丢弃 + `dropped_no_slot: N` |
| `end_ms` | loop 的 `End`（秒，三位小数）；cue 恒 `-1` | loop 条目的 end_ms；cue 条目无 |
| `role`（in/out） | **不写** —— vendor 无此概念，role 只喂 set 计时（`VENDOR_CUE_RULES` 注释既定：导出丢了可接受） | 同左，不写 |
| `color` | **XML 无颜色字段 → 丢**，warnings 记「N 条 cue 的颜色未导出」（调色板编号是 DB 直写路径的事，本轮不出） | `#rrggbb` → RGB int 写进 marker；无色用 Serato 默认白（不写黑） |
| `name` | `Name` 属性 | marker name |

两条实现注记（不改变上表语义）：

1. **Serato 致密分配**：Markers2 每个条目的 index 是显式写在文件里的，理论上 slot=3 可以直接
   写 index=3（稀疏）。但**稀疏摆放未被真机验证过**（家规：vendor 行为只写实测过的），所以默认
   致密——hot cue 按 (slot, position_ms) 排序后顺次占 0..7，与已验证的 `markers_for` 枚举行为
   一致。稀疏摆放列为真机验证项，验证通过后可作为选项打开。
2. **Rekordbox `Num=slot`**：现 writer 是枚举顺序给 `Num`（`index<8`）。XML 的 `Num` 是显式属性，
   直接写 slot 值（允许稀疏）没有格式风险——adapter 在调 writer 前把每条 cue 的最终 `Num`
   解析好即可，writer 本身不用动。

## memory cue 到 Serato：丢 + 报告（按派单口径）

`cue_type=memory` 的条目（无论 cue 还是 loop）在 serato 出口一律丢弃，报告写
`dropped_memory: N` 并在 warnings 里点名每条出自哪首哪个位置。依据是 `VENDOR_CUE_RULES`：
「Serato 没有 memory 概念、只有 8 槽位，memory 挤进去会顶掉用户真正的 hot cue（数据损坏）」。

**留给 DeepSeek 的开放问题**：memory **loop** 是否改投 saved loop 独立槽位？该槽位与 hot cue
槽位不相干，「挤掉 hot cue」的顾虑对 loop 不成立，投过去数据不丢。代价是与
`VENDOR_CUE_RULES` 的字面口径（memory 全丢）分叉——规则注释只论证了 cue 槽，没论证 loop 槽。
本稿默认仍按派单口径全丢，评审若改判，改动只在这一行映射。

## 非目标（本轮明确不出）

- 直写 Rekordbox `master.db`（`write_rekordbox_set` 路径：pad Kind 映射 (1,2,3,5..17 避开 4)、
  `BeatLoopSize=(拍数<<16)|1` / 非整拍写 0、调色板编号——这些字段只属于 DB 路径，XML 没有）
- Rekordbox U 盘设备（USBANLZ）写入
- Camelot 导出（XML `Tonality` 吃音乐调记法；camelot 是我们的展示字段，不进 vendor）
- Serato 稀疏 hot cue 摆放（待真机验证，见上）
- `role` 的 vendor 落点（vendor 没有这个概念；真想要只能编码进 name 前缀，本稿不做）

## 验收口径（实现那一刀用）

1. fixture：3 首 wav（8 hot 槽全占 + 2 memory + 1 memory loop + 1 无 slot hot）→ rekordbox XML：
   `Num` 恰为 0..7 + 3 个 -1（2 memory + 1 溢出），`overflow_to_memory=1`，`End` 只在 loop 行出现
2. 同 fixture → serato：`dropped_memory=3`，Markers2 回读 8 cue + 1 loop，loop 不占 cue 序号，
   crate 顺序 = payload 顺序
3. dry_run 默认：两路调用后 `exports/` 零新文件
4. 同 (position,kind) 重复 / memory 带 slot / loop 无 end_ms → 整体报错零写入
