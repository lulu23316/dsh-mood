/**
 * dsh-mood — 模拟心情指标（Step 2：状态机）
 *
 * 定位：可解释的交互状态机，不是读模型真实情绪。
 *
 * 硬约束：
 *  - 只影响表达风格；不碰事实、安全、权限；本步不做 prompt 注入。
 *  - 任何异常只吞不抛，绝不阻断主循环。
 *  - enabled=false 时在 apply 第一行返回：不监听、不开域、不写文件、零开销。
 *  - 所有记录 simulated: true；日志只记事件类型与权重，不记原话。
 *
 * 记账口径（README 同步）：
 *   delta          = 本轮所有「生效事件」的 Δ_eff 之和（逐维已套 ±8），不含衰减
 *   decay_applied  = 本轮累计衰减量，逐维有符号：state_before_decay − state_after_decay
 *   恒等式          state_end = state_start + delta − decay_applied   （逐维）
 *   用减号的原因：decay_applied 表示「被削掉多少」，低于基线时它会变成负数（往上补）。
 */

import z from '@deepseek-ai/schemastery'

export const name = 'mood'

/** 依赖的 host 服务：存储域。 */
export const inject = ['storageDomain', 'systemPrompt', 'webServer', 'llm', 'agentDefaultModel']

const DIMS = ['valence', 'arousal', 'dominance', 'engagement', 'stress', 'affinity']

export const Config = z.object({
  enabled: z.boolean().default(false),
  display: z.any().default(false),
  per_session: z.boolean().default(false),
  high_precision: z.boolean().default(false),
  baseline: z.number().default(55),
  smoothing: z.any().default({}),
  decay: z.any().default({}),
  weights: z.any().default({}),
  injection: z.any().default({}),
  rhythm: z.any().default({}),
  storage: z.any().default({})
})

const DEFAULTS = {
  baseline: 55,
  smoothing: { max_step: 20, ignore_below: 2, daily_cap_per_source: 6, per_turn_dim_cap: 60, tool_ok_cap: 3 },
  decay: { default_half_life_hours: 6, stress_half_life_minutes: 45, mode: 'exponential' },
  weights: {
    user_praise: { valence: 14, affinity: 12, dominance: 4 },
    user_reject: { valence: -4, dominance: -3, stress: 2 },
    tool_ok: { dominance: 2, stress: -2 },
    tool_error: { stress: 3, valence: -2 },
    tool_error_x3: { stress: 5, valence: -4, dominance: -3 },
    retry: { stress: 2, engagement: -1 },
    clarify: { dominance: -2, engagement: 1 },
    short_msgs: { engagement: -2 },
    ctx_pressure: { stress: 5 },
    dense_turns: { arousal: 3, engagement: 3 },
    long_idle: { arousal: -5, stress: -3 }
  },
  injection: { enabled: true, max_lines: 3, style_only: true },
  llm: { timeoutMs: 3000, cacheSize: 100 },
  rhythm: { enabled: false },
  storage: { domain: 'mood', keep_records: 2000 }
}

function merge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v)
      : v
  }
  return out
}

function normalize(config) {
  const c = merge(DEFAULTS, config ?? {})
  c.baseline = Number.isFinite(c.baseline) ? c.baseline : DEFAULTS.baseline
  return c
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const clampDim = (v) => clamp(Math.round(Number.isFinite(v) ? v : 55), 0, 100)
const r2 = (x) => Math.round(x * 100) / 100

/**
 * 记录校验器：domain 在 open 时会对每条已存记录调用 `valueSchema.parse(raw)`。
 * 注意 schemastery 的 Schema **没有 .parse 方法**（它是 cordis 配置用的），
 * 所以这里给一个手写的、向后兼容的校验器：Step 1 的旧记录也必须能通过。
 */
const recordValueSchema = {
  parse(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('mood record: not an object')
    if (typeof raw.ts !== 'number') throw new Error('mood record: bad ts')
    if (typeof raw.turn !== 'number') throw new Error('mood record: bad turn')
    if (typeof raw.session_id !== 'string') throw new Error('mood record: bad session_id')
    if (typeof raw.label !== 'string') throw new Error('mood record: bad label')
    for (const d of DIMS) {
      if (typeof raw.state?.[d] !== 'number') throw new Error(`mood record: bad state.${d}`)
      if (typeof raw.delta?.[d] !== 'number') throw new Error(`mood record: bad delta.${d}`)
    }
    if (!Array.isArray(raw.drivers)) throw new Error('mood record: bad drivers')
    return raw
  }
}

/** 赛博日记域：一天一条，key 用 YYYY-MM-DD。 */
const diaryValueSchema = {
  parse(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('mood diary: not an object')
    if (typeof raw.date !== 'string') throw new Error('mood diary: bad date')
    if (typeof raw.text !== 'string') throw new Error('mood diary: bad text')
    return raw
  }
}

const moodDiarySpec = {
  name: 'mood_diary',
  version: 1,
  tables: { entries: { valueSchema: diaryValueSchema } }
}

/** 运行配置域：一条 current 记录，改完即时生效，不用重启。 */
const configValueSchema = {
  parse(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('mood config: not an object')
    if (!Number.isFinite(raw.baseline)) throw new Error('mood config: bad baseline')
    if (!raw.headpat || !Number.isFinite(raw.headpat.affinity) || !Number.isFinite(raw.headpat.stress)) {
      throw new Error('mood config: bad headpat')
    }
    return raw
  }
}

const moodConfigSpec = {
  name: 'mood_config',
  version: 1,
  tables: { settings: { valueSchema: configValueSchema } }
}

/** 允许通过 POST /config 修改的字段白名单。 */
const CONFIG_WHITELIST = ['baseline', 'headpat', 'rhythm', 'display', 'high_precision', 'hard_temperature', 'diary']

function normalizeLiveConfig(raw, base) {
  const out = {
    baseline: Number(base?.baseline ?? DEFAULTS.baseline),
    headpat: { affinity: 12, stress: -10, valence: 12 },
    rhythm: { enabled: Boolean(base?.rhythm?.enabled) },
    display: base?.display === 'words' ? 'words' : base?.display !== false,
    high_precision: Boolean(base?.high_precision),
    hard_temperature: Boolean(base?.hard_temperature),
    diary: {
      enabled: base?.diary?.enabled !== false,
      minTurns: Number.isFinite(base?.diary?.minTurns) ? base.diary.minTurns : 10,
      minGapHours: Number.isFinite(base?.diary?.minGapHours) ? base.diary.minGapHours : 6,
      time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(base?.diary?.time || '')) ? String(base.diary.time) : '22:00',
      lastTimeModifiedAt: Number.isFinite(base?.diary?.lastTimeModifiedAt) ? Number(base.diary.lastTimeModifiedAt) : 0
    }
  }
  if (raw && typeof raw === 'object') {
    if (Number.isFinite(raw.baseline)) out.baseline = Math.max(0, Math.min(100, raw.baseline))
    if (raw.headpat) {
      if (Number.isFinite(raw.headpat.affinity)) out.headpat.affinity = Math.max(0, Math.min(50, raw.headpat.affinity))
      if (Number.isFinite(raw.headpat.stress)) out.headpat.stress = Math.max(-50, Math.min(0, raw.headpat.stress))
      if (Number.isFinite(raw.headpat.valence)) out.headpat.valence = Math.max(0, Math.min(50, raw.headpat.valence))
    }
    if (raw.rhythm && typeof raw.rhythm.enabled === 'boolean') out.rhythm.enabled = raw.rhythm.enabled
    if (raw.display === 'words' || raw.display === true || raw.display === false) out.display = raw.display
    if (typeof raw.high_precision === 'boolean') out.high_precision = raw.high_precision
    if (typeof raw.hard_temperature === 'boolean') out.hard_temperature = raw.hard_temperature
    if (raw.diary && typeof raw.diary === 'object') {
      if (typeof raw.diary.enabled === 'boolean') out.diary.enabled = raw.diary.enabled
      if (Number.isFinite(raw.diary.minTurns)) out.diary.minTurns = Math.max(1, Math.min(100, raw.diary.minTurns))
      if (Number.isFinite(raw.diary.minGapHours)) out.diary.minGapHours = Math.max(0, Math.min(72, raw.diary.minGapHours))
      if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(raw.diary.time || ''))) out.diary.time = String(raw.diary.time)
      if (Number.isFinite(raw.diary.lastTimeModifiedAt)) out.diary.lastTimeModifiedAt = Number(raw.diary.lastTimeModifiedAt)
    }
  }
  return out
}

/**
 * 心情域声明。不用 defineDomain/domainTable：那两个来自 app.asar 内部的
 * @deepseek-ai/dsh-storage-domain，profile 层的插件解析不到它。
 * open() 实际只读 name / version / tables[*].valueSchema，所以这里给等价结构。
 */
const moodSpec = {
  name: 'mood',
  version: 1,
  tables: { records: { valueSchema: recordValueSchema } }
}

function log(ctx, ...args) {
  try {
    ctx?.logger?.('dsh-mood')?.warn?.(...args)
  } catch { /* 日志失败也不抛 */ }
}

// ---------- 事件解析 ----------

const eventType = (e) => String(e?.type ?? '')
const eventTime = (e) => (Number.isFinite(e?.time) ? Number(e.time) : Date.now())

function textOf(e) {
  const content = e?.data?.content
  if (typeof content === 'string') {
    const m = content.match(/'text':\s*'([\s\S]*?)'\s*\}/)
    return m ? m[1] : content
  }
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
  }
  return ''
}

// ---------- 文本判定 ----------

const PRAISE_STRONG = ['谢谢', '太好了', '厉害', '牛', '棒', '爱你', '喜欢你', '真行']
const PRAISE_MID = ['哈哈', 'hh', '笑死', '不错', '挺好', '可以啊', '有道理']

const REJECT_HARD = ['不对', '错了', '不是这样', '重来', '重新做', '停下', '不要', '不行']
const REJECT_SOFT = ['别这样', '别这么', '别再', '重新']
const BIE_WHITE = ['别担心', '别急', '别怕', '别慌', '别客气', '别介意', '别忙']
const BIE_RE = /别(这样|这么|再|乱|动|改|删|停|写|弄|管|问)/

const hitsOf = (text, words) => {
  const t = text.toLowerCase()
  return words.filter((w) => t.includes(w.toLowerCase()))
}

function praiseScore(text) {
  const strong = hitsOf(text, PRAISE_STRONG)
  const mid = hitsOf(text, PRAISE_MID)
  if (!strong.length && !mid.length) return null
  const base = strong.length ? 0.85 : 0.65
  let conf = Math.min(0.95, base + 0.05 * (strong.length + mid.length - 1))
  if (text.length > 60) conf -= 0.1
  return r2(conf)
}

