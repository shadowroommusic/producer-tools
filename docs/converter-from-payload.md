# 接口稿：`converter.from_payload`（我们的 set → Rekordbox XML / Serato crate）

> 状态：**草稿 v2，未实现**。S5 只出接口；v2 已并入 DeepSeek 评审（2026-09-25，见文末
> 「评审记录」）：改判 memory loop 出口、补 `dropped_missing` / `slot_remapped` 两个计数、
> 修正「XML 无颜色字段」的说法、`beat_anchor_ms=0` 与 Serato 长 name 列进验收。仍未实现。
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
    "dropped_memory": 2,          // 仅 serato：被丢弃的 memory cue 条数（memory loop 不在此列，见下）
    "overflow_to_memory": 0,      // 仅 rekordbox：hot 槽溢出降为 Num=-1 的条数
    "dropped_no_slot": 0,         // 仅 serato：8 槽占满后无处可放的 hot cue / memory loop 条数
    "dropped_missing": 0,         // 两路：文件缺失那几首上、因此没导出的 cue 条数（不计入 written）
    "slot_remapped": 0            // 仅 serato 致密分配：实际序号与 payload slot 不同的条数
  },
  "warnings": ["rekordbox XML 不带 cue 颜色，12 条 cue 的颜色未导出", "..."],
  "outputs": { "xml": "/…/周五夜 warm-up.rekordbox.xml" },   // 新建的文件
  "modifies": ["/…/ShadowRoom/周五夜 warm-up/tune.wav"],      // 会被改写的文件（serato：拷出来的音频副本写 Markers2；rekordbox 路径恒为空数组）
  // serato 时是 { "album_dir": "…", "crate": "…", "manifest": "…" }（convert_set 原样）
  "tracks": [ { "id": 8, "title": "tune", "status": "written", "cues_written": 3 }, "…" ]
}
```

dry_run=true 时 `outputs` / `modifies` 给**将要写、将要改**的路径，`tracks` 给计划，磁盘零写入。

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
| `cue_type=memory, kind=cue` | `Num=-1`，`Type=0`，**全量保留** | **丢弃**，报告 `dropped_memory: N`（`VENDOR_CUE_RULES` 既定口径） |
| `cue_type=memory, kind=loop` | `Num=-1`，`Type=4`，**全量保留** | **投 saved loop 槽位**（v2 改判，见下），不占 cue 序号 |
| `cue_type` 留空（我们打的点） | 按 hot 处理，`Num` 自动分配 | 按 hot 处理，index 自动分配 |
| hot 溢出（>8 条或 slot 全撞） | `Num=-1` 降为 memory + `overflow_to_memory: N`（数据不丢）；**降级后 `Type` 保持原值**（loop 仍 `Type=4`——Num 管 pad，Type 管 loop，两个维度正交） | 无槽可放 → 丢弃 + `dropped_no_slot: N`（hot loop 先占槽，memory loop 按位置补） |
| `end_ms` | loop 的 `End`（秒，三位小数）；cue 恒 `-1` | loop 条目的 end_ms；cue 条目无 |
| `role`（in/out） | **不写** —— vendor 无此概念，role 只喂 set 计时（`VENDOR_CUE_RULES` 注释既定：导出丢了可接受） | 同左，不写 |
| `color` | **现 writer 不写颜色 → 丢**，warnings 记「N 条 cue 的颜色未导出」。注意是 **writer 能力缺口、不是格式缺口**：`POSITION_MARK` 有 `Red/Green/Blue` 三个属性（DeepSeek 评审指出，v1 那句「XML 无颜色字段」是错的）。实现时若要保色：扩 writer 写三属性 + 真机验证 rekordbox 是否读它们 | `#rrggbb` → RGB int 写进 marker；无色用 Serato 默认白（不写黑） |
| `name` | `Name` 属性 | marker name |

两条实现注记（不改变上表语义）：

1. **Serato 致密分配**：Markers2 每个条目的 index 是显式写在文件里的，理论上 slot=3 可以直接
   写 index=3（稀疏）。但**稀疏摆放未被真机验证过**（家规：vendor 行为只写实测过的），所以默认
   致密——hot cue 按 (slot, position_ms) 排序后顺次占 0..7，与已验证的 `markers_for` 枚举行为
   一致。稀疏摆放列为真机验证项，验证通过后可作为选项打开。
2. **Rekordbox `Num=slot`**：现 writer 是枚举顺序给 `Num`（`index<8`）。XML 的 `Num` 是显式属性，
   直接写 slot 值（允许稀疏）没有格式风险——adapter 在调 writer 前把每条 cue 的最终 `Num`
   解析好即可，writer 本身不用动。

## memory cue / memory loop 到 Serato：分开处理（v2 改判）

- **memory cue（`kind=cue`）→ 丢弃 + 报告**。依据 `VENDOR_CUE_RULES`：「Serato 没有 memory
  概念、只有 8 槽位，memory 挤进去会顶掉用户真正的 hot cue（数据损坏）」。报告写
  `dropped_memory: N`，warnings 点名每条出自哪首哪个位置。
- **memory loop（`kind=loop`）→ 投 saved loop 槽位**（DeepSeek 评审改判，本稿采纳）。理由：
  Serato 的 CUE 条目与 LOOP 条目是**两套独立槽位**（各 0..7），这条不是推测而是本仓库实测
  过的（`serato_export.py: markers_for` 注释：两套 index 空间独立，混用会让 loop 后面的 cue
  在 Serato 里串位）。所以「挤掉 hot cue」的顾虑对 loop 不成立（它挤的是 loop 槽，
  `VENDOR_CUE_RULES` 的字面口径只论证了 cue 槽，没论证 loop 槽）。
