# dsh-mood — 模拟心情指标

**这不是读模型真实情绪。** 它是一个可解释的交互状态机：输入是会话里看得见的事件，输出是六维向量 + 一个心情标签。它只影响**表达风格**，不碰事实、安全、权限。所有记录都带 `simulated: true`。

当前进度：**Step 1（骨架）**。只订阅、只写记录，不做状态机、不做注入、不做面板。

---

## 安装与注册路径（重要）

两条路径分工，**不要重复**：

1. **注册（唯一入口）**：本包自带的 `dsh.bundle.patch`（`cordis.patch.yml`）里用 `insert:` 声明 `id: mood`。
   这个 patch 只有在包被列进 profile 的 `dsh.profile.bundles` 时才会被应用。
2. **配置覆盖**：profile 自己的 `cordis.patch.yml` 里只写同 id 的 `config:`。
   **不要**在那里再写一条 `- id: mood / name: dsh-mood`（那是第二个实例）。

所以 profile 的 `package.json` 需要两处：

```json
"dependencies": { "dsh-mood": "file:./plugins/dsh-mood" },
"dsh": { "profile": { "bundles": [ ..., "dsh-mood" ] } }
```

卸载 = 删依赖、删 bundles 里那项、删 profile patch 里那条 config、删 `plugins/dsh-mood`，再 `dsh plugin --profile desktop install`。

## 一个必须知道的坑：pnpm 装的是副本

`dsh plugin --profile desktop install` 会把本包**复制**进 `node_modules/dsh-mood`，
不是软链。复制之后，改 `plugins/dsh-mood/` 里的源码**不会**影响 app。

现状：已把 `node_modules/dsh-mood` 换成指向 `plugins/dsh-mood` 的 junction，改源即生效。
**但只要再跑一次 `dsh plugin ... install`，junction 可能被还原成副本**——
到时候要么改完再建 junction，要么直接改 `node_modules` 那份。

## 开关语义

- schema 默认 `enabled: false`（安全默认）。
- 只有 profile patch 里写 `enabled: true` 才真的启用。
- `enabled: false` 时 `apply()` 第一行就返回：不订阅事件、不打开存储域、不写文件、零开销，prompt 与未安装时逐字一致。

---

## 存储

走 `ctx.storageDomain`（`dsh-storage-domain` 的 domain API），**不硬编码路径**。
domain 名 `mood`，版本 `1`，一个表 `records`。
实际落盘位置由 domain 的 backend 决定（默认在 `$DSH_HOME/storages` 下）；schema 里的 `storage.file` 只是文档说明，不参与实现。

重置 = 关掉插件、删掉 mood domain 的数据（或整个 storage 里对应文件），重启即重建。

---

## 记录形状（Step 2）

```json
{
  "schema_version": 1,
  "simulated": true,
  "ts": 1793018000000,
  "turn": 12,
  "session_id": "session-…",
  "state": {"valence": 61, "arousal": 55, "dominance": 57,
            "engagement": 58, "stress": 63, "affinity": 58},
  "delta": {"valence": -2, "arousal": 0, "dominance": 0,
            "engagement": 0, "stress": 8, "affinity": 0},
  "label": "赶",
  "drivers": [{"key": "tool_error_x3", "note": "同一件事连着报错三次", "confidence": 0.9, "weight": 8}],
  "debug": {
    "events": {"tool_error": 3, "tool_error_x3": 1},
    "delta_events": 3,
    "decay_applied": {"valence": -0.4, "arousal": 0, "dominance": 0,
                      "engagement": 0, "stress": -1.1, "affinity": 0},
    "clock_skew": 0,
    "sessions_active": 1,
    "state_start": {"valence": 63, "arousal": 55, "dominance": 57,
                    "engagement": 58, "stress": 56, "affinity": 58}
  }
}
```

### 对账口径（硬约定）

- `delta` = **本轮所有生效事件的 Δ_eff 之和**，逐维已套 ±8 单步上限；**不含衰减**。范围 −100..100。
- `decay_applied` = **本轮累计衰减量**，逐维有符号：`state_before_decay − state_after_decay`。
  高于基线时它是正数（被往下削），低于基线时是负数（被往上补）。
- 恒等式（逐维，可用来对账）：

```
state_end = state_start + delta − decay_applied
```

- `debug.state_start` 是**本轮开始时刻**的状态，`state` 是本轮结束状态，`debug.delta_events` 是本轮生效事件个数。
- 测试向量按「事件增量口径」校验：`delta.stress ≈ +32` 指纯事件增量，不含衰减。

---

## 事件采集（Step 2）

| key | 来源 | 判定 | 去重 |
|---|---|---|---|
| user_praise | `user/message` | 强/中档关键词 + confidence 规则 | 一 turn 一次 |
| user_reject | `user/message` | 硬词 + 「别+动词」（白名单排除 别担心/别急/别怕/别慌/别客气/别介意/别忙） | 一 turn 一次 |
| tool_ok | `tool/result` | 既非 isError、正文也没有 `[COMMAND_FAILED` | 每次 |
| tool_error | `tool/result` | `message.isError === true` **或正文含 `[COMMAND_FAILED`**（DSH 的 bash 失败不置 isError），排除 `ABORTED_BEFORE_DISPATCH` | 每次 |
| tool_error_x3 | 由 tool_error 派生 | 同 turn 连续 3 次 error，`tool_ok` 清零；第 3 次与 tool_error **合并成一次** `+4+8=+12` 再套 ±8 | 一 turn 一次 |
| retry | `llm/retry` | 事件存在 | 每次 |
| clarify | `tool/call` | name ∈ {ask_user, ask_user_question} | 每次 |
| short_msgs | `user/message` | 长度 < 12 且本轮累计 ≥2 | 一 turn 一次 |
| ctx_pressure | `request/context`/`request/header` | `used/limit > 0.8`，取不到就跳过 | 一 turn 一次 |
| dense_turns | `turn/start` | 距上次 `turn/end` < 60s | 一 turn 一次 |
| long_idle | `turn/start` | 距上次 `turn/end` > 2h | 一 turn 一次 |