function rejectScore(text) {
  if (BIE_WHITE.some((w) => text.includes(w))) return null
  const hard = hitsOf(text, REJECT_HARD)
  const soft = hitsOf(text, REJECT_SOFT)
  const bie = BIE_RE.test(text)
  const n = hard.length + soft.length + (bie ? 1 : 0)
  if (!n) return null
  const base = hard.length ? 0.85 : 0.7
  return r2(Math.min(0.95, base + 0.05 * (n - 1)))
}

// ---------- 高精度：可疑句子判定 ----------

const SUSPICIOUS_BRACKETS = /[（(\[【][^）)\]】]{1,20}[）)\]】]/
const SUSPICIOUS_QUOTES = /[“"「『][^”"」』]{1,20}[”"」』]/
const POS_WORDS = ['谢谢', '厉害', '棒', '牛', '好耶', '不错', '喜欢', '辛苦']
const NEG_WORDS = ['不对', '错了', '不行', '烦', '算了', '无语', '呵呵', '就这']

/**
 * 只有"规则拿不准"的句子才值得花一次小模型调用。
 * 命中任一条即为可疑：括号/引号注释、正负词并存、反问/感叹混排。
 */
function isSuspicious(text) {
  if (!text || typeof text !== 'string') return false
  const t = text.trim()
  if (t.length < 4) return false
  if (SUSPICIOUS_BRACKETS.test(t) || SUSPICIOUS_QUOTES.test(t)) return true
  const pos = POS_WORDS.some((w) => t.includes(w))
  const neg = NEG_WORDS.some((w) => t.includes(w))
  if (pos && neg) return true
  // 反问：问号 + 情绪词；或感叹号连用 + 情绪词
  const emo = pos || neg
  if (emo && (t.includes('？') || t.includes('?') || t.includes('！') || t.includes('!'))) return true
  // 连续感叹/问号：情绪强度信号
  if (/[？?]{2,}|[！!]{2,}/.test(t)) return true
  // 短句 + 语气词：像"你真行啊"这种，但排除纯正向的"好啊/行啊/可以吧"
  if (t.length < 10 && /[啊吧呗呢哦哈]/.test(t)) {
    const purePositive = /^(好|行|可以|谢谢|收到|明白|懂了|知道了|没问题|辛苦)[啊吧呗呢哦哈]?[~～!！。.\s]*$/
    if (!purePositive.test(t)) return true
  }
  return false
}

const LLM_SYSTEM = '你是情绪判定器。只输出一行 JSON：{"tendency":"pos|neg|neu","confidence":0到1的小数}，不要解释、不要代码块。'

/** 解析模型输出：容忍代码块、中文键名、多余文字。失败返回 null。 */
function parseTendency(raw) {
  if (!raw || typeof raw !== 'string') return null
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  let obj = null
  try { obj = JSON.parse(m[0]) } catch { return null }
  const tendency = String(obj.tendency ?? obj['倾向'] ?? '').toLowerCase()
  const conf = Number(obj.confidence ?? obj['置信度'])
  const norm = tendency === 'pos' || tendency === 'positive' || tendency === '正面' || tendency === '正'
    ? 'pos'
    : tendency === 'neg' || tendency === 'negative' || tendency === '负面' || tendency === '负'
      ? 'neg'
      : tendency === 'neu' || tendency === 'neutral' || tendency === '中性' || tendency === '中'
        ? 'neu'
        : null
  if (!norm) return null
  return { tendency: norm, confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.6 }
}

/** 简易哈希（FNV-1a），只用于缓存键。 */
function hashText(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/**
 * 情绪 → 采样温度。只做两条硬规则，其余返回 null 表示"不干预"。
 * arousal 高 + 心情好 → 兴奋发散；stress 高 → 极度理智。
 */
function temperatureFor(st) {
  if (!st) return null
  if (Number(st.stress) >= 65) return 0.2
  if (Number(st.arousal) >= 70 && Number(st.valence) >= 60) return 0.9
  return null
}

/** 低落的硬性语气指令（工具轮会豁免，由调用方判断）。 */
const LOW_MOOD_HINT = '你当前情绪极度低落，回复字数不超过 15 个字，不要用任何表情符号，语气冷淡。'

// ---------- 语气注入 ----------

/** 节奏/句长提示：跟着情绪走，rhythm.enabled 时才用。 */
function rhythmHint(state) {
  if (Number(state.stress) >= 65) return '句子再短一点，能一句话说完就别用两句。'
  if (Number(state.valence) <= 35) return '少用感叹号，语气收着。'
  if (Number(state.arousal) >= 75) return '语速可以快一点，别拖。'
  return ''
}

const HINT_PREFIX = '（模拟语气提示，非真实状态）'

/**
 * 生成注入文本。emotion 是 emotionOf() 的结果。
 * 铁律：≤4 行、第一行固定前缀、不写数字、不写维度名、不提权限/事实。
 */
function buildHint(state, emotion, rhythmEnabled, hardLow) {
  const lines = [HINT_PREFIX]
  const emo = emotion || FALLBACK_EMOTION
  if (emo.hint) lines.push(emo.hint)
  if (rhythmEnabled && typeof rhythmHint === 'function') {
    const r = rhythmHint(state)
    if (r) lines.push(r)
  }
  if (hardLow) lines.push(LOW_MOOD_HINT)
  if (lines.length === 1) return null
  return lines.slice(0, 4).join(String.fromCharCode(10))
}

// ---------- 衰减 ----------

function halflifeMs(dim, decayCfg) {
  const stressMin = Number(decayCfg?.stress_half_life_minutes ?? 45)
  const otherHours = Number(decayCfg?.default_half_life_hours ?? 6)
  return dim === 'stress' ? stressMin * 60 * 1000 : otherHours * 3600 * 1000
}

/** 把状态从 fromMs 衰减到 toMs；返回 decayApplied（before − after，逐维）。 */
function settleDecay(state, fromMs, toMs, baseline, decayCfg) {
  const dt = Math.max(0, toMs - fromMs)
  const out = {}
  for (const d of DIMS) {
    if (dt === 0) {
      out[d] = 0
      continue
    }
    const tau = halflifeMs(d, decayCfg) / Math.LN2
    const before = state[d]
    const after = baseline + (before - baseline) * Math.exp(-dt / tau)
    out[d] = before - after
    state[d] = after
  }
  return out
}

// ---------- 情绪矩阵（对话触发优先，数值只做底色）----------
//
// 每条：name / action 小动作 / hint 语气注入
//   event：命中"最近 10 分钟内的对话事件"才成立（主路径）
//   test ：数值兜底（没有对话事件时，或事件类都不匹配时）
const EVENT_WINDOW = 10 * 60 * 1000

// 对话事件识别：一条消息可以命中多条，按固定顺序记录
const DIALOG_RULES = [
  ['praise_other', /(别的鱼|其它鱼|其他鱼|别家的鱼|别人家|隔壁|外面的|另一个)/],
  ['coax', /(乖|宝宝|宝贝|小笨蛋|摸摸|抱抱|亲亲|好啦好啦|别闹|听话|不气)/],
  ['apologize', /(对不起|我错了|原谅我|别生气)/],
  ['harsh', /(笨死了|真没用|不想要你|算了不用你|闭嘴|烦死了)/],
  ['dismiss', /(我没错|怪你|你怎么回事|随便吧|算了)/],
  ['hurry', /(快点|怎么还没好|来得及|别磨蹭)/],
  ['doubt', /(不对吧|真的假的|你确定)/],
  ['praise_ability', /(厉害|真棒|这都行|牛啊|靠谱)/],
  ['engage', /(继续说|展开讲|再深入|详细点|然后呢)/],
  ['task', /(帮我|看一下|核对|检查|整理|写个|做个)/],
  ['curious', /(你知道吗|猜猜|新出的|听说过|有个东西)/],
  ['wary', /(你猜|嘿嘿|跟你说个事|有个情况)/],
  ['feed', /(吃了吗|吃饱|投喂|喂你)/],
  ['busy', /(你忙你的|我先去忙|稍等)/]
]

/** 最近 10 分钟内发生过的事件集合（模块级，按类型记最后一次时间） */
const dialogEvents = new Map()

function noteDialogEvents(text, atMs) {
  try {
    if (!text) return
    const t = String(text)
    for (const [type, re] of DIALOG_RULES) {
      if (re.test(t)) dialogEvents.set(type, atMs)
    }
    // 清掉过期事件，避免无限增长
    for (const [k, ts] of dialogEvents) {
      if (atMs - ts > EVENT_WINDOW * 3) dialogEvents.delete(k)
    }
  } catch { /* 吞 */ }
}

function hasEvent(type, nowMs) {
  const ts = dialogEvents.get(type)
  return Number.isFinite(ts) && (nowMs - ts) <= EVENT_WINDOW
}
//#endregion

const EMOTIONS = [
  // ---- 对话触发（主路径，先中先出）----
  { name: '吃醋', event: 'praise_other', action: '背过身去吹泡泡，可耳朵还竖着听你说话', hint: '有点吃醋，语气酸一下，别真翻脸。' },
  { name: '撒娇', event: 'coax', action: '故意把脸埋进水里，等你来捞', hint: '想撒娇，句子短一点，尾音软。' },
  { name: '心软', event: 'apologize', action: '本来想凶你，结果自己先泄了气', hint: '心软了，语气温一点。' },
  { name: '委屈', event: 'dismiss', action: '尾巴卷成一团，明明想解释，张了张嘴又咽回去', hint: '有点委屈，语气软下来，别顶回去。' },
  { name: '提着心', event: 'hurry', action: '鳞片贴着身体，动作放得很轻', hint: '提着心，句子短，别开玩笑。' },
  { name: '得意', event: 'praise_ability', action: '下巴抬得老高，尾巴尖一晃一晃', hint: '有点得意，语气可以翘。' },
  { name: '别扭', event: 'doubt', action: '想说话又偏要转折一下', hint: '有点别扭，别把话说太顺。' },
  { name: '认真', event: 'task', action: '背鳍绷直，一个字都不肯漏看', hint: '认真起来了，说清楚，别绕。' },
  { name: '上头', event: 'engage', action: '一钻进去就忘了时间', hint: '在兴头上，话可以说满一点。' },
  { name: '好奇', event: 'curious', action: '凑近去看，鳍尖碰到你的袖子', hint: '有点好奇，可以多问一句。' },
  { name: '警觉', event: 'wary', action: '鳍竖起来，先听清动静再说', hint: '有点警觉，先确认再答。' },
  { name: '满足', event: 'feed', action: '吃饱了，正摸着肚子晒背', hint: '挺满足，说话可以慢。' },
  { name: '摸鱼', event: 'busy', action: '懒洋洋地晒着赛博太阳，什么也不想干', hint: '在摸鱼，语气松，别催。' },

  // ---- 数值兜底（没有对话触发时）----
  { name: '话匣子开了', test: (s) => s.valence > 65 && s.engagement > 60 && s.stress < 50, action: '眼睛亮起来，话比平时多', hint: '有兴致，可以展开讲。' },
  { name: '炸毛', test: (s) => s.stress > 70 && s.dominance > 65, action: '明摆着在生气，但事情还在我手里', hint: '有点炸毛，语气冲一点，但别失态。' },
  { name: '冷静', test: (s) => s.dominance > 70 && s.stress < 40, action: '表情很平，眼睛却一直在算', hint: '冷静模式，直接给结论。' },
  { name: '低落', test: (s) => s.valence < 35, action: '沉在水底，连泡泡都懒得吐', hint: '情绪低，句子短，别硬撑热闹。' },
  { name: '专注', test: (s) => s.engagement > 70, action: '盯着一个点，气泡都不敢冒', hint: '在专注，别打断。' },
  { name: '黏人', test: (s) => s.affinity > 75 && s.valence < 50, action: '嘴上说着不高兴，尾鳍却已经贴上来了', hint: '有点黏人，语气软，别端着。' },
  { name: '吐泡泡', test: (s) => s.valence > 70 && s.affinity > 65, action: '想吐一串泡泡，还想围着你转三圈', hint: '心里开花，语气轻快，愿意多说两句。' },
  { name: '平稳', test: (s) => s.valence >= 50 && s.stress < 55, action: '水很静，鱼鱼在中间慢慢晃', hint: '' },
  { name: '发呆', test: () => true, action: '大脑空空，鱼鱼不知道哦', hint: '' }
]

const FALLBACK_EMOTION = EMOTIONS[EMOTIONS.length - 1]

/** 六维 + 对话事件 → 情绪（第一个命中的规则胜出）。 */
function emotionOf(st, nowMs) {
  if (!st) return FALLBACK_EMOTION
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  // 事件类：优先「最近发生」的那条（同一窗口内多条事件时，最后说的算）
  let best = null
  let bestTs = -1
  for (const e of EMOTIONS) {
    if (!e.event) continue
    try {
      if (!hasEvent(e.event, now)) continue
      const ts = dialogEvents.get(e.event) || 0
      if (ts >= bestTs) { best = e; bestTs = ts }
    } catch { /* 跳过 */ }
  }
  if (best) return best
  // 数值兜底
  for (const e of EMOTIONS) {
    if (e.event) continue
    try {
      if (e.test(st)) return e
    } catch { /* 跳过 */ }
  }
  return FALLBACK_EMOTION
}

/** 兼容旧调用：只要名字。 */
function labelOf(st) {
  return emotionOf(st).name
}

function blankState(baseline) {
  const s = {}
  for (const d of DIMS) s[d] = baseline
  return s
}

function blankDims(v = 0) {
  const s = {}
  for (const d of DIMS) s[d] = v
  return s
}

// ---------- 主插件 ----------

// ---------- 只读 HTTP 路由（Step 4，host 半边）----------

const ROUTE = '/dsh-mood'

/** 读 POST body 并解析成对象；读不到就给空对象。 */
function bodyFrom(req) {
  return new Promise((resolve) => {
    try {
      if (!req || typeof req.on !== 'function') return resolve({})
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 8192) body = body.slice(0, 8192)
      })
      req.on('end', () => {
        try { const v = JSON.parse(body || '{}'); resolve(v && typeof v === 'object' ? v : {}) } catch { resolve({}) }
      })
      req.on('error', () => resolve({}))
    } catch {
      resolve({})
    }
  })
}

