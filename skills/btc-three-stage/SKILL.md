---
name: btc-three-stage
description: BTC 买卖点判断的三阶段流程（周线定势 → 日线定向 → 4 小时线定时），以及 btc_signal 输出字段的读法与决策矩阵。用户问「能不能买/卖」「现在什么方向」「给个买卖点」时先用。
modes: [btc]
---

# 三阶段买卖点（周线 → 日线 → 4 小时线）

判断任何开仓 / 加仓 / 平仓时机，都按「**周线定势 → 日线定向 → 4 小时线定时**」三步走。
工具：`btc_signal`（一步给出三阶段结论）；需要看某周期细节时，读它返回里的
`stage1_weekly` / `stage2_daily` / `stage3_4h` / `snapshots`。

判定条件的完整表格见本技能目录下的 `references/stage-rules.md`
（`load_skill` 的返回里带有技能目录绝对路径，按相对路径拼出来读）。

## 先决条件（不满足就不要给结论）

1. `btc_status` 看数据是否新鲜：日线不足 200 根、或最后一根明显落后，先 `btc_sync`；
2. 4 小时线是第三阶段的前提：`btc_status` 里 1h 少于 120 根，`btc_sync` 补 1h；
3. **不凭 btc_price 的现价推方向** —— 现价只用于执行与报数，方向只来自三阶段。

## 输出怎么读

| 字段 | 含义 |
|---|---|
| `stage1_weekly.trend` | `bull` / `bear` / `range`：只决定「能不能做多/做空」 |
| `stage2_daily.bias` | `long` / `short` / `wait`：日线是否与周线同向 |
| `stage3_4h.entry` | `now` / `wait`：4 小时线是否触发入场 |
| `stage3_4h.degraded` | `true` 表示 1h 数据不足，**结论里必须写「4 小时线未确认」** |
| `action` | `long` / `short` / `wait` / `stand_aside` |
| `position_hint` | 仓位建议（标准 1.0x / 震荡 0.5x / 等待 0） |
| `confidence` | 三阶段置信度最小值；`< 0.5` 时仓位减半 |
| `stage3_4h.stop` / `targets` | 止损与 2R / 3R 目标（工具已算，不要自己编） |

## 决策矩阵

| 周线 | 日线 | 4 小时线 | action | 仓位 |
|---|---|---|---|---|
| bull | long | now | `long` | 1.0x |
| bull | long | wait | `wait`（等回踩，不追） | 0 |
| bull | wait | — | `stand_aside` | 0 |
| bear | short | now | `short` | 1.0x |
| bear | short | wait | `wait`（等反弹） | 0 |
| range | 下沿 long | now | `long` | 0.5x |
| range | 上沿 short | now | `short` | 0.5x |
| 任意冲突 | — | — | `stand_aside` | 0 |

`action` 是 `wait` / `stand_aside` 时**不得下单**，也不要换个说法暗示可以进。

## 报结论的格式

1. 一句话方向：做多 / 做空 / 等 / 不做，以及为什么（哪一阶段否决的）；
2. 三阶段各一行关键数字（趋势 + ADX、bias + RSI、entry + 触发条件）；
3. 若给出方向：入场区间、止损、2R/3R 目标、仓位与单笔风险；
4. 数据口径：`as_of` 时间 + 是否 `degraded`。

## 反例（不要做）

- 只看 1h 金叉就下单，忽略周线空头；
- 周线震荡、价格在区间中部时「猜方向」；
- 4 小时线 RSI 85 追多（超买追单，盈亏比极差）；
- 止损距离过大仍按满仓下单；
- 1h 数据缺失时，用日线信号声称「4 小时线已确认」。