**防暴涨**：`tool_ok` 每轮最多计 **3 次**（一轮几十次成功调用会把 dominance 顶到 100）；其余事件不设次数上限。逐维每轮总变化另有 **±40** 的硬上限。这两条都在 `smoothing` 里可配。

**confidence**：夸奖 强词基值 0.85 / 中词 0.65，`min(0.95, base + 0.05×(命中-1))`，长句(>60字) −0.1，同时命中否定 −0.3；否定 硬词 0.85 / 软词 0.7。低于 0.6 不算事件、也不进 drivers。

---

## 状态机（Step 2）

```
τ_dim   = half_life / ln2            # stress 45 分钟，其余 6 小时
decayed = baseline + (state − baseline) × exp(−Δt / τ_dim)
Δ_eff   = Δ_raw / sqrt(N_act)        # N_act = 最近 30 分钟内活跃会话数
applied = clamp(decayed + Δ_eff, 0, 100)
next    = clamp(applied, decayed − 8, decayed + 8)
丢弃     |Δ_eff| < 2
```

逐事件即时结算并推进 `last_settle_ts`；`turn/end` 只补最后一段衰减 + 写记录。
基线 55。状态全局共用（`per_session` 开关位保留）。

---

## 标签与 drivers

10 条顺序匹配、先中先出：绷 → 闷 → 赶 → 兴 → 暖 → 淡 → 定 → 虚 → 沉 → 平。

drivers：只取本轮生效事件（|Δ_eff| ≥ 2），按 `weight × confidence` 排序，最多 3 条，`confidence < 0.6` 不写，只写人话，**不记原话**。

---

## 边界

- 整段 try/catch，失败只吞不抛；数值越界统一 clamp(0,100) 并取整。
- 时钟回拨：`Δt < 0` 按 0 处理，并累加 `debug.clock_skew`。
- 保留最近 2000 条，按 key 里的时间戳裁旧。
- 重启从最后一条记录恢复状态；超过 24h 则从基线开始。

---

## 语气注入（Step 3）

- section 名 `mood:hint`，`order = getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1`。
- 每轮 `turn/start` 用**内存里的 state** 生成文本，`ctx.effect` 替换上一个 section；其余事件期间不更新。
- 文本固定三行封顶：

```
（模拟语气提示，非真实状态）
<label 对应的语气句>
<rhythm 开启时的节奏句>
```

- `label = 平` 且 rhythm 未触发 → **不注册 section**，prompt 与常态完全一致。
- `mood.enabled=false` 或 `injection.enabled=false` → 一律不注册。
- 生成/注册失败只吞不抛；最坏情况是这轮没有语气提示，不影响对话。
- 只读 `state` / `label`，不写回、不读用户原文。

### label → 语气句

| label | 语气句 |
|---|---|
| 绷 | 有点绷着，话短一点，先办正事，别绕。 |
| 闷 | 兴致不高，句子放轻，少主动挑事。 |
| 赶 | 有点赶，省掉寒暄，直接给结论。 |
| 兴 | 劲儿上来了，语气可以扬一点，接得住梗。 |
| 暖 | 跟他近，称呼软一点，温度高一点。 |
| 淡 | 有点疏，客气些，别撒娇。 |
| 定 | 有底气，敢下判断，别老反问你。 |
| 虚 | 心里没底，多确认一句，少下断言。 |
| 沉 | 在这件事里，愿意追细节，话可以说完整。 |
| 平 | 不注入 |

### rhythm（默认关）

`rhythm.enabled=true` 时追加一句节奏约束，仍然 ≤3 行：
- stress ≥ 65 → 「句子再短一点，能一句话说完就别用两句。」
- valence ≤ 35 → 「少用感叹号，语气收着。」

---

## 已知偏差：钳制会破坏对账恒等式

某个维度被钳到 0 或 100 时，`delta` 里记录的是**事件想加的原始量**，实际落地的更少，
于是 `state_end = state_start + delta − decay_applied` 在这些维度上不成立（其余维度仍然成立）。

验收对账时**跳过被钳制的维度**（即 `state` 为 0 或 100 的维度），不改测试口径。

## 设置页接线（逆向结论）

- `dsh-client-ui-settings-general/lib/client.js`：
  - 导航项来自 `settings.section` 槽位；`rows` 只读 `id / order / label`（`resolveSlotLabel` 支持字符串或函数）。
  - 图标走 `navIcon(id)` 硬编码映射，未知 id 一律兜底齿轮 —— 第三方自定义图标只能 DOM 补丁（本项目拒绝）。
  - 内容区没有官方 Tab 组件，各插件自绘。
- 注册写法（官方自己与壁纸引擎都这么写）：

```js
ctx.slots.inject('settings.section', () =>
  ctx.slots.register(
    { name: 'settings.section', id: 'mood-engine', order: 500, label: () => '心情&日记' },
    MoodEngineSection
  )
)
```

- `dsh.client.immediately: true`：client bundle 默认懒加载，不设这个标志，设置页要等右栏被打开后才注册。