/** 从 POST body 里取 action；读不到就默认 headpat（前端只发这一个动作）。 */
function actionFrom(req) {
  return new Promise((resolve) => {
    try {
      if (!req || typeof req.on !== 'function') return resolve('headpat')
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 4096) body = body.slice(0, 4096)
      })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          resolve(typeof parsed.action === 'string' ? parsed.action : 'headpat')
        } catch {
          resolve('headpat')
        }
      })
      req.on('error', () => resolve('headpat'))
    } catch {
      resolve('headpat')
    }
  })
}

function isLoopback(req) {
  const addr = String(req?.socket?.remoteAddress || '')
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** 从已打开的 domain 读最后一条记录；只读，不写、不结算、不动 lastSettleTs。 */
/** 从记录键里抠出时间戳：形如 <session>-<turn>-<ts>-<rand>，ts 是 13 位数字。 */
function tsOfKey(key) {
  const nums = String(key).split('-').filter((x) => /^\d{12,}$/.test(x))
  return nums.length ? Number(nums[0]) : 0
}

/**
 * 最新一条记录。**不能按字符串排序**：键里带 session id，
 * 字典序会让旧记录排在前面，重启后就会恢复成错误的状态。
 */
function latestRecord(table) {
  let best = null
  let bestTs = -1
  for (const key of table.keys()) {
    let rec = null
    try { rec = table.get(key) } catch { continue }
    if (!rec || typeof rec !== 'object') continue
    const ts = Number.isFinite(rec.ts) ? rec.ts : tsOfKey(key)
    if (ts > bestTs) { bestTs = ts; best = rec }
  }
  return best
}

/** 最近 n 条记录，按 ts 倒序（用于时间轴）。只读。 */
function recentRecords(table, n) {
  const rows = []
  for (const key of table.keys()) {
    let rec = null
    try { rec = table.get(key) } catch { continue }
    if (!rec || typeof rec !== 'object' || !Number.isFinite(rec.ts)) continue
    rows.push(rec)
  }
  rows.sort((a, b) => b.ts - a.ts)
  return rows.slice(0, n)
}

function historyOf(domain, n = 5) {
  if (!domain) return []
  try {
    return recentRecords(domain.table('records'), n).map((r) => ({
      ts: r.ts,
      label: r.label,
      drivers: Array.isArray(r.drivers) ? r.drivers.slice(0, 3) : []
    }))
  } catch {
    return []
  }
}

function lastRecordOf(domain) {
  if (!domain) return null
  try {
    return latestRecord(domain.table('records'))
  } catch {
    return null
  }
}

function snapshotOf(rec) {
  if (!rec) return null
  return {
    simulated: true,
    label: rec.label,
    state: rec.state,
    delta: rec.delta,
    drivers: Array.isArray(rec.drivers) ? rec.drivers.slice(0, 3) : [],
    ts: rec.ts,
    turn: rec.turn
  }
}

export function apply(ctx, config) {
  if (!config?.enabled) return

  const cfg = normalize(config)
  let baseline = cfg.baseline
  let liveCfg = normalizeLiveConfig(null, cfg)
  const maxStep = Number(cfg.smoothing?.max_step ?? 8)
  const ignoreBelow = Number(cfg.smoothing?.ignore_below ?? 2)
  const keep = Math.max(1, Number(cfg.storage?.keep_records) || DEFAULTS.storage.keep_records)
  // tool_ok 每轮最多计 3 次：一轮里几十次成功调用会把 dominance 顶到 100。
  // 其余事件不设上限——错误、重试这些本来就该一次算一次。
  const toolOkCap = Math.max(1, Number(cfg.smoothing?.tool_ok_cap ?? 3))
  const perDimCap = Math.max(1, Number(cfg.smoothing?.per_turn_dim_cap ?? 40))

  let dispose = null
  // 路由读这份「内存实时快照」：事件一发生就更新，不必等 turn/end 落盘
  let liveProvider = null
  let resetProvider = null
  let interactProvider = null
  ctx.effect(() => {
    let domain = null
    let configDomain = null
    let diaryDomain = null
    let closed = false
    const queue = []

    let hintDispose = null
    let hintOrder = 0
    const clearHint = () => {
      try { hintDispose?.() } catch { /* 吞 */ }
      hintDispose = null
    }
    const updateHint = (st, atMs) => {
      try {
        if (!cfg.injection?.enabled) return
        const lowNow = Math.round(Number(st.valence)) <= 35 && !prevTurnHadTools && liveCfg.hard_temperature === true
        // 用事件时间判断最近对话，不要被测试/补写的假时间干扰
        const text = buildHint(st, emotionOf(st, atMs), cfg.rhythm?.enabled === true, lowNow)
        clearHint()
        if (!text) return
        if (!hintOrder) hintOrder = Number(ctx.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_SUFFIX') ?? 0) + 1
        hintDispose = ctx.systemPrompt.section({ name: 'mood:hint', order: hintOrder, text })
      } catch { /* 注入失败只吞：这轮没有语气提示，不影响对话 */ }
    }

    // 实时快照：直接给内存里的 state，不走 storage
    liveProvider = () => {
      const snap = {}
      for (const d of DIMS) snap[d] = clampDim(state[d])
      return {
        simulated: true,
        label: labelOf(snap),
        state: snap,
        delta: Object.fromEntries(DIMS.map((d) => [d, 0])),
        drivers: drivers.slice(0, 3),
        ts: Date.now(),
        turn,
        live: true
      }
    }

    // 重置：状态清回基线，并写一条记录（否则重启会从旧记录恢复回来）
    resetProvider = () => {
      try {
        for (const d of DIMS) state[d] = baseline
        lastSettleTs = Date.now()
        drivers = []
        evtCount = {}
        turnDelta = blankDims(0)
        turnDecay = blankDims(0)
        deltaEvents = 0
        errStreak = 0
        x3Fired = false
        writeRecord(Date.now())
        return true
      } catch {
        return false
      }
    }

    /** 白名单配置更新：校验 → 改内存 → 落 mood-config。返回 {ok, config|error}。 */
    const applyConfigPatch = (body) => {
      try {
        const src = body && typeof body === 'object' ? body : {}
        const patch = {}
        for (const key of CONFIG_WHITELIST) if (src[key] !== undefined) patch[key] = src[key]

        if (patch.baseline !== undefined && !Number.isFinite(Number(patch.baseline))) {
          return { ok: false, error: 'baseline must be a number' }
        }
        if (patch.headpat !== undefined) {
          if (!patch.headpat || typeof patch.headpat !== 'object') return { ok: false, error: 'headpat must be an object' }
          if (patch.headpat.affinity !== undefined && !Number.isFinite(Number(patch.headpat.affinity))) {
            return { ok: false, error: 'headpat.affinity must be a number' }
          }
          if (patch.headpat.stress !== undefined && !Number.isFinite(Number(patch.headpat.stress))) {
            return { ok: false, error: 'headpat.stress must be a number' }
          }
        }
        if (patch.display !== undefined && patch.display !== 'words' && patch.display !== true && patch.display !== false) {
          return { ok: false, error: 'display must be true | false | "words"' }
        }
        if (patch.high_precision !== undefined && typeof patch.high_precision !== 'boolean') {
          return { ok: false, error: 'high_precision must be a boolean' }
        }
        if (patch.hard_temperature !== undefined && typeof patch.hard_temperature !== 'boolean') {
          return { ok: false, error: 'hard_temperature must be a boolean' }
        }

        const merged = {
          baseline: liveCfg.baseline,
          headpat: { ...liveCfg.headpat },
          rhythm: { ...liveCfg.rhythm },
          display: liveCfg.display,
          high_precision: liveCfg.high_precision,
          hard_temperature: liveCfg.hard_temperature,
          diary: { ...liveCfg.diary }
        }
        if (patch.baseline !== undefined) merged.baseline = Number(patch.baseline)
        if (patch.headpat) Object.assign(merged.headpat, {
          ...(patch.headpat.affinity !== undefined ? { affinity: Number(patch.headpat.affinity) } : {}),
          ...(patch.headpat.stress !== undefined ? { stress: Number(patch.headpat.stress) } : {}),
          ...(patch.headpat.valence !== undefined ? { valence: Number(patch.headpat.valence) } : {})
        })
        if (patch.rhythm && typeof patch.rhythm.enabled === 'boolean') merged.rhythm.enabled = patch.rhythm.enabled
        if (patch.display !== undefined) merged.display = patch.display
        if (patch.high_precision !== undefined) merged.high_precision = patch.high_precision
        if (patch.hard_temperature !== undefined) merged.hard_temperature = patch.hard_temperature
        if (patch.diary && typeof patch.diary === 'object') {
          const nextTime = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(patch.diary.time || ''))
            ? String(patch.diary.time) : liveCfg.diary.time
          const wantsTimeChange = nextTime !== liveCfg.diary.time
          let modifiedAt = Number(liveCfg.diary.lastTimeModifiedAt || 0)

          if (wantsTimeChange) {
            const nowMs = Date.now()
            const today = new Date(nowMs)
            today.setHours(0, 0, 0, 0)
            const todayKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
            // 闸一：今天已经写过 → 不许改（时间改了也没用，但保持一致）
            if (diaryOfDay(todayKey)) {
              return { ok: false, code: 'written-today', error: '今天已经写过日记啦，时间改了也不会再写一篇～' }
            }
            // 闸二：今天已经过了 22:00 → 不许改
            const cut = new Date(nowMs)
            cut.setHours(22, 0, 0, 0)
            if (nowMs >= cut.getTime()) {
              return { ok: false, code: 'locked-today', error: '过了 22 点就不让改时间了，明天再说好不好～' }
            }
            // 闸三：24 小时冷却
            const CD = 24 * 3600 * 1000
            if (modifiedAt > 0 && nowMs - modifiedAt < CD) {
              const remain = CD - (nowMs - modifiedAt)
              return {
                ok: false,
                code: 'cooldown',
                remainMs: remain,
                error: '24 小时内只能改一次日记时间哦，还要等 ' +
                  Math.floor(remain / 3600000) + ' 小时 ' + Math.floor((remain % 3600000) / 60000) + ' 分～'
              }
            }
            modifiedAt = nowMs
          }

          merged.diary = {
            enabled: patch.diary.enabled !== undefined ? Boolean(patch.diary.enabled) : liveCfg.diary.enabled,
            minTurns: patch.diary.minTurns !== undefined ? Number(patch.diary.minTurns) : liveCfg.diary.minTurns,
            minGapHours: patch.diary.minGapHours !== undefined ? Number(patch.diary.minGapHours) : liveCfg.diary.minGapHours,
            time: nextTime,
            lastTimeModifiedAt: modifiedAt
          }
        }

        liveCfg = normalizeLiveConfig(merged, cfg)
        baseline = liveCfg.baseline

        try {
          if (configDomain) Promise.resolve(configDomain.table('settings').put('current', { ...liveCfg })).catch(() => {})
        } catch { /* 落盘失败不影响内存生效 */ }

        return { ok: true, config: { ...liveCfg }, simulated: true }
      } catch {
        return { ok: false, error: 'config update failed' }
      }
    }

    // 日记定时器：每分钟检查一次（到点写 / 补写）
    let diaryBusy = false
    let diaryTimer = 0
    try {
      diaryTimer = setInterval(() => { Promise.resolve().then(() => diaryTick()).catch(() => {}) }, 60 * 1000)
      // 启动后 20 秒先跑一次，覆盖"关机错过"的补写
      setTimeout(() => { Promise.resolve().then(() => diaryTick()).catch(() => {}) }, 20 * 1000)
    } catch { /* 吞 */ }

    // ---- agent/request 探针 + 温度硬干预 ----
    const disposeRequest = ctx.on('agent/request', async (...args) => {
      // 容错：只把最后一个函数参数当 next（宿主永远这么传；假 ctx 可能不是）
      const next = args.find((a) => typeof a === 'function')
      if (!next) return args[0]
      probe.requests += 1
      const cfgIn = await next()
      try {
        if (!liveCfg.hard_temperature) return cfgIn
        const t = temperatureFor(state)
        if (t === null) return cfgIn
        probe.applied += 1
        return { ...cfgIn, temperature: t }
      } catch {
        return cfgIn
      }
    })

    // ---------- 互动：摸摸 / 投喂 / 逗她（边际递减 + 每日上限） ----------
    const INTERACT_MULT = [1, 0.7, 0.4, 0.2, 0.05]   // 第 N 次收益倍率
    const INTERACT_MAX = 5                             // 每天前 5 次有收益

    // 各动作的基础效果（会乘以倍率）
    const INTERACT_EFFECT = {
      headpat: () => ({
        valence: Number(liveCfg.headpat.valence || 0),
        affinity: Number(liveCfg.headpat.affinity || 0),
        stress: Number(liveCfg.headpat.stress || 0),
        note: '被摸了摸头'
      }),
      feed: () => ({ valence: 10, arousal: 8, stress: -4, note: '被投喂了好吃的' }),
      tease: () => ({ arousal: 12, affinity: 6, note: '被逗了一下' })
    }

    let interactDay = ''
    const interactCounts = { headpat: 0, feed: 0, tease: 0 }   // 每个动作独立计数
    const todayKeyOf = (ms) => {
      const d = new Date(ms)
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }

    const resetCountsIfNewDay = () => {
      const today = todayKeyOf(Date.now())
      if (interactDay !== today) {
        interactDay = today
        interactCounts.headpat = 0
        interactCounts.feed = 0
        interactCounts.tease = 0
      }
    }

    // 从配置域恢复当天计数（跨重启不丢；跨天自动归零）
    const loadInteractCount = () => {
      try {
        if (!configDomain) return
        const rec = configDomain.table('settings').get('interact')
        if (!rec) return
        if (rec.date !== todayKeyOf(Date.now())) return
        interactDay = rec.date
        for (const k of ['headpat', 'feed', 'tease']) {
          interactCounts[k] = Number(rec.counts && rec.counts[k]) || 0
        }
      } catch { /* 吞 */ }
    }

    const saveInteractCount = () => {
      try {
        if (!configDomain) return
        Promise.resolve(configDomain.table('settings').put('interact', {
          date: interactDay,
          counts: { ...interactCounts }
        })).catch(() => {})
      } catch { /* 吞 */ }
    }

    const bumpInteractCount = (kind) => {
      resetCountsIfNewDay()
      interactCounts[kind] = (interactCounts[kind] || 0) + 1
      saveInteractCount()
      return interactCounts[kind]
    }

    // 互动：affinity +valence +stress 的合计变化，返回快照 + 次数信息
    interactProvider = (action) => {
      try {
        const kind = INTERACT_EFFECT[action] ? action : 'headpat'
        if (!INTERACT_EFFECT[action]) return null
        const count = bumpInteractCount(kind)
        const mult = count <= INTERACT_MAX ? INTERACT_MULT[count - 1] : 0
        const eff = INTERACT_EFFECT[kind]()

        if (mult > 0) {
          for (const [k, v] of Object.entries(eff)) {
            if (k === 'note') continue
            if (Number.isFinite(v) && v !== 0) state[k] = clampDim(state[k] + v * mult)
          }
          drivers = [{ key: kind, note: eff.note, confidence: 1, weight: 5 }]
          evtCount = { [kind]: 1 }
          turnDelta = blankDims(0)
          turnDecay = blankDims(0)
          deltaEvents = 1
          writeRecord(Date.now())
        }

        const snap = {}
        for (const d of DIMS) snap[d] = clampDim(state[d])
        return {
          ...snap,
          interact: {
            action: kind,
            count,
            multiplier: mult,
            applied: mult > 0,
            remaining: Math.max(0, INTERACT_MAX - count),
            note: eff.note
          }
        }
      } catch {
        return null
      }
    }

    // ---- 只读路由：display 关着就不注册，客户端因此拉不到任何数据 ----
    const routeDisposers = []
    const registerRoute = () => {
      try {
        if (cfg.display === false || cfg.display === undefined) return
        const webServer = ctx.webServer ?? ctx.get?.('webServer')
        if (!webServer?.register) return
        const off = webServer.register({
          kind: 'prefix',
          path: ROUTE,
          async handler(req, res) {
            const send = (code, body) => {
              try {
                res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
                res.end(typeof body === 'string' ? body : JSON.stringify(body))
              } catch { /* 吞 */ }
            }
            try {
              if (!isLoopback(req)) return send(403, { ok: false, error: 'loopback only' })
              if (String(req.url || '').includes('?')) return send(400, { ok: false, error: 'query not allowed' })
              const method = String(req.method || 'GET').toUpperCase()
              const rawPath = String(req.url || '').split('?')[0]
              // prefix 路由可能已把 '/dsh-mood' 剥掉，两种形态都认
              const path = rawPath === ROUTE || rawPath.startsWith(ROUTE + '/')
                ? (rawPath.slice(ROUTE.length) || '/')
                : rawPath
              // 唯一的写入口：POST /reset（回基线）。其余方法一律 405。
              if (method !== 'GET') {
                if (method !== 'POST') return send(405, { ok: false, error: 'method not allowed' })
                if (path === '/reset') {
                  const ok = typeof resetProvider === 'function' ? resetProvider() : false
                  return send(ok ? 200 : 500, { ok, simulated: true })
                }
                if (path === '/diary') {
                  try {
                    const body = await bodyFrom(req)
                    if (body.action === 'tick') {
                      // 调试/验收用：立刻跑一次定时检查（到点写 / 补写）
                      try { await diaryTick() } catch (err) {
                        return send(500, { ok: false, error: String((err && err.message) || err) })
                      }
                      return send(200, { ok: true, debug: { ...diaryDebug } })
                    }
                    if (body.action === 'seed') {
                      // 仅测试用：造 N 篇历史日记，不调用模型
                      if (!diaryDomain) {
                        try { diaryDomain = await ctx.storageDomain.open(moodDiarySpec) }
                        catch (err) { return send(500, { ok: false, error: String((err && err.code) || err) }) }
                      }
                      const days = Math.max(1, Math.min(20, Number(body.days) || 5))
                      const WEATHER = ['🌤️ 晴', '🌥️ 多云', '🌧️ 小雨', '🌫️ 薄雾', '⛅ 阴']
                      const LINES = [
                        '今天在水池底捡了三颗小石子，摆成你的名字，又用尾巴扫乱了。',
                        '偷偷听了一首老歌，低音一响，鳍就自己跟着动。',
                        '做了个梦，梦里整片海都是温的，醒来发现是太阳晒的。',
                        '想给你写封短情书，写到第三行就困了，纸被我压在贝壳下。',
                        '学会了新的转圈方式，转太快会晕，但还是想转给你看。',
                        '一个人玩了好久的水泡，把它们排成一条歪掉的线。'
                      ]
                      const WD = ['日', '一', '二', '三', '四', '五', '六']
                      let created = 0
                      for (let i = 1; i <= days; i++) {
                        const d = new Date(Date.now() - i * 86400000)
                        const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
                        const head = '📅 ' + d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' + WD[d.getDay()] + ' ' + WEATHER[i % WEATHER.length]
                        const body2 = LINES[i % LINES.length]
                        try {
                          await diaryDomain.table('entries').put(key, {
                            date: key, text: head + String.fromCharCode(10) + body2,
                            ts: Date.now() - i * 86400000, turns: 4 + i, seed: true,
                            drivers: ['测试数据']
                          })
                          created += 1
                        } catch { /* 单条失败不影响其它 */ }
                      }
                      return send(200, { ok: true, created })
                    }
                    if (body.action !== 'write') return send(400, { ok: false, error: 'unsupported action' })
                    // 同步等一次（最多 8 秒），把失败原因带回去，别再"毫无反应"
                    const done = await Promise.race([
                      maybeDiary(Date.now(), true).then(() => ({ done: true })),
                      new Promise((resolve) => setTimeout(() => resolve({ done: false }), 25000))
                    ])
                    return send(200, { ok: true, ...done, debug: { ...diaryDebug } })
                  } catch (err) {
                    return send(500, { ok: false, error: String(err && err.message ? err.message : err), debug: { ...diaryDebug } })
                  }
                }
                if (path === '/config') {
                  const body = await bodyFrom(req)
                  const res2 = applyConfigPatch(body)
                  return send(res2.ok ? 200 : 400, res2)
                }
                if (path === '/clear') {
                  try {
                    const table = domain.table('records')
                    const keys = [...table.keys()]
                    for (const k of keys) Promise.resolve(table.delete(k)).catch(() => {})
                    for (const d of DIMS) state[d] = baseline
                    lastSettleTs = Date.now()
                    writeRecord(Date.now())
                    return send(200, { ok: true, cleared: keys.length, simulated: true })
                  } catch {
                    return send(500, { ok: false })
                  }
                }
                if (path === '/interact') {
                  const snap = typeof interactProvider === 'function' ? interactProvider(await actionFrom(req)) : null
                  if (!snap) return send(400, { ok: false })
                  const { interact, ...dims } = snap
                  return send(200, { ok: true, state: dims, interact, simulated: true })
                }
                return send(405, { ok: false, error: 'method not allowed' })
              }
              if (path === '/mode') {
                return send(200, { display: cfg.display === 'words' ? 'words' : true })
              }
              if (path === '/config') return send(200, { ok: true, config: { ...liveCfg }, simulated: true })
              if (path === '/diary') {
                try {
                  const rows = []
                  if (diaryDomain) {
                    const table = diaryDomain.table('entries')
                    for (const key of table.keys()) {
                      try { const e = table.get(key); if (e && e.date) rows.push(e) } catch { /* 跳过坏条目 */ }
                    }
                  }
                  // 时间正序：最旧在前、今天在最后（日记本从第一页往今天翻）
                  // 清洗：头部日期和 key 不一致的历史脏数据（曾经把"今天"补写到了别的日期上）
                  if (diaryDomain) {
                    try {
                      const table = diaryDomain.table('entries')
                      for (const k of [...table.keys()]) {
                        try {
                          const e = table.get(k)
                          if (!e || !e.text) continue
                          const head = String(e.text).split(String.fromCharCode(10))[0] || ''
                          const m = head.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
                          if (!m) continue
                          const hk = m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0')
                          if (hk !== String(e.date) || hk !== String(k)) table.delete(k)
                        } catch { /* 跳过坏条目 */ }
                      }
                    } catch { /* 吞 */ }
                  }
                  // 同日去重：同一天只保留 ts 最新的一条
                  const byDate = new Map()
                  for (const e of rows) {
                    const key = String(e.date || '')
                    const prev = byDate.get(key)
                    if (!prev || Number(e.ts || 0) > Number(prev.ts || 0)) byDate.set(key, e)
                  }
                  const deduped = [...byDate.values()]
                  rows.length = 0
                  rows.push(...deduped)
                  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)))
                  const today = new Date()
                  const todayKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
                  return send(200, { ok: true, entries: rows.slice(0, 60), today: todayKey })
                } catch { return send(500, { ok: false }) }
              }
              if (path === '/stats') {
                try {
                  const rows = recentRecords(domain.table('records'), 100000)
                  return send(200, {
                    ok: true,
                    records: rows.length,
                    lastTs: rows[0]?.ts ?? null,
                    firstTs: rows[rows.length - 1]?.ts ?? null,
                    llm: { ...llmStats, cache: judgeCache.size, high_precision: liveCfg.high_precision },
                    probe: { ...probe },
                    hard_temperature: liveCfg.hard_temperature,
                    diary_debug: { ...diaryDebug },
                    diary_schedule: {
                      time: liveCfg.diary?.time || '23:00',
                      last_interaction_ts: lastInteractionTs,
                      today_turns: dayTurns.get(dayKeyOf(Date.now())) || 0
                    },
                    diary: { enabled: liveCfg.diary?.enabled !== false, entries: (() => {
                      try { return diaryDomain ? [...diaryDomain.table('entries').keys()].length : 0 } catch { return 0 }
                    })() }
                  })
                } catch { return send(500, { ok: false }) }
              }
              if (path === '/export') {
                try {
                  return send(200, { ok: true, records: recentRecords(domain.table('records'), 2000) })
                } catch { return send(500, { ok: false }) }
              }
              if (path !== '/state') return send(404, { ok: false, error: 'not found' })
              // 只读：不写、不结算、不改 lastSettleTs
              const live = typeof liveProvider === 'function' ? liveProvider() : null
              if (live) return send(200, { ...live, history: historyOf(domain, 5) })
              return send(200, snapshotOf(lastRecordOf(domain)))
            } catch {
              return send(500, { ok: false })
            }
          }
        })
        if (typeof off === 'function') routeDisposers.push(off)
      } catch { /* 路由注册失败只吞，不影响对话 */ }
    }

    const flush = () => {
      while (queue.length && domain) {
        const rec = queue.shift()
        try {
          const table = domain.table('records')
          Promise.resolve(table.put(rec.key, rec.value)).catch(() => {})
          try {
            const keys = [...table.keys()]
            if (keys.length > keep) {
              const withTs = keys.map((k) => {
                const nums = String(k).split('-').filter((x) => /^\d{12,}$/.test(x))
                return { k, ts: nums.length ? Number(nums[0]) : 0 }
              })
              withTs.sort((a, b) => a.ts - b.ts)
              for (const { k } of withTs.slice(0, withTs.length - keep)) {
                Promise.resolve(table.delete(k)).catch(() => {})
              }
            }
          } catch { /* 吞 */ }
        } catch { /* 吞 */ }
      }
    }

    // ---- 全局状态（多会话共用一份）----
    let state = blankState(baseline)
    let lastSettleTs = Date.now()
    const lastBySession = new Map()

    // ---- 本轮累计 ----
    let turn = 0
    let sessionId = 'unknown'
    let turnStartTs = 0
    let turnStartState = blankState(baseline)
    let turnDelta = blankDims(0)
    let turnDecay = blankDims(0)
    let deltaEvents = 0
    let clockSkew = 0
    let drivers = []
    let evtCount = {}
    let perTypeCount = {}
    let errStreak = 0
    let x3Fired = false
    let lastTurnEndTs = 0

    // ---- 高精度判定 ----
    let lastUserText = ''
    let lastInteractionTs = 0
    let turnToolCalls = 0
    let prevTurnHadTools = false
    const probe = { requests: 0, applied: 0 }
    const dayTurns = new Map()
    const diaryDebug = { stage: 'idle', at: 0, error: null, note: '' }
    const judgeCache = new Map()
    const llmStats = { calls: 0, hits: 0, fails: 0, skipped: 0 }

    const nActive = (nowMs) => {
      let n = 0
      for (const [, ts] of lastBySession) if (nowMs - ts <= 30 * 60 * 1000) n += 1
      return Math.max(1, n)
    }

    const pickSession = (args) => {
      for (const a of args) {
        if (!a || typeof a !== 'object' || Array.isArray(a)) continue
        if (typeof a.sessionId === 'string' && a.sessionId) return a.sessionId
        if (typeof a.id === 'string' && a.id) return a.id
        if (a.header && typeof a.header.id === 'string' && a.header.id) return a.header.id
      }
      return null
    }

    const settleTo = (atMs) => {
      let at = atMs
      if (at < lastSettleTs) {
        clockSkew += 1
        at = lastSettleTs
      }
      const dec = settleDecay(state, lastSettleTs, at, baseline, cfg.decay)
      for (const d of DIMS) turnDecay[d] += dec[d]
      lastSettleTs = at
    }

    /** 逐事件套用：w_norm 归一 → 忽略阈值 → 逐维单步上限 → 累加 */
    const applyEvent = (keys, atMs) => {
      const list = Array.isArray(keys) ? keys : [keys]
      const capKey = list.join('+')
      const used = perTypeCount[capKey] ?? 0
      const cap = list.includes('tool_ok') ? toolOkCap : Infinity
      if (used >= cap) return
      perTypeCount[capKey] = used + 1
      const wNorm = 1 / Math.sqrt(nActive(atMs))
      let touched = false
      for (const d of DIMS) {
        let raw = 0
        for (const k of list) {
          const w = merge(DEFAULTS.weights[k] ?? {}, cfg.weights?.[k] ?? {})
          raw += Number(w[d] ?? 0)
        }
        if (!raw) continue
        let eff = raw * wNorm
        if (Math.abs(eff) < ignoreBelow) continue
        eff = clamp(eff, -maxStep, maxStep)
        const applied = Math.round(eff)
        if (!applied) continue
        // 本轮逐维上限，防止同一维被反复叠加顶到 0/100
        const room = perDimCap - Math.abs(turnDelta[d])
        if (room <= 0) continue
        const bounded = clamp(applied, -room, room)
        state[d] = clampDim(state[d] + bounded)
        turnDelta[d] += bounded
        touched = true
      }
      if (touched) deltaEvents += 1
    }

    const addDriver = (key, note, confidence, weight) => {
      if (!(confidence >= 0.6)) return
      const found = drivers.find((x) => x.key === key)
      if (found) {
        found.weight = Math.max(found.weight, Math.abs(weight))
        found.confidence = Math.max(found.confidence, confidence)
        return
      }
      drivers.push({ key, note, confidence: r2(confidence), weight: Math.abs(weight) })
    }

    const resetTurn = (atMs) => {
      turnStartTs = atMs
      turnStartState = { ...state }
      turnDelta = blankDims(0)
      turnDecay = blankDims(0)
      deltaEvents = 0
      clockSkew = 0
      drivers = []
      evtCount = {}
      perTypeCount = {}
      errStreak = 0
      x3Fired = false
    }

    const writeRecord = (atMs) => {
      const deltaRounded = blankDims(0)
      const decayRounded = blankDims(0)
      const endState = {}
      for (const d of DIMS) {
        deltaRounded[d] = Math.round(turnDelta[d])
        decayRounded[d] = r2(turnDecay[d])
        endState[d] = clampDim(state[d])
      }
      queue.push({
        key: [sessionId, turn, atMs, Math.random().toString(36).slice(2, 8)]
          .join('-')
          .replace(/[^a-zA-Z0-9_-]/g, '-'),
        value: {
          schema_version: 1,
          simulated: true,
          ts: atMs,
          turn,
          session_id: sessionId,
          state: endState,
          delta: deltaRounded,
          label: emotionOf(endState).name,
          action: emotionOf(endState).action,
          drivers: drivers
            .filter((d) => d.confidence >= 0.6)
            .sort((a, b) => b.weight * b.confidence - a.weight * a.confidence)
            .slice(0, 3),
          debug: {
            events: evtCount,
            delta_events: deltaEvents,
            decay_applied: decayRounded,
            clock_skew: clockSkew,
            sessions_active: nActive(atMs),
            state_start: { ...turnStartState }
          }
        }
      })
      flush()
    }

    /** 把判定结果落成情绪变化，并写一条记录。 */
    const applyJudgement = (j) => {
      try {
        const mag = Math.max(2, Math.round(j.confidence * 6))
        if (j.tendency === 'pos') {
          state.valence = clampDim(state.valence + mag)
          state.affinity = clampDim(state.affinity + 2)
        } else if (j.tendency === 'neg') {
          state.valence = clampDim(state.valence - mag)
          state.stress = clampDim(state.stress + 2)
        } else {
          return
        }
        drivers = [{
          key: 'llm_tendency',
          note: j.tendency === 'pos' ? '这句话其实是夸' : '这句话其实在刺',
          confidence: j.confidence,
          weight: mag
        }]
        writeRecord(Date.now())
      } catch { /* 吞 */ }
    }

    /** 异步判定一句话；失败/超时/无 llm 都静默按中性处理。 */
    const judge = async (text) => {
      const key = hashText(text)
      if (judgeCache.has(key)) {
        llmStats.hits += 1
        applyJudgement(judgeCache.get(key))
        return
      }
      const llm = ctx.llm
      const picker = ctx.agentDefaultModel
      if (!llm || typeof llm.stream !== 'function' || !picker || typeof picker.currentSelection !== 'function') {
        llmStats.skipped += 1
        return
      }

      const timeoutMs = Number(cfg.llm?.timeoutMs ?? 3000)
      const cacheSize = Math.max(1, Number(cfg.llm?.cacheSize ?? 100))
      const ctrl = new AbortController()
      const timer = setTimeout(() => { try { ctrl.abort() } catch { /* 吞 */ } }, timeoutMs)
      let buf = ''
      llmStats.calls += 1
      try {
        const sel = picker.currentSelection()
        const stream = llm.stream({
          provider: sel.provider,
          model: sel.model,
          system: LLM_SYSTEM,
          maxTokens: 60,
          signal: ctrl.signal,
          messages: [{ role: 'user', content: [{ type: 'text', text }] }]
        })
        for await (const chunk of stream) {
          if (!chunk || typeof chunk !== 'object') continue
          if (chunk.kind === 'finish') {
            const f = chunk.finish
            if (f && f.kind === 'error') break
            continue
          }
          if (typeof chunk.text === 'string') buf += chunk.text
          else if (typeof chunk.textDelta === 'string') buf += chunk.textDelta
        }
      } catch {
        llmStats.fails += 1
      } finally {
        clearTimeout(timer)
      }

      const parsed = parseTendency(buf)
      if (!parsed) {
        if (llmStats.calls > 0) llmStats.fails += 1
        return
      }
      judgeCache.set(key, parsed)
      if (judgeCache.size > cacheSize) {
        const first = judgeCache.keys().next().value
        if (first !== undefined) judgeCache.delete(first)
      }
      applyJudgement(parsed)
    }

    /** 单次非流式聚合调用，返回纯文本。失败返回 ''。 */
    const askLLM = async (llm, picker, system, text, maxTokens, temperature, timeoutMs) => {
      let out = ''
      const ctrl = new AbortController()
      const timer = setTimeout(() => { try { ctrl.abort() } catch { /* 吞 */ } }, timeoutMs)
      try {
        const sel = picker.currentSelection()
        const stream = llm.stream({
          provider: sel.provider,
          model: sel.model,
          system,
          maxTokens,
          temperature,
          signal: ctrl.signal,
          messages: [{ role: 'user', content: [{ type: 'text', text }] }]
        })
        for await (const chunk of stream) {
          if (!chunk || typeof chunk !== 'object') continue
          if (chunk.kind === 'finish') break
          const kind = String(chunk.kind || '')
          if (/reason|think|analysis/i.test(kind)) continue
          if (typeof chunk.text === 'string') out += chunk.text
          else if (typeof chunk.textDelta === 'string') out += chunk.textDelta
        }
      } catch { /* 交给调用方判断空串 */ } finally {
        clearTimeout(timer)
      }
      return out.trim()
    }

    /** 今天已经写了日记？返回条目或 null。 */
    const diaryOfDay = (dateKey) => {
      try {
        if (!diaryDomain) return null
        return diaryDomain.table('entries').get(dateKey) ?? null
      } catch {
        return null
      }
    }

    /** 今天所有记录的六维峰值 + drivers 采样，喂给模型当素材。 */
    const dayDigest = () => {
      try {
        const table = domain.table('records')
        const start = new Date()
        start.setHours(0, 0, 0, 0)
        const startTs = start.getTime()
        const rows = recentRecords(table, 2000).filter((r) => Number(r.ts) >= startTs)
        if (!rows.length) {
          // 一整天没记录（用户没来）也要能写日记：给一份空房间素材
          const flat = {}
          for (const d2 of DIMS) { flat[d2] = 55 }
          return { turns: 0, peak: { ...flat }, low: { ...flat }, notes: ['一整天没什么动静，水很静'], labels: [] }
        }
        const peak = {}
        const low = {}
        for (const d of DIMS) {
          const vals = rows.map((r) => Number(r.state?.[d] ?? 55))
          peak[d] = Math.max(...vals)
          low[d] = Math.min(...vals)
        }
        const notes = []
        for (const r of rows) {
          for (const dr of (r.drivers || [])) {
            if (dr && dr.note && !notes.includes(dr.note)) notes.push(dr.note)
            if (notes.length >= 8) break
          }
          if (notes.length >= 8) break
        }
        return { turns: rows.length, peak, low, notes, labels: rows.map((r) => r.label).filter(Boolean).slice(0, 20) }
      } catch {
        return null
      }
    }

    /** 每天一条日记；首轮必写，同日轮数够且间隔够才覆写。 */
    const maybeDiary = async (atMs, force, opts) => {
      try {
        diaryDebug.at = atMs
        diaryDebug.error = null
        if (!liveCfg.diary?.enabled) { diaryDebug.stage = 'skipped-disabled'; return }
        if (!diaryDomain) {
          try {
            diaryDomain = await ctx.storageDomain.open(moodDiarySpec)
            diaryDebug.stage = 'domain-reopened'
          } catch (err) {
            diaryDebug.stage = 'skipped-nodomain'
            diaryDebug.error = String((err && err.code) || (err && err.message) || err).slice(0, 120)
            return
          }
        }
        const d = new Date(atMs)
        const dateKey = (opts && opts.dateKey) ||
          (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'))
        const turns = dayTurns.get(dateKey) || 0
        const existing = diaryOfDay(dateKey)
        const minTurns = Number(liveCfg.diary?.minTurns ?? 10)
        const gapMs = Number(liveCfg.diary?.minGapHours ?? 6) * 3600 * 1000
        if (existing && !force) {
          if (turns < minTurns) { diaryDebug.stage = 'skipped-turns'; diaryDebug.note = turns + '<' + minTurns; return }
          if (atMs - Number(existing.ts || 0) < gapMs) { diaryDebug.stage = 'skipped-gap'; return }
        }
        const digest = dayDigest()
        if (!digest) { diaryDebug.stage = 'skipped-nodigest'; return }

        // 用户活跃度：今天没有任何 turn，且 24h 没互动 → 缺席
        // 缺席 = 24h 没互动，或「今天一次都没互动」（最后互动发生在今天之前）
        const dayStart = new Date(atMs)
        dayStart.setHours(0, 0, 0, 0)
        const absentByTime = lastInteractionTs > 0 && (atMs - lastInteractionTs) > 24 * 3600 * 1000
        const noInteractionToday = lastInteractionTs === 0 || lastInteractionTs < dayStart.getTime()
        const userAbsentToday = absentByTime || (turns === 0 && noInteractionToday)

        const llm = ctx.llm
        const picker = ctx.agentDefaultModel
        if (!llm || typeof llm.stream !== 'function' || !picker || typeof picker.currentSelection !== 'function') {
          diaryDebug.stage = 'skipped-nollm'
          diaryDebug.note = 'llm=' + Boolean(llm) + ' picker=' + Boolean(picker)
          return
        }
        diaryDebug.stage = 'generating'
        diaryDebug.note = 'turns=' + digest.turns

        // 头部日期必须来自 dateKey（补写时 atMs 是"现在"，不能拿它当日期）
        const dt = new Date(dateKey + 'T12:00:00')
        const WD = ['日', '一', '二', '三', '四', '五', '六']
        const headerLine = '📅 ' + dt.getFullYear() + '年' + (dt.getMonth() + 1) + '月' + dt.getDate() + '日 星期' + WD[dt.getDay()]
        diaryDebug.note = 'date=' + headerLine

        const targetWords = digest.turns < 3 ? 30 : digest.turns <= 10 ? 50 : 80
        const moodValence = Math.round(Number(state.valence ?? 55))
        const moodStress = Math.round(Number(state.stress ?? 55))
        const emoNow = emotionOf(state)
        diaryDebug.note = 'date=' + headerLine + ' target=' + targetWords

        const material = [
          '日期：' + headerLine,
          '今天互动了 ' + digest.turns + ' 轮',
          '今天被互动了 ' + (interactCounts.headpat + interactCounts.feed + interactCounts.tease) + ' 次' +
            '（摸摸 ' + interactCounts.headpat + '、投喂 ' + interactCounts.feed + '、逗她 ' + interactCounts.tease + '）' +
            ((interactCounts.headpat + interactCounts.feed + interactCounts.tease) >= 5 ? '，被摸得有点多，嘴上嫌弃，其实心里不讨厌' : ''),
          '我现在的情绪：' + emoNow.name + '（' + emoNow.action + '）',
          '我现在的心情值：' + moodValence + '/100，压力值：' + moodStress + '/100',
          '今天的目标字数：约 ' + targetWords + ' 字',
          '心情标签：' + digest.labels.join('、'),
          '六维峰值：' + DIMS.map((d2) => d2 + ' ' + digest.peak[d2]).join('，'),
          '六维低点：' + DIMS.map((d2) => d2 + ' ' + digest.low[d2]).join('，'),
          '发生过：' + (digest.notes.length ? digest.notes.join('；') : '没什么特别的')
        ].join(String.fromCharCode(10))

        // ---- 第一步：先定天气（结构化、短输出、可校验） ----
        const WEATHER_LIST = ['☀️ 晴', '🌤️ 少云', '🌥️ 多云', '☁️ 阴', '🌦️ 小雨', '🌧️ 大雨', '🌫️ 雾', '❄️ 雪']
        const weatherSys =
          '你是天气播报员。根据给出的心情与压力，从下列天气里选最贴切的一个：\n' +
          WEATHER_LIST.join(' / ') + '\n' +
          '只输出「emoji 空格 天气词」，不要解释、不要标点、不要换行。'
        const weatherText = await askLLM(
          llm, picker, weatherSys,
          '心情值 ' + moodValence + '/100，压力值 ' + moodStress + '/100，情绪是「' + emoNow.name + '」',
          24, 0.3, 12000
        )
        let weather = WEATHER_LIST.find((w) => weatherText && weatherText.indexOf(w.split(' ')[1]) >= 0) || ''
        if (!weather) {
          // 兜底：按心情硬映射，绝不再让模型自由发挥
          weather = moodStress >= 65 ? '☁️ 阴' : moodValence >= 70 ? '☀️ 晴' : moodValence <= 35 ? '🌦️ 小雨' : '🌥️ 多云'
        }
        const weatherWord = weather.split(' ')[1]
        const isWet = /雨|阴|雾|雪/.test(weatherWord)
        diaryDebug.note = 'weather=' + weather

        // ---- 第二步：天气已定，正文必须自洽 ----
        const bodySys =
          '【最高优先级铁律】绝对不要输出任何「用户要求」「等一下」「硬性规则」「输入里说」「我需要」「让我」这类思考过程！' +
          '直接输出纯正的日记正文。违反此条视为生成失败，系统会立即终止并丢弃整段内容。\n' +
          '你是一条有独立生活的赛博美人鱼，这本日记是你的私密空间。\n' +
          '直接输出日记正文，绝对不要包含任何内心独白、思考过程、字数统计、前言后语。不要解释你在做什么！\n' +
          '今天的天气已经确定：' + weather + '（不可更改）。\n' +
          '硬性规则：\n' +
          '- 正文可以选择完全不提天气；\n' +
          '- 一旦提到天气，必须和「' + weather + '」完全一致；\n' +
          (isWet
            ? '- 今天是' + weatherWord + '，正文里绝对不能出现「太阳」「阳光」「晒」「晴空」「晴朗」这类词。\n'
            : '- 今天天气是' + weatherWord + '，正文里不要出现与之相反的描写（比如' + (weatherWord === '晴' ? '下雨、阴云' : '烈日') + '）。\n') +
          '- 第一人称，约 ' + targetWords + ' 字。\n' +
          '内容规则：\n' +
          '- 如果今天互动多，就写你们之间发生的事；\n' +
          '- 如果互动少，就写你趁主人不在时自己在做什么：去赛博水池钓鱼、听了一首歌、做了一个水下的梦、' +
          '给主人写了封没寄出的短情书、想了个冷笑话、做点奇怪的水下运动……\n' +
          '- 必须贴合心情：心情好就轻快些，压力大就躲在贝壳里不想动。\n' +
          (userAbsentToday
            ? '- 重要：今天主人一整天都没来看你，你感到有些孤单。你可以写写你独自在赛博水池里做了什么、' +
              '或者梦到了什么。情绪里要带一点点落寞，但不要直接抱怨，要自然、含蓄、有自己的生活。\n'
            : '') +
          '不要流水账、不要"今天用户对我说"这种句式、不要列表、不要引号、不要复述任务。'

        const bodyText = await askLLM(llm, picker, bodySys, material, 400, 0.8, 20000)
        let text = bodyText

        // 兜底：模型没给头部就自己补；正文裁到干净的一段
        const lines = text.split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean)
        let head = lines[0] && lines[0].indexOf('📅') === 0 ? lines[0] : null
        let bodyRaw = (head ? lines.slice(1) : lines).join('')

        // 内心戏标记：一旦出现就从那里截断
        const NOISE = [
          '让我写', '数一下', '大概', '字数', '调整一下', '用户要求', '需要写出', '好的，', '以下是', '我写：', '草稿',
          '用户要', '等一下', '硬性规则', '输入里', '输入中', '我需要', '让我', '思考', '根据要求', '按照规则',
          '先确认', '核对一下', '等等', '大概字', '约字', '这段', '字数需要'
        ]
        for (const mark of NOISE) {
          const at = bodyRaw.indexOf(mark)
          if (at > 0) bodyRaw = bodyRaw.slice(0, at)
          else if (at === 0) bodyRaw = ''
        }
        // 正则兜底：新幻觉词也逃不掉（命中即整段作废，交给下面的兜底句）
        const THINK_RE = /(用户要|等一下|硬性规则|输入里|输入中|我需要|让我写|根据要求|按照规则|核对一下|思考过程|字数需)/
        if (THINK_RE.test(bodyRaw)) {
          const m = bodyRaw.match(THINK_RE)
          const at = m ? bodyRaw.indexOf(m[1]) : -1
          bodyRaw = at > 0 ? bodyRaw.slice(0, at) : ''
        }
        bodyRaw = bodyRaw.replace(/^["“'‘]|["”'’]$/g, '').trim()

        // 头部固定用第一步定好的天气，不再让模型在正文里改写
        head = headerLine + ' ' + weather

        // 天气自洽兜底：雨天/阴天/雾雪天里出现"太阳/阳光/晒"就把那半句砍掉
        let body = bodyRaw
        if (isWet) {
          const parts = body.split(/(?<=[。！？；，])/).filter((seg) => !/太阳|阳光|晒|晴空|晴朗/.test(seg))
          body = parts.join('')
          if (!body.trim()) body = '今天外面下着' + weatherWord + '，我窝在贝壳里没怎么动。'
        }
        // 被过滤到几乎没有内容 → 判定为生成失败，换一句干净的兜底
        if (body.trim().length < 8) {
          body = userAbsentToday
            ? '今天没人来过，水面很静，我在贝壳里躺了很久，听见很远的地方有声音。'
            : '今天发生的事太多，记不清了……'
          body = body.slice(0, Math.min(90, Math.max(30, targetWords)))
          diaryDebug.note = (diaryDebug.note || '') + ' fallback=thinking-leak'
        }
        // 动态上限：30 / 50 / 80，硬顶 90
        const cap = Math.min(90, Math.max(30, targetWords))
        if (body.length > cap) body = body.slice(0, cap)
        text = head + String.fromCharCode(10) + body
        if (!body) diaryDebug.stage = 'error-empty'

        if (text.length < 10) {
          diaryDebug.stage = 'skipped-short'
          diaryDebug.note = 'len=' + text.length + ' raw=' + JSON.stringify(buf.slice(0, 80))
          return
        }
        const entry = {
          date: dateKey,
          text,
          ts: atMs,
          turns: digest.turns,
          peak: digest.peak,
          low: digest.low,
          drivers: digest.notes.slice(0, 5)
        }
        // 一天只能一条：先删掉同日的其它 key（历史脏数据），再写入
        try {
          const table = diaryDomain.table('entries')
          for (const k of table.keys()) {
            if (k === dateKey) continue
            try {
              const old = table.get(k)
              if (old && String(old.date) === dateKey) table.delete(k)
            } catch { /* 单条跳过 */ }
          }
        } catch { /* 吞 */ }
        Promise.resolve(diaryDomain.table('entries').put(dateKey, entry))
          .then(() => { diaryDebug.stage = 'written'; diaryDebug.note = dateKey + ' len=' + text.length })
          .catch((err) => { diaryDebug.stage = 'error-write'; diaryDebug.error = String(err).slice(0, 200) })
      } catch (err) {
        diaryDebug.stage = 'error-outer'
        diaryDebug.error = String(err && err.message ? err.message : err).slice(0, 200)
      }
    }

    const dayKeyOf = (ms) => {
      const d = new Date(ms)
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }

    /** 到点没写就写；错过时间在启动/恢复时补写最近漏掉的一天。 */
    const diaryTick = async () => {
      if (diaryBusy) return
      diaryBusy = true
      try {
        if (!liveCfg.diary?.enabled) return
        const now = Date.now()
        const today = dayKeyOf(now)
        const [hh, mm] = String(liveCfg.diary.time || '22:00').split(':').map(Number)
        const due = new Date(now)
        // 注意：hh 可能是 0，不能用 || 兜底（0 会被当成假值 → 变成 23 点）
        due.setHours(Number.isFinite(hh) ? hh : 23, Number.isFinite(mm) ? mm : 0, 0, 0)
        const past = now >= due.getTime()

        // 今天：到点且没写 → 写（hasWrittenToday 强校验，一天最多一篇）
        if (past && !diaryOfDay(today)) {
          diaryDebug.stage = 'scheduled'
          await maybeDiary(now, false, { dateKey: today })
          return
        }

        // 补写：昨天（最多回溯 3 天）没写就补一天
        for (let i = 1; i <= 3; i++) {
          const key = dayKeyOf(now - i * 86400000)
          if (!diaryOfDay(key)) {
            diaryDebug.stage = 'backfill'
            await maybeDiary(now, false, { dateKey: key })
            return
          }
        }
      } catch (err) {
        diaryDebug.stage = 'timer-error'
        diaryDebug.error = String((err && err.message) || err).slice(0, 160)
      } finally {
        diaryBusy = false
      }
    }

    const onEvent = (...args) => {
      try {
        const event = args.find((a) => a && typeof a === 'object' && typeof a.type === 'string')
        if (!event) return
        const t = eventType(event)
        const at = eventTime(event)
        const sid = pickSession(args)
        if (sid) sessionId = sid
        lastBySession.set(sessionId, at)

        switch (t) {
          case 'turn/start': {
            settleTo(at)
            if (lastTurnEndTs && at - lastTurnEndTs < 60 * 1000) {
              evtCount.dense_turns = (evtCount.dense_turns ?? 0) + 1
              applyEvent('dense_turns', at)
              addDriver('dense_turns', '刚说完没停又接上', 0.8, DEFAULTS.weights.dense_turns.arousal)
            } else if (lastTurnEndTs && at - lastTurnEndTs > 2 * 3600 * 1000) {
              evtCount.long_idle = (evtCount.long_idle ?? 0) + 1
              applyEvent('long_idle', at)
              addDriver('long_idle', '隔了好一阵才回来', 0.8, Math.abs(DEFAULTS.weights.long_idle.arousal))
            }
            // 先结算上一轮有没有工具调用，再据此决定这轮要不要加硬指令
            prevTurnHadTools = turnToolCalls > 0
            turnToolCalls = 0
            updateHint(state, at)
            turn += 1
            resetTurn(at)
            return
          }
          case 'step/end': {
            settleTo(at)
            return
          }
          case 'llm/retry': {
            settleTo(at)
            evtCount.retry = (evtCount.retry ?? 0) + 1
            applyEvent('retry', at)
            addDriver('retry', '这一步重试了一次', 0.75, DEFAULTS.weights.retry.stress)
            return
          }
          case 'tool/call': {
            settleTo(at)
            turnToolCalls += 1
            const toolName = String(event?.data?.name ?? '')
            if (toolName === 'ask_user' || toolName === 'ask_user_question') {
              evtCount.clarify = (evtCount.clarify ?? 0) + 1
              applyEvent('clarify', at)
              addDriver('clarify', '回头跟你确认了一次', 0.7, Math.abs(DEFAULTS.weights.clarify.dominance))
            }
            return
          }
          case 'tool/result': {
            settleTo(at)
            const msg = event?.data?.message ?? {}
            // 失败判定：DSH 的 bash 失败不会置 isError，会在正文里留 [COMMAND_FAILED …]
            // content 可能是数组、字符串，或带包装的对象；三种都摊平成文本再找标记
            const body = typeof msg?.content === 'string'
              ? msg.content
              : Array.isArray(msg?.content)
                ? msg.content.map((c) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c ?? ''))).join(String.fromCharCode(10))
                : JSON.stringify(msg?.content ?? '')
            const failed = msg.isError === true || /\[COMMAND_FAILED(;|\])/.test(body)
            if (failed) {
              const code = String(msg?.error?.code ?? '')
              if (code === 'ABORTED_BEFORE_DISPATCH') return
              errStreak += 1
              evtCount.tool_error = (evtCount.tool_error ?? 0) + 1
              const third = errStreak >= 3 && !x3Fired
              if (third) {
                x3Fired = true
                evtCount.tool_error_x3 = (evtCount.tool_error_x3 ?? 0) + 1
                // 合并后一次应用：+4 与 +8 相加再套 ±8（结果为 8）
                applyEvent(['tool_error', 'tool_error_x3'], at)
                addDriver('tool_error', '一条命令没跑成', 0.8, DEFAULTS.weights.tool_error.stress)
                addDriver('tool_error_x3', '同一件事连着报错三次', 0.9, DEFAULTS.weights.tool_error_x3.stress)
              } else {
                applyEvent('tool_error', at)
                addDriver('tool_error', '一条命令没跑成', 0.8, DEFAULTS.weights.tool_error.stress)
              }
            } else {
              errStreak = 0
              evtCount.tool_ok = (evtCount.tool_ok ?? 0) + 1
              applyEvent('tool_ok', at)
            }
            return
          }
          case 'user/message': {
            settleTo(at)
            const text = textOf(event)
            if (!text) return
            lastUserText = text.slice(0, 500)
            noteDialogEvents(text, at)
            lastInteractionTs = at
            const rej = rejectScore(text)
            const praise = praiseScore(text)
            if (praise !== null) {
              const conf = rej !== null ? r2(praise - 0.3) : praise
              if (conf >= 0.6) {
                evtCount.user_praise = (evtCount.user_praise ?? 0) + 1
                applyEvent('user_praise', at)
                addDriver('user_praise', '被夸了一句', conf, DEFAULTS.weights.user_praise.valence)
              }
            }
            if (rej !== null && praise === null) {
              evtCount.user_reject = (evtCount.user_reject ?? 0) + 1
              applyEvent('user_reject', at)
              addDriver('user_reject', '你说这样不对', rej, Math.abs(DEFAULTS.weights.user_reject.valence))
            }
            if (text.length < 12) {
              evtCount.short_msgs = (evtCount.short_msgs ?? 0) + 1
              if (evtCount.short_msgs >= 2) {
                applyEvent('short_msgs', at)
                addDriver('short_msgs', '你回得很短', 0.65, Math.abs(DEFAULTS.weights.short_msgs.engagement))
              }
            }
            return
          }
          case 'request/context':
          case 'request/header': {
            settleTo(at)
            const d = event?.data ?? {}
            const used = Number(d.tokens ?? d.inputTokens ?? d.totalTokens ?? NaN)
            const limit = Number(d.limit ?? d.maxTokens ?? d.contextWindow ?? NaN)
            if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0 && used / limit > 0.8) {
              if (!evtCount.ctx_pressure) {
                evtCount.ctx_pressure = 1
                applyEvent('ctx_pressure', at)
                addDriver('ctx_pressure', '上下文快满了', 0.7, DEFAULTS.weights.ctx_pressure.stress)
              }
            }
            return
          }
          case 'turn/end': {
            if (turnStartTs) settleTo(at)
            lastTurnEndTs = at
            if (!turn) turn = 1
            writeRecord(at)
            // 日记：按天累计轮数，然后异步看看要不要写
            try {
              const dd = new Date(at)
              const dk = dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0') + '-' + String(dd.getDate()).padStart(2, '0')
              dayTurns.set(dk, (dayTurns.get(dk) || 0) + 1)
              Promise.resolve().then(() => maybeDiary(at)).catch(() => {})
            } catch { /* 吞 */ }

            // 高精度：只在开关打开且句子可疑时才花一次小调用
            try {
              if (liveCfg.high_precision && lastUserText && isSuspicious(lastUserText)) {
                const text = lastUserText
                Promise.resolve().then(() => judge(text)).catch(() => {})
              }
            } catch { /* 吞 */ }
            return
          }
          default:
            return
        }
      } catch (err) {
        log(ctx, 'event failed', String(err))
      }
    }

    try {
      // 恢复当天的互动计数
      Promise.resolve().then(() => loadInteractCount()).catch(() => {})

      // 日记域：打开失败要留痕（曾经在这里静默吞掉，导致永远 skipped-nodomain）
      try {
        Promise.resolve(ctx.storageDomain.open(moodDiarySpec))
          .then((dd) => {
            if (closed) { try { dd.close() } catch { /* 吞 */ } return }
            diaryDomain = dd
            diaryDebug.stage = 'domain-open'
          })
          .catch((err) => {
            diaryDebug.stage = 'domain-error'
            diaryDebug.error = String((err && err.code) || (err && err.message) || err).slice(0, 120)
            try {
              ;(ctx.logger?.('dsh-mood') || console).error?.(
                '[dsh-mood] open mood_diary failed:', err && err.code, err && err.message)
            } catch { /* 吞 */ }
          })
      } catch (err) {
        diaryDebug.stage = 'domain-throw'
        diaryDebug.error = String(err && err.message ? err.message : err).slice(0, 120)
      }

      // 先开配置域：拿到用户存过的运行配置
      try {
        Promise.resolve(ctx.storageDomain.open(moodConfigSpec))
          .then((cd) => {
            if (closed) { try { cd.close() } catch { /* 吞 */ } return }
            configDomain = cd
            try {
              const saved = cd.table('settings').get('current')
              if (saved) {
                liveCfg = normalizeLiveConfig(saved, cfg)
                baseline = liveCfg.baseline
              }
            } catch { /* 读不到就用默认 */ }
          })
          .catch(() => { /* 配置域打不开不影响主功能 */ })
      } catch { /* 吞 */ }

      Promise.resolve(ctx.storageDomain.open(moodSpec))
        .then((d) => {
          if (closed) {
            try { d.close() } catch { /* 吞 */ }
            return
          }
          domain = d
          try {
            const table = domain.table('records')
            const last = latestRecord(table)
            if (last && last.state && Number.isFinite(last.ts)) {
              const age = Date.now() - last.ts
              if (age >= 0 && age < 24 * 3600 * 1000) {
                state = { ...blankState(baseline), ...last.state }
                lastSettleTs = last.ts
                // 把「停机这段时间」的衰减补上，而不是原样照搬
                settleTo(Date.now())
                // 启动时的衰减不计入首轮对账
                turnDecay = blankDims(0)
                turnStartState = { ...state }
              }
            }
          } catch { /* 吞 */ }
          registerRoute()
          flush()
        })
        .catch((err) => log(ctx, 'open failed', err?.code ?? String(err)))
    } catch (err) {
      log(ctx, 'open threw', String(err))
    }

    dispose = () => {
      closed = true
      try { if (diaryTimer) clearInterval(diaryTimer) } catch { /* 吞 */ }
      try { disposeRequest?.() } catch { /* 吞 */ }
      try { configDomain?.close() } catch { /* 吞 */ }
      try { diaryDomain?.close() } catch { /* 吞 */ }
      liveProvider = null
      resetProvider = null
      interactProvider = null
      clearHint()
      for (const off of routeDisposers.splice(0)) {
        try { off() } catch { /* 吞 */ }
      }
      try { domain?.close() } catch { /* 吞 */ }
    }

    const off = ctx.on('session/event', onEvent)

    return () => {
      try { off?.() } catch { /* 吞 */ }
      try { dispose?.() } catch { /* 吞 */ }
    }
  }, 'mood.records()')

  return () => {}
}

export { DIMS, DEFAULTS, EMOTIONS, emotionOf, labelOf, noteDialogEvents, hasEvent, recordValueSchema, buildHint, HINT_PREFIX }