- **loop 槽的溢出规则必须写死**（否则 loop 槽自己也会互相挤）：hot loop 先占槽，memory loop
  按 position 顺序补剩余槽位，补不上的落 `dropped_no_slot: N` 并在 warnings 点名。
- 一处刻意的不对称：改判只在 Serato 出口，Rekordbox 本来就全量保留（`Num=-1`）。

## 非目标（本轮明确不出）

- 直写 Rekordbox `master.db`（`write_rekordbox_set` 路径：pad Kind 映射 (1,2,3,5..17 避开 4)、
  `BeatLoopSize=(拍数<<16)|1` / 非整拍写 0、调色板编号——这些字段只属于 DB 路径，XML 没有）。
  **本工具不开 `target=rekordbox_db`**（DeepSeek 2026-09-25 复核维持此结论）：与已有的
  `write_rekordbox_set` 职责重叠，两条写路径塞进同一工具只会分叉维护；直写加密 master.db 的
  版本兼容与损坏风险远高于 XML 导出，而 XML 够 rekordbox 自己导入
- Rekordbox U 盘设备（USBANLZ）写入
- Camelot 导出（XML `Tonality` 吃音乐调记法；camelot 是我们的展示字段，不进 vendor）
- Serato 稀疏 hot cue 摆放（待真机验证，见上）
- `role` 的 vendor 落点（vendor 没有这个概念；真想要只能编码进 name 前缀，本稿不做）

## 验收口径（实现那一刀用）

1. fixture：3 首 wav（8 hot 槽全占 + 2 memory + 1 memory loop + 1 无 slot hot）→ rekordbox XML：
   `Num` 恰为 0..7 + 3 个 -1（2 memory + 1 溢出），`overflow_to_memory=1`，`End` 只在 loop 行出现
   （含溢出那条 loop：降级后 `Num=-1` 且 `Type` 仍为 4）
2. 同 fixture → serato：`dropped_memory=2`（只有 memory cue 被丢），memory loop **不丢**——
   Markers2 回读 8 cue + 2 loop（hot loop + memory loop），两套序号各自独立，crate 顺序 = payload 顺序
3. dry_run 默认：两路调用后 `exports/` 零新文件；报告里 `outputs`（将新建）与 `modifies`
   （serato 拷出来要写 Markers2 的音频副本）分列，rekordbox 路径 `modifies` 为空数组
4. 同 (position,kind) 重复 / memory 带 slot / loop 无 end_ms → 整体报错零写入
5. `beat_anchor_ms` 边界：给 0 就是写 0（明确覆盖掉 writer 的 0.024 默认，不是"回退到 0.024"），
   不给才用 0.024；给 112 写 0.112s 三位小数（**ms → s 换算写进断言**，这是评审点名的单位坑）
6. 文件缺失那首：`status=missing`、它的 cue 计入 `dropped_missing` 而不进 `written`，
   其余曲目照常导出（不整体失败）
7. 长 name：一条 50 字符的 cue name 走 serato → 若被截断必须在报告里记（截断长度随
   Markers2 label 实机上限，见「待真机验证」第 3 条）；不截断则原样回读
8. 致密分配的可追溯：payload slot 稀疏（如 0/2/4）时 serato 实际写 0/1/2，
   `slot_remapped=3` 如实计数（用户肌肉记忆被改动这件事必须可见）
9. memory loop 在 rekordbox 出口恒 `Num=-1` + `Type=4`（与 cue 的 memory 区分开）

## 待真机验证（实现那刀的准入条件）

家规：vendor 行为只写实测过的。以下四条在实现前/实现时必须用真机（rekordbox 7 + Serato DJ Pro
4.0）过一遍，过不了就按老口径回退并记账：

1. **XML 的 loop 终点**：本 writer 用 `POSITION_MARK Type="4"` + `End=<秒>` 表达 loop
   （`rekordbox_export.py`；`docs/internals.md` 同口径）。DeepSeek 评审质疑「XML 没有 End
   属性、loop 终点靠别的约定」——现有代码与 2026-09-14 那次「用 rekordbox 自家 XML 导出核对
   `Num/Type`」都支持 `End` 存在，但当时没单独留下 loop 终点的对照物。实现那刀要补一次：
   导出含 loop 的 XML → 进 rekordbox 看 loop 是否带终点。
2. **`Red/Green/Blue` 三属性**：格式有（评审指出），但本 writer 不写、也没真机验证 rekordbox
   认不认。要不要保色取决于这次验证，不取决于文档。
3. **Serato marker label 的长度上限**：Markers2 label 超出上限的实际行为（截断/丢弃/报错）
   没量过；验收第 7 条依赖它。
4. **Serato 稀疏摆放**：直接写 `index=slot`（不东补西补）是否被 Serato 认——没量过，所以
   本稿默认致密；量过了才能开成选项。

## 评审记录（DeepSeek，2026-09-25，多轮）

- **采纳**：memory loop 改投 saved loop 槽位（+ 溢出规则写死）；溢出降级后 `Type` 保持原值；
  「XML 无颜色字段」改为「writer 不写 RGB、格式支持」（见映射表 color 行）；
  `beat_anchor_ms=0` 语义、Serato 长 name、`outputs` 分「新建/改写」、missing 曲目的 cue 计数、
  `slot_remapped` 追溯——五条全部进验收口径。
- **不采纳/存疑**：「XML 的 `POSITION_MARK` 没有 `End` 属性」——与本仓库 writer 及
  rekordbox 自家 XML 导出的对照记录相左，按上面「待真机验证 1」处理，不据此改设计。
- 评审原文在 DeepSeek 会话 `38135bb0`（本文件是结论，不复制全文）。
