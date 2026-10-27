// dsh-mood — 右栏心情面板 + 设置页「日记&情绪」（client 半边）
//
// 注册形状对齐官方 dsh-client-ui-sidebar-right（逆向所得，改前请看 ARCHITECTURE.md）：
//   definition: { id, kind, title(address) => string, guide?: Entry[] }
//   Entry:      { id, title() => string, description?() => string, order?, icon? }
// title / description 必须是函数：渲染期会被当场调用，传字符串会抛错并带崩整个「开始」页。
window.__ModuleLoader__.load({
  id: 'dsh-mood',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    const DIMS = [
      ['valence', '心情', '效价：整体愉快程度，越高越正面', '#2f6df6', '#7fb5ff'],
      ['arousal', '劲儿', '唤醒度：活跃或紧张程度', '#7b3ff2', '#c39bff'],
      ['dominance', '底气', '掌控感：事在手里的感觉', '#1a5fd0', '#63a6ff'],
      ['engagement', '投入', '投入度：愿意钻多深', '#0f9d63', '#5fe0b0'],
      ['stress', '压力', '压力：被逼出来的紧绷', '#c93a3a', '#ff8a8a'],
      ['affinity', '亲近', '亲密度：距离感，越高越近', '#c98a10', '#ffd166']
    ]

    const LABEL_COLORS = {
      绷: '#ff6b6b', 闷: '#9aa0ad', 赶: '#ffa94d', 兴: '#ffd166', 暖: '#ff8fb1',
      淡: '#7fa6c4', 定: '#63a6ff', 虚: '#b39ddb', 沉: '#5fe0b0', 平: '#63a6ff'
    }

    const POLL_MS = 3000
    const HISTORY_MAX = 10
    const PULSE_MS = 600
    const CHANGE_THRESHOLD = 5
    const APPEARANCE_KEY = 'dsh-mood-appearance'
    const STYLE_ID = 'dsh-mood-panel-style'
    const LAST_READ_KEY = 'dsh-mood-diary-lastread'

    const loadLastRead = () => {
      try {
        const n = Number(localStorage.getItem(LAST_READ_KEY))
        return Number.isFinite(n) ? n : 0
      } catch { return 0 }
    }
    const saveLastRead = (ts) => {
      try { localStorage.setItem(LAST_READ_KEY, String(ts)) } catch { /* 吞 */ }
    }

    // ---------- 外观（纯客户端） ----------
    // 预设 = 一整套参数（模式/颜色/透明度/雾化/边框）
    const PRESETS = [
      { id: 'deep', name: '默认深海', mode: 'dark', glass: '#191a1e', opacity: 0.78, blur: 12, border: 30, timelineSize: 12 },
      { id: 'ice', name: '清透冰蓝', mode: 'dark', glass: '#0f2a3f', opacity: 0.58, blur: 20, border: 46, timelineSize: 12 },
      { id: 'peach', name: '蜜桃橘', mode: 'light', glass: '#ffcaa3', opacity: 0.9, blur: 12, border: 22, timelineSize: 12 },
      { id: 'mono', name: '极简黑白', mode: 'light', glass: '#ffffff', opacity: 0.96, blur: 6, border: 12, timelineSize: 12 },
      // 纯色系：只换颜色，参数保持克制
      { id: 'mint', name: '薄荷绿', mode: 'light', glass: '#d9f2e4', opacity: 0.9, blur: 10, border: 22, timelineSize: 12 },
      { id: 'sakura', name: '樱花粉黛', mode: 'light', glass: '#f7dfe6', opacity: 0.86, blur: 14, border: 24, timelineSize: 12 },
      { id: 'taro', name: '香芋紫', mode: 'light', glass: '#d8bfd8', opacity: 0.9, blur: 14, border: 20, timelineSize: 12 },
      { id: 'tea', name: '焦糖茶', mode: 'light', glass: '#e6d2b6', opacity: 0.92, blur: 8, border: 18, timelineSize: 12 }
    ]

    const DEFAULT_PRESET = PRESETS[0]
    const APPEARANCE_DEFAULT = {
      mode: DEFAULT_PRESET.mode,
      glass: DEFAULT_PRESET.glass,
      opacity: DEFAULT_PRESET.opacity,
      blur: DEFAULT_PRESET.blur,
      border: DEFAULT_PRESET.border,
      timelineSize: 12,
      timelineAccent: ''
    }

    const samePreset = (a, pr) =>
      a.mode === pr.mode &&
      String(a.glass).toLowerCase() === pr.glass.toLowerCase() &&
      Math.abs(Number(a.opacity) - pr.opacity) < 0.005 &&
      Number(a.blur) === pr.blur &&
      Number(a.border) === pr.border

    const currentPresetId = (a) => {
      const hit = PRESETS.find((pr) => samePreset(a, pr))
      return hit ? hit.id : null
    }

    /** 让玻璃色服从模式：深色模式压暗到能看出"深"，浅色模式提亮到能看出"浅"。 */
    function fitToMode(glass, mode) {
      const c = hexToRgb(glass)
      const lum = luminance(c)
      // 只在"极端"时纠正：浅色模式过暗才提亮，深色模式过亮才压暗。
      // 中间调（莫兰迪色）保持原色，否则会被洗白或压黑。
      const MIN_LIGHT = 0.32      // 浅色模式：低于此值提亮到 0.32
      const MAX_DARK = 0.62       // 深色模式：高于此值压暗到 0.62
      if (mode === 'light' && lum >= MIN_LIGHT) return c
      if (mode === 'dark' && lum <= MAX_DARK) return c
      const target = mode === 'light' ? MIN_LIGHT : MAX_DARK
      // 二分找混合比例，最多混到目标亮度
      let lo = 0
      let hi = 1
      const toward = mode === 'light' ? { r: 255, g: 255, b: 255 } : { r: 8, g: 8, b: 12 }
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2
        const test = mix(c, toward, mid)
        const l = luminance(test)
        if (mode === 'light' ? l < target : l > target) lo = mid
        else hi = mid
      }
      return mix(c, toward, hi)
    }

    const clamp01 = (n, lo = 0, hi = 1) => {
      const v = Number(n)
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo
    }

    /** 安全的数值回落：NaN / undefined / 越界统统回到 def。 */
    const numOr = (v, def, lo, hi) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return def
      return Math.max(lo, Math.min(hi, n))
    }

    function hexToRgb(hex) {
      const n = parseInt(String(hex).replace('#', ''), 16)
      if (!Number.isFinite(n)) return { r: 25, g: 25, b: 30 }
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
    }

    const rgbCss = (c) => 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')'
    const rgbaCss = (c, a) => 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + a + ')'
    const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t })

    function luminance(c) {
      const f = (v) => {
        const x = v / 255
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }

    function loadAppearance() {
      try {
        const raw = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || 'null')
        if (!raw || typeof raw !== 'object') return { ...APPEARANCE_DEFAULT }
        return {
          mode: raw.mode === 'light' ? 'light' : 'dark',
          glass: /^#[0-9a-fA-F]{6}$/.test(String(raw.glass)) ? raw.glass : APPEARANCE_DEFAULT.glass,
          opacity: numOr(raw.opacity, APPEARANCE_DEFAULT.opacity, 0.1, 1),
          blur: numOr(raw.blur, APPEARANCE_DEFAULT.blur, 0, 30),
          border: numOr(raw.border, APPEARANCE_DEFAULT.border, 0, 100),
          timelineSize: numOr(raw.timelineSize, APPEARANCE_DEFAULT.timelineSize, 10, 16),
          timelineAccent: /^#[0-9a-fA-F]{6}$/.test(String(raw.timelineAccent || '')) ? raw.timelineAccent : ''
        }
      } catch {
        return { ...APPEARANCE_DEFAULT }
      }
    }

    /** 把玻璃色叠到"假定背景"上算真实亮度，决定文字深浅（纯白背景也不会白字）。 */
    function appearanceVars(a) {
      const mode = a.mode === 'light' ? 'light' : 'dark'
      // 先让颜色服从模式，再叠到假定背景上——保证"深色模式一定看起来深"
      const fitted = fitToMode(a.glass, mode)
      const backdrop = mode === 'light' ? { r: 255, g: 255, b: 255 } : { r: 10, g: 10, b: 14 }
      const effective = mix(backdrop, fitted, clamp01(a.opacity, 0.1, 1))
      const bgLum = luminance(effective)

      // 文字按模式定基调，再看对比度兜底（避免极端组合下看不清）
      let fg = mode === 'dark' ? { r: 244, g: 246, b: 250 } : { r: 22, g: 25, b: 31 }
      const contrast = Math.abs(luminance(fg) - bgLum)
      if (contrast < 0.35) {
        fg = bgLum > 0.5 ? { r: 22, g: 25, b: 31 } : { r: 244, g: 246, b: 250 }
      }
      const isDark = mode === 'dark'
      const edgeBase = bgLum > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }

      // 浅色模式把字压得更黑、网格线更实，避免"发虚"
      const fgLight = { r: 12, g: 15, b: 20 }
      const fgDark = { r: 246, g: 247, b: 250 }
      const fgFinal = isDark ? fgDark : fgLight

      return {
        '--bg': rgbaCss(fitted, clamp01(a.opacity, 0.1, 1)),
        '--blur': a.blur + 'px',
        '--fg': rgbCss(fgFinal),
        '--dim': rgbaCss(fgFinal, isDark ? 0.76 : 0.86),
        '--faint': rgbaCss(fgFinal, isDark ? 0.5 : 0.62),
        '--track': isDark ? 'rgba(0,0,0,.55)' : 'rgba(10,14,22,.14)',
        '--line': isDark ? rgbaCss({ r: 255, g: 255, b: 255 }, 0.18) : rgbaCss({ r: 0, g: 0, b: 0 }, 0.18),
        '--grid': isDark ? rgbaCss({ r: 255, g: 255, b: 255 }, 0.16) : rgbaCss({ r: 0, g: 0, b: 0 }, 0.3),
        '--btn': isDark ? rgbaCss({ r: 255, g: 255, b: 255 }, 0.1) : rgbaCss({ r: 0, g: 0, b: 0 }, 0.07),
        '--btn-hover': isDark ? rgbaCss({ r: 255, g: 255, b: 255 }, 0.2) : rgbaCss({ r: 0, g: 0, b: 0 }, 0.13),
        '--chip': isDark ? rgbaCss({ r: 255, g: 255, b: 255 }, 0.07) : rgbaCss({ r: 0, g: 0, b: 0 }, 0.055),
        '--accent': isDark ? '#63a6ff' : '#1a5fd0',
        '--edge': rgbaCss(edgeBase, (Number(a.border) || 0) / 100),
        '--timeline-size': Math.max(10, Math.min(16, Number(a.timelineSize) || 12)) + 'px',
        // 浮层：深色模式浅底深字，浅色模式深底浅字
        '--tip-bg': isDark ? '#f2f4f8' : '#20242c',
        '--tip-fg': isDark ? '#16181d' : '#f7f8fa',
        '--shadow': isDark
          ? '0 12px 34px rgba(0,0,0,.48), inset 0 1px 0 rgba(255,255,255,.06)'
          : '0 10px 26px rgba(15,20,30,.16), inset 0 1px 0 rgba(255,255,255,.9)'
      }
    }

    // ---------- 鱼鱼日记的偏好（标题 / 字号） ----------
    const DIARY_PREFS_KEY = 'dsh-mood-diary-prefs'
    const DIARY_DEFAULT = { title: '鱼鱼日记', fontSize: 14, icon: 'kraft' }

    function loadDiaryPrefs() {
      try {
        const raw = JSON.parse(localStorage.getItem(DIARY_PREFS_KEY) || 'null')
        if (!raw || typeof raw !== 'object') return { ...DIARY_DEFAULT }
        return {
          title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.slice(0, 16) : DIARY_DEFAULT.title,
          fontSize: Math.max(11, Math.min(22, Number(raw.fontSize) || DIARY_DEFAULT.fontSize)),
          icon: ['kraft', 'fin', 'star', 'sea', 'heart'].indexOf(raw.icon) >= 0 ? raw.icon : DIARY_DEFAULT.icon
        }
      } catch {
        return { ...DIARY_DEFAULT }
      }
    }

    const diaryPrefsStore = { value: loadDiaryPrefs(), listeners: new Set() }

    function setDiaryPrefs(next) {
      diaryPrefsStore.value = next
      try { localStorage.setItem(DIARY_PREFS_KEY, JSON.stringify(next)) } catch { /* 吞 */ }
      for (const fn of diaryPrefsStore.listeners) { try { fn(next) } catch { /* 吞 */ } }
    }

    function useDiaryPrefs() {
      const [value, setValue] = React.useState(diaryPrefsStore.value)
      React.useEffect(() => {
        const fn = (v) => setValue(v)
        diaryPrefsStore.listeners.add(fn)
        setValue(diaryPrefsStore.value)
        return () => { diaryPrefsStore.listeners.delete(fn) }
      }, [])
      return [value, (patch) => setDiaryPrefs({ ...diaryPrefsStore.value, ...patch })]
    }

    const appearanceStore = { value: loadAppearance(), listeners: new Set() }

    function setAppearance(next) {
      appearanceStore.value = next
      try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next)) } catch { /* 存不了也继续 */ }
      for (const fn of appearanceStore.listeners) { try { fn(next) } catch { /* 吞 */ } }
    }

    function useAppearance() {
      const [value, setValue] = React.useState(appearanceStore.value)
      React.useEffect(() => {
        const fn = (v) => setValue(v)
        appearanceStore.listeners.add(fn)
        setValue(appearanceStore.value)
        return () => { appearanceStore.listeners.delete(fn) }
      }, [])
      return [value, (patch) => setAppearance({ ...appearanceStore.value, ...patch })]
    }

    const CSS = [
      '[data-dsh-mood]{position:relative;box-sizing:border-box;padding:20px;display:flex;flex-direction:column;',
      '  gap:16px;font-size:12px;color:var(--fg,#e8e9ee);border-radius:14px;overflow:hidden;',
      '  background:var(--bg,rgba(25,25,30,.75));backdrop-filter:blur(var(--blur,12px));',
      '  -webkit-backdrop-filter:blur(var(--blur,12px));box-shadow:var(--shadow,0 10px 30px rgba(0,0,0,.32))}',
      '[data-dsh-mood]::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;',
      '  background:linear-gradient(135deg,var(--edge,rgba(255,255,255,.28)),transparent 72%);',
      '  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);',
      '  -webkit-mask-composite:xor;mask-composite:exclude}',

      '[data-dsh-mood] .head{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:8px 0 4px}',
      '[data-dsh-mood] .badge{display:inline-flex;align-items:center;justify-content:center;',
      '  padding:10px 22px;border-radius:999px;font-weight:800;line-height:1.1;letter-spacing:.06em;',
      '  border:1px solid transparent;box-shadow:0 6px 18px rgba(0,0,0,.18);white-space:nowrap}',
      '[data-dsh-mood] .badge.pos{color:#ffb057;background:rgba(255,159,67,.16);border-color:rgba(255,159,67,.42)}',
      '[data-dsh-mood] .badge.neg{color:#8fb4ff;background:rgba(122,162,255,.16);border-color:rgba(122,162,255,.42)}',
      '[data-dsh-mood] .badge.mid{color:var(--fg);background:var(--btn);border-color:var(--line)}',
      '[data-dsh-mood][data-mode="light"] .badge.pos{color:#b4451a;background:rgba(240,120,40,.14);border-color:rgba(180,69,26,.32)}',
      '[data-dsh-mood][data-mode="light"] .badge.neg{color:#1e4fbf;background:rgba(40,90,220,.12);border-color:rgba(30,79,191,.3)}',
      '[data-dsh-mood][data-mode="light"] .badge.mid{color:#12161c}',
      '.dsh-mood-nav-icon{flex:none;display:block;width:16px;height:16px;opacity:.9}',
      '[data-dsh-mood] .label-action{font-size:12px;line-height:1.55;color:var(--dim);',
      '  text-align:center;max-width:100%;padding:0 8px}',
      '[data-dsh-mood] .radarwrap{position:relative;display:flex;justify-content:center;transition:opacity .2s ease}',
      '[data-dsh-mood] .radarwrap.loading{opacity:.55;animation:dshMoodPulse 1.1s ease-in-out infinite}',
      '@keyframes dshMoodPulse{0%,100%{opacity:.4}50%{opacity:.9}}',
      '[data-dsh-mood] .radarwrap.pulse polygon{animation:dshMoodFlash .5s ease}',
      '@keyframes dshMoodFlash{0%{stroke-width:2}35%{stroke-width:4.5}100%{stroke-width:2}}',
      '[data-dsh-mood] svg text{font-family:inherit}',

      '[data-dsh-mood] .pat-wrap{position:absolute;top:2px;right:0;z-index:5}',
      // 互动菜单
      '[data-dsh-mood] .pat-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:20;',
      '  display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:12px;',
      '  background:var(--bg,rgba(25,25,30,.9));backdrop-filter:blur(var(--blur,12px));',
      '  -webkit-backdrop-filter:blur(var(--blur,12px));',
      '  border:1px solid var(--line);box-shadow:0 12px 30px rgba(0,0,0,.35);',
      '  animation:dshMoodMenuIn .16s ease both;min-width:104px}',
      '@keyframes dshMoodMenuIn{0%{opacity:0;transform:translateY(-4px) scale(.96)}100%{opacity:1;transform:none}}',
      '[data-dsh-mood] .pat-item{display:flex;align-items:center;gap:8px;font:inherit;font-size:12px;',
      '  padding:7px 10px;border-radius:8px;cursor:pointer;text-align:left;',
      '  color:var(--dim);background:transparent;border:none;transition:background .12s ease,color .12s ease}',
      '[data-dsh-mood] .pat-item:hover{background:var(--btn-hover);color:var(--fg)}',
      '[data-dsh-mood] .pat-ico{font-size:13px;line-height:1;width:15px;text-align:center;flex:none}',
      // 面板内气泡提示
      // 互动反馈气泡：0.3s 淡入 + 上浮，常驻直到下次互动
      '[data-dsh-mood] .pat-toast{position:absolute;left:50%;top:10px;transform:translateX(-50%);z-index:60;',
      '  max-width:90%;padding:9px 16px;border-radius:14px;text-align:center;',
      '  background:rgba(20,22,28,.94);color:#fff;font-size:12.5px;line-height:1.5;',
      '  box-shadow:0 12px 32px rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.16);',
      '  cursor:pointer;pointer-events:auto;',
      '  animation:dshMoodToastIn .3s cubic-bezier(.4,0,.2,1) both}',
      '@keyframes dshMoodToastIn{0%{opacity:0;transform:translate(-50%,10px)}',
      '  100%{opacity:1;transform:translate(-50%,0)}}',
      '[data-dsh-mood] .pat-toast.leaving{animation:dshMoodToastOut .3s ease forwards;pointer-events:none}',
      '@keyframes dshMoodToastOut{0%{opacity:1}100%{opacity:0;transform:translate(-50%,-4px)}}',
      '[data-dsh-mood] .pat-btn{position:absolute;top:2px;right:0;z-index:2;display:inline-flex;align-items:center;gap:4px;',
      '  font:inherit;font-size:13px;font-weight:600;padding:6px 14px;border-radius:999px;cursor:pointer;',
      '  color:var(--dim);background:var(--btn);border:1px solid var(--line);',
      '  transition:background .15s ease,color .15s ease,transform .12s ease}',
      '[data-dsh-mood] .pat-btn:hover{background:var(--btn-hover);color:var(--fg);transform:translateY(-1px)}',
      '[data-dsh-mood] .pat-btn:active{transform:scale(.95)}',
      '[data-dsh-mood] .pat-btn svg{width:17px;height:17px;flex:none}',

      '[data-dsh-mood] .tl{max-height:104px;overflow:auto;display:flex;flex-direction:column;gap:0;padding-left:2px}',
      '[data-dsh-mood] .tl-item{position:relative;display:flex;gap:10px;padding:5px 0 5px 12px}',
      '[data-dsh-mood] .tl-item::before{content:"";position:absolute;left:2px;top:10px;width:5px;height:5px;border-radius:50%;',
      '  background:var(--accent)}',
      '[data-dsh-mood] .tl-item::after{content:"";position:absolute;left:4px;top:15px;bottom:-5px;width:1px;background:var(--line)}',
      '[data-dsh-mood] .tl-item:last-child::after{display:none}',
      '[data-dsh-mood] .tl-time{flex:none;width:40px;color:var(--faint);font-variant-numeric:tabular-nums;',
      '  font-size:calc(var(--timeline-size, 12px) - 1px)}',
      '[data-dsh-mood] .tl-text{color:var(--dim);font-size:var(--timeline-size, 12px);line-height:1.45}',
      '[data-dsh-mood] .tl-empty{color:var(--faint);font-size:var(--timeline-size, 12px);padding:4px 0 2px 12px}',
      // 最新一条：加粗、略大、圆点发光
      '[data-dsh-mood] .tl-item.latest .tl-text{color:var(--fg);font-weight:600;',
      '  font-size:calc(var(--timeline-size, 12px) + 1.5px)}',
      '[data-dsh-mood] .tl-item.latest .tl-time{color:var(--dim)}',
      '[data-dsh-mood] .tl-item.latest::before{width:7px;height:7px;left:1px;top:9px;',
      '  background:var(--timeline-accent, var(--accent));',
      '  box-shadow:0 0 0 3px color-mix(in srgb, var(--timeline-accent, var(--accent)) 22%, transparent),',
      '    0 0 10px var(--timeline-accent, var(--accent))}',

      '[data-dsh-mood] .stats{display:flex;flex-direction:column;gap:10px}',
      '[data-dsh-mood] .row{display:grid;grid-template-columns:58px 1fr 50px 34px;align-items:center;gap:8px;',
      '  border-radius:6px;padding:1px 0}',
      '[data-dsh-mood] .row.pulse{animation:dshMoodRowPulse .5s ease}',
      '@keyframes dshMoodRowPulse{0%{background:transparent}30%{background:var(--btn-hover)}100%{background:transparent}}',
      '[data-dsh-mood] .name{display:inline-flex;align-items:center;justify-content:flex-end;gap:4px;',
      '  color:var(--dim);font-size:12.5px;white-space:nowrap}',
      '[data-dsh-mood] .hint-wrap{position:relative;display:inline-flex;align-items:center}',
      // 问号：反色圆标（深底浅字 / 浅底深字）
      '[data-dsh-mood] .hint-q{display:inline-flex;align-items:center;justify-content:center;',
      '  width:13px;height:13px;min-width:13px;min-height:13px;flex:none;',
      '  border-radius:50%;-webkit-border-radius:50%;box-sizing:border-box;',
      '  background:var(--fg);color:var(--bg,#fff);',
      '  font-size:9px;font-weight:700;line-height:1;cursor:grab;',
      '  transition:opacity .15s ease,transform .1s ease;opacity:.72}',
      '[data-dsh-mood] .hint-wrap:hover .hint-q{opacity:1}',
      '[data-dsh-mood] .hint-wrap:active .hint-q{cursor:grabbing;transform:scale(.94)}',
      // 浮层：6px 间距，不吃鼠标事件
      '[data-dsh-mood] .hint-tip{position:absolute;bottom:calc(100% + 6px);left:0;z-index:60;',
      '  min-width:120px;max-width:220px;padding:7px 10px;border-radius:8px;',
      '  background:var(--tip-bg,#20242c);color:var(--tip-fg,#f7f8fa);',
      '  font-size:11px;line-height:1.5;font-weight:400;white-space:normal;text-align:left;',
      '  box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:none;',
      '  animation:dshMoodTip .14s ease both}',
      '@keyframes dshMoodTip{0%{opacity:0;transform:translateY(3px)}100%{opacity:1;transform:none}}',
      '[data-dsh-mood] .reason-label{font-size:11px;color:var(--dim);opacity:.85;align-self:center}',
      '[data-dsh-mood] .track{position:relative;height:10px;border-radius:5px;background:var(--track);',
      '  box-shadow:inset 0 2px 4px rgba(0,0,0,.4);overflow:hidden}',
      '[data-dsh-mood] .fill{position:relative;z-index:1;display:block;height:100%;border-radius:5px;',
      '  transition:width .45s cubic-bezier(.4,0,.2,1);box-shadow:inset 0 1px 0 rgba(255,255,255,.2)}',
      '[data-dsh-mood] .val{display:flex;align-items:baseline;gap:4px}',
      '[data-dsh-mood] .num{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}',
      '[data-dsh-mood] .band{font-size:11px;color:var(--faint)}',
      '[data-dsh-mood] .spark{display:flex;align-items:center;justify-content:center;opacity:.85}',

      '[data-dsh-mood] .chips{display:flex;flex-wrap:wrap;gap:6px}',
      '[data-dsh-mood] .chip{font-size:11px;padding:3px 9px;border-radius:999px;color:var(--dim);',
      '  background:var(--chip);border:1px solid var(--line)}',

      '[data-dsh-mood] .drawer{background:var(--chip);border:1px solid var(--line);border-radius:10px;',
      '  padding:10px;max-height:180px;overflow:auto}',
      '[data-dsh-mood] .drawer pre{margin:0;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;',
      '  color:var(--dim);white-space:pre-wrap;word-break:break-all}',

      '[data-dsh-mood] .foot{display:flex;align-items:center;justify-content:space-between;gap:10px;',
      '  color:var(--faint);font-size:11px;padding-top:8px;border-top:1px solid var(--line)}',
      '[data-dsh-mood] .btns{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
      '[data-dsh-mood] .btn{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:11px;',
      '  padding:6px 11px;border-radius:8px;cursor:pointer;color:var(--dim);',
      '  background:var(--btn);border:1px solid var(--line);',
      '  transition:background .15s ease,color .15s ease,transform .1s ease,border-color .15s ease}',
      '[data-dsh-mood] .btn:hover{background:var(--btn-hover);color:var(--fg)}',
      '[data-dsh-mood] .btn:disabled{opacity:.42;cursor:not-allowed;background:transparent}',
      '[data-dsh-mood] .btn:active{transform:scale(.97)}',
      '[data-dsh-mood] .btn svg{width:12px;height:12px;flex:none;opacity:.9}',
      '[data-dsh-mood] .btn.danger:hover{background:rgba(255,107,107,.2);border-color:rgba(255,107,107,.4);color:#ffd7d7}',
      '[data-dsh-mood] .empty{color:var(--faint);text-align:center;padding:10px 0}',

      '[data-dsh-mood].bare{background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none;',
      '  box-shadow:none;padding:0;overflow:visible}',
      '[data-dsh-mood].bare::before{display:none}',
      '[data-dsh-mood] .tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:4px}',
      '[data-dsh-mood] .tab{font:inherit;font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;',
      '  color:var(--dim);background:transparent;border:1px solid transparent;transition:all .15s ease}',
      '[data-dsh-mood] .tab:hover{background:var(--btn);color:var(--fg)}',
      '[data-dsh-mood] .tab.on{background:var(--btn-hover);color:var(--fg);border-color:var(--line)}',
      '[data-dsh-mood] .form{display:flex;flex-direction:column;gap:14px;max-width:560px;padding:6px 0}',
      '[data-dsh-mood] .field{display:flex;align-items:center;justify-content:space-between;gap:14px}',
      '[data-dsh-mood] .field label{color:var(--dim);font-size:12px}',
      '[data-dsh-mood] .field .hint{color:var(--faint);font-size:11px;display:block;margin-top:2px}',
      // 数字输入框：原生 spinner 彻底隐藏，改用右侧自绘的极简箭头
      '[data-dsh-mood] .num-wrap{position:relative;display:inline-flex;align-items:center;width:112px}',
      '[data-dsh-mood] .num-input{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;text-align:center;',
      '  padding:7px 0;border-radius:9px;color:var(--fg);',
      '  background:color-mix(in srgb, var(--fg) 5%, transparent);',
      '  border:1px solid color-mix(in srgb, var(--line) 70%, transparent);',
      '  -moz-appearance:textfield;appearance:textfield;',
      '  transition:border-color .18s ease,box-shadow .18s ease,background .18s ease}',
      '[data-dsh-mood] .num-input::-webkit-inner-spin-button,',
      '[data-dsh-mood] .num-input::-webkit-outer-spin-button{',
      '  -webkit-appearance:none;appearance:none;display:none;margin:0}',
      '[data-dsh-mood] .num-input:hover{border-color:color-mix(in srgb, var(--accent) 40%, var(--line))}',
      '[data-dsh-mood] .num-input:focus{outline:none;border-color:var(--accent);',
      '  background:color-mix(in srgb, var(--fg) 8%, transparent);',
      '  box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent)}',
      // 自绘微调键：贴在输入框右内侧，无底色无阴影
      '[data-dsh-mood] .num-steps{position:absolute;right:5px;top:50%;transform:translateY(-50%);',
      '  display:flex;flex-direction:column;align-items:center;gap:1px}',
      '[data-dsh-mood] .num-step{display:flex;align-items:center;justify-content:center;width:12px;height:10px;',
      '  padding:0;border:0;background:transparent;color:var(--dim);opacity:.65;cursor:pointer;line-height:0;',
      '  transition:opacity .12s ease,color .12s ease}',
      '[data-dsh-mood] .num-step:hover{opacity:1;color:var(--fg)}',
      '[data-dsh-mood] .num-step:active{opacity:1;color:var(--accent)}',
      '[data-dsh-mood] .num-step svg{display:block;width:8px;height:5px}',
      '[data-dsh-mood] .field input[type=range]{width:190px;accent-color:var(--accent)}',
      '[data-dsh-mood] .field input[type=color]{width:44px;height:28px;padding:0;border:1px solid var(--line);',
      '  border-radius:8px;background:transparent;cursor:pointer}',
      '[data-dsh-mood] .rowline{display:flex;align-items:center;gap:10px;justify-content:flex-end}',
      '[data-dsh-mood] .ok{color:#2ec27e;font-size:11px}',
      '[data-dsh-mood] .err{color:#ff7b7b;font-size:11px}',
      '[data-dsh-mood] .presets{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));',
      '  gap:8px;flex-wrap:wrap}',
      '@media (max-width:520px){[data-dsh-mood] .presets{grid-template-columns:repeat(3,minmax(0,1fr))}}',
      '[data-dsh-mood] .preset{display:inline-flex;align-items:center;gap:8px;font:inherit;font-size:11px;',
      '  padding:8px 10px;border-radius:10px;cursor:pointer;color:var(--dim);background:var(--btn);',
      '  border:1px solid var(--line);transition:all .15s ease;text-align:left}',
      '[data-dsh-mood] .preset:hover{background:var(--btn-hover);color:var(--fg)}',
      '[data-dsh-mood] .preset.on{border-color:var(--accent);color:var(--fg);background:var(--btn-hover)}',
      '[data-dsh-mood] .preset-dot{width:16px;height:16px;border-radius:6px;border:1px solid;flex:none}',
      '[data-dsh-mood] .preset-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '[data-dsh-mood] .preset{padding:7px 8px;gap:6px}',
      '[data-dsh-mood] .preset-dot{width:14px;height:14px;border-radius:5px}',
      '[data-dsh-mood] .swatches{display:flex;align-items:center;gap:8px}',
      '[data-dsh-mood] .swatch{width:24px;height:24px;border-radius:8px;cursor:pointer;border:2px solid transparent;',
      '  transition:transform .12s ease,border-color .12s ease}',
      '[data-dsh-mood] .swatch:hover{transform:scale(1.08)}',
      '[data-dsh-mood] .swatch.on{border-color:var(--accent)}',
      '[data-dsh-mood] .reset-mini{padding:4px 9px;font-size:13px;line-height:1;border-radius:8px}',
      '[data-dsh-mood] .reset-mini.tiny{padding:3px 8px;font-size:12px;line-height:1.1;border-radius:8px;',
      '  color:var(--dim);background:var(--btn);border:1px solid var(--line);opacity:1;',
      '  transition:background .15s ease,color .15s ease,border-color .15s ease,transform .1s ease}',
      '[data-dsh-mood] .reset-mini.tiny:hover{background:var(--btn-hover);color:var(--accent);border-color:var(--accent);transform:translateY(-1px)}',
      '[data-dsh-mood] .reset-mini.tiny:active{transform:scale(.94)}',
      '[data-dsh-mood] .reset-mini.tiny.idle{color:var(--faint);background:transparent;border-color:var(--line)}',
      '[data-dsh-mood] .reset-mini.tiny.idle:hover{color:var(--accent);background:var(--btn)}',
      '[data-dsh-mood] .group{padding:12px;border-radius:12px;background:var(--chip);border:1px solid var(--line);',
      '  display:flex;flex-direction:column;gap:12px}',
      '[data-dsh-mood] .group-title{font-size:11px;letter-spacing:.08em;color:var(--faint);text-transform:uppercase}',
      '[data-dsh-mood] .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}',
      '[data-dsh-mood] .stat{padding:10px 12px;border-radius:10px;background:var(--chip);border:1px solid var(--line)}',
      '[data-dsh-mood] .stat b{display:block;font-size:16px;font-weight:700;margin-top:2px}',
      '[data-dsh-mood] .stat span{color:var(--faint);font-size:11px}',
      // 悬浮预览：右侧整块、100% 尺寸、真实毛玻璃
      '.preview-float{position:fixed;right:24px;top:50%;',
      '  transform:translateY(-50%) translateX(0);opacity:1;',
      '  transition:transform .38s cubic-bezier(.4,0,.2,1),opacity .28s ease;',
      '  width:420px;max-width:40vw;max-height:90vh;z-index:99999;',
      '  pointer-events:auto}',
      '.preview-float.closed{transform:translateY(-50%) translateX(115%);opacity:0;pointer-events:none}',
      '  box-sizing:border-box;overflow-y:auto;overflow-x:hidden;padding:24px 22px;border-radius:18px;',
      '  background:var(--bg,rgba(25,25,30,.72));',
      '  backdrop-filter:blur(var(--blur,12px));-webkit-backdrop-filter:blur(var(--blur,12px));',
      '  border:1px solid var(--line);box-shadow:0 26px 70px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.25)}',
      // 预览打开时，让宿主设置弹窗整体左移，给右侧 380px 腾地方（用 body class 控制，随预览卸载自动失效）
      'body.dsh-mood-preview-open .wCInkW_mask{padding-right:390px}',
      'body.dsh-mood-preview-open .wCInkW_overlay{padding-right:390px}',
      '.preview-float::-webkit-scrollbar{width:6px}',
      '.preview-float::-webkit-scrollbar-thumb{background:var(--line);border-radius:3px}',
      '[data-dsh-mood] .tl-head{display:flex;align-items:center;justify-content:space-between}',
      '[data-dsh-mood] .tl-head-title{font-size:11px;letter-spacing:.06em;color:var(--faint)}',
      '[data-dsh-mood] .diary-dot-btn{position:relative;display:inline-flex;align-items:center;gap:2px;',
      '  font:inherit;font-size:12px;padding:4px 7px;border-radius:9px;cursor:pointer;color:var(--dim);',
      '  background:var(--btn);border:1px solid var(--line);transition:background .15s ease,transform .12s ease}',
      '[data-dsh-mood] .diary-dot-btn:hover{background:var(--btn-hover);transform:translateY(-1px)}',
      // 微信同款数字角标：白边 + 阴影 + 轻微呼吸
      '[data-dsh-mood] .diary-badge{position:absolute;top:-5px;right:-5px;min-width:17px;height:17px;',
      '  padding:0 4px;box-sizing:border-box;border-radius:999px;',
      '  display:flex;align-items:center;justify-content:center;',
      '  background:#ff3b30;color:#fff;font-size:11px;font-weight:600;line-height:1;',
      '  border:1.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.28);',
      '  animation:dshMoodBadge 2.2s ease-in-out infinite}',
      '@keyframes dshMoodBadge{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}',

      // 遮罩 + 纸张
      '.book-mask{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;',
      '  background:rgba(10,12,18,.5);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);',
      '  animation:dshMoodFade .2s ease}',
      '@keyframes dshMoodFade{0%{opacity:0}100%{opacity:1}}',
      '.book{position:relative;width:min(560px,90vw);max-height:82vh;padding:32px 46px 58px;',
      '  border-radius:14px;color:#3b3327;',
      '  background:linear-gradient(160deg,#fdf8ec 0%,#f6edd9 60%,#efe3ca 100%);',
      '  border:1px solid #e0d3ba;',
      '  box-shadow:0 30px 80px rgba(0,0,0,.5),0 2px 0 rgba(255,255,255,.6) inset,',
      '    0 0 60px rgba(160,138,104,.18) inset}',
      // 书脊：左右各一道暗影
      '.book::before{content:"";position:absolute;left:0;top:0;bottom:0;width:26px;pointer-events:none;',
      '  border-radius:14px 0 0 14px;',
      '  background:linear-gradient(90deg,rgba(120,98,68,.28),rgba(120,98,68,.05) 60%,transparent)}',
      '.book::after{content:"";position:absolute;right:0;top:0;bottom:0;width:16px;pointer-events:none;',
      '  border-radius:0 14px 14px 0;background:linear-gradient(270deg,rgba(120,98,68,.16),transparent)}',
      // 3D 舞台：给翻页提供景深
      '.book-stage{position:relative}',
      // 翻页：只在最内层做纯位移（不透明、不动父级）
      // 父级带 backdrop-filter，任何 opacity / 3D 都会让它重新合成 → 闪
      '.book-page{height:300px;overflow:hidden}',
      '.book-inner{height:100%;display:flex;flex-direction:column;will-change:transform}',
      '.book-inner.slide-next{animation:dshMoodSlideNext .2s ease-out both}',
      '@keyframes dshMoodSlideNext{0%{transform:translateX(22px)}100%{transform:translateX(0)}}',
      '.book-inner.slide-prev{animation:dshMoodSlidePrev .2s ease-out both}',
      '@keyframes dshMoodSlidePrev{0%{transform:translateX(-22px)}100%{transform:translateX(0)}}',
      // 初次打开：轻微淡入，不抢翻页的手感
      '.book-head{display:flex;align-items:center;justify-content:space-between;gap:12px;',
      '  font-size:13px;letter-spacing:.04em;color:#8a7859;font-weight:600}',
      '.book-head-date{flex:0 0 auto}',
      '.book-head-week{flex:1;text-align:center;color:#a08c68}',
      '.book-head-weather{flex:0 0 auto;text-align:right}',
      '.book-rule{height:1px;margin:12px 0 16px;',
      '  background:linear-gradient(90deg,transparent,rgba(150,130,100,.45),transparent)}',
      // 首行缩进两格：只作用于正文段落，不影响顶部日期/天气
      '.book-text{font-size:14px;line-height:1.95;color:#3c3428;white-space:pre-wrap;',
      '  flex:1;min-height:0;overflow-y:auto;padding-right:4px;',
      '  text-indent:2em;}',
      '.book-wrap{display:flex;flex-direction:column;align-items:center;gap:12px;',
      '  animation:dshMoodBookIn .28s ease both}',
      '@keyframes dshMoodBookIn{0%{opacity:0;transform:translateY(10px) scale(.98)}100%{opacity:1;transform:none}}',
      // 页码：压在羊皮纸底部正中，棕灰色，不抢正文
      '.book-pager{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);',
      '  font-size:12px;letter-spacing:.12em;color:rgba(100,80,60,.6);',
      '  user-select:none;pointer-events:none;font-variant-numeric:tabular-nums}',
      '.book-arrow{position:absolute;bottom:14px;width:30px;height:30px;display:flex;align-items:center;',
      '  justify-content:center;font-size:18px;line-height:1;cursor:pointer;border-radius:8px;',
      '  color:#8a7859;background:rgba(255,255,255,.5);border:1px solid rgba(160,140,110,.35);',
      '  transition:background .15s ease,color .15s ease,opacity .15s ease}',
      '.book-arrow:hover:not(:disabled){background:#fff;color:#5b4a32}',
      '.book-arrow:disabled{opacity:.28;cursor:default}',
      '.book-arrow.prev{left:14px}',
      '.book-arrow.next{right:14px}',
      '.book-close{position:absolute;top:10px;right:10px;width:24px;height:24px;border-radius:50%;',
      '  border:none;background:transparent;color:#a08c68;font-size:15px;cursor:pointer;line-height:1;',
      '  opacity:.65;transition:background .15s ease,opacity .15s ease,color .15s ease}',
      '.book-close:hover{background:rgba(160,140,110,.18);color:#5b4a32;opacity:1}',
      '[data-dsh-mood] .diary-list{display:flex;flex-direction:column;gap:10px}',
      '[data-dsh-mood] .diary-card{padding:12px 14px;border-radius:12px;background:var(--chip);border:1px solid var(--line);',
      '  display:flex;flex-direction:column;gap:8px}',
      '[data-dsh-mood] .diary-card-head{display:flex;align-items:center;justify-content:space-between;',
      '  gap:8px;font-size:13px;color:#8a7859;margin-bottom:6px}',
      '[data-dsh-mood] .dch-date{flex:none}',
      '[data-dsh-mood] .dch-week{flex:1;text-align:center;color:#a08c68}',
      '[data-dsh-mood] .dch-weather{flex:none;text-align:right;white-space:nowrap}',
      '[data-dsh-mood] .diary-date{font-size:12px;font-weight:600;color:var(--fg)}',
      '[data-dsh-mood] .diary-text{line-height:1.7;color:var(--dim);white-space:pre-wrap}',
      '[data-dsh-mood] .mood-toast{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;',
      '  max-width:min(420px,80vw);text-align:center;',
      '  padding:12px 20px;border-radius:14px;background:rgba(20,22,28,.92);color:#fff;font-size:13px;',
      '  box-shadow:0 16px 48px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.14);',
      '  animation:dshMoodToast .2s ease}',
      '@keyframes dshMoodToast{0%{opacity:0}100%{opacity:1}}',
      '[data-dsh-mood] .diary-settings{padding:12px;border-radius:12px;background:var(--chip);border:1px solid var(--line);',
      '  display:flex;flex-direction:column;gap:12px;transform-origin:top center;',
      // 弹性入场：scale(.95) → 1，带回弹曲线
      '  animation:dshMoodSpring .3s cubic-bezier(.34,1.56,.64,1) both}',
      '@keyframes dshMoodSpring{0%{opacity:0;transform:scale(.95)}100%{opacity:1;transform:scale(1)}}',
      '[data-dsh-mood] .icon-picker{display:flex;align-items:center;gap:6px}',
      '[data-dsh-mood] .icon-opt{display:inline-flex;align-items:center;justify-content:center;',
      '  width:30px;height:30px;padding:0;border-radius:9px;cursor:pointer;',
      '  background:var(--btn);border:1px solid var(--line);opacity:.75;',
      '  transition:opacity .15s ease,border-color .15s ease,transform .12s ease}',
      '[data-dsh-mood] .icon-opt:hover{opacity:1;transform:translateY(-1px)}',
      '[data-dsh-mood] .icon-opt.on{opacity:1;border-color:var(--accent);',
      '  box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)}',
      '[data-dsh-mood] input[type=time].text-input::-webkit-calendar-picker-indicator{opacity:.55;cursor:pointer}',
      '[data-dsh-mood] input[type=time].text-input::-webkit-calendar-picker-indicator:hover{opacity:.9}',
      // 关于页
      '[data-dsh-mood] .about{display:flex;flex-direction:column;gap:16px;max-width:560px;padding:6px 0}',
      '[data-dsh-mood] .about-hero{display:flex;flex-direction:column;align-items:flex-start;gap:4px;',
      '  padding:18px 20px;border-radius:14px;',
      '  background:linear-gradient(135deg,color-mix(in srgb, var(--accent) 16%, transparent),transparent 70%);',
      '  border:1px solid var(--line)}',
      '[data-dsh-mood] .about-title{font-size:19px;font-weight:800;letter-spacing:.02em;color:var(--fg)}',
      '[data-dsh-mood] .about-ver{font-size:11px;color:var(--faint);letter-spacing:.08em}',
      '[data-dsh-mood] .about-desc{margin:8px 0 0;font-size:12.5px;line-height:1.75;color:var(--dim)}',
      '[data-dsh-mood] .about-card{padding:16px 18px;border-radius:14px;background:var(--chip);',
      '  border:1px solid var(--line);display:flex;flex-direction:column;gap:10px;',
      '  box-shadow:0 8px 24px rgba(0,0,0,.12)}',
      '[data-dsh-mood] .about-card-title{font-size:12px;font-weight:700;color:var(--fg);letter-spacing:.04em}',
      '[data-dsh-mood] .about-card-text{margin:0;font-size:12px;line-height:1.75;color:var(--dim)}',
      '[data-dsh-mood] .about-star{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;',
      '  padding:10px 20px;border-radius:999px;font-size:13px;font-weight:700;text-decoration:none;',
      '  color:#fff;background:linear-gradient(135deg,#ffb057,#ff5c85 55%,#a06bff);',
      '  box-shadow:0 8px 22px rgba(255,92,133,.35);',
      '  transition:transform .15s ease,box-shadow .15s ease,filter .15s ease}',
      '[data-dsh-mood] .about-star:hover{transform:translateY(-2px);filter:brightness(1.08);',
      '  box-shadow:0 12px 30px rgba(255,92,133,.45)}',
      '[data-dsh-mood] .about-star:active{transform:translateY(0) scale(.98)}',
      // B 站主页卡片：截图 + 说明
      '[data-dsh-mood] .about-bili-card{align-self:stretch;display:flex;flex-direction:column;gap:6px;',
      '  text-decoration:none;border-radius:12px;overflow:hidden;',
      '  border:1px solid var(--line);background:var(--track);',
      '  transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease}',
      '[data-dsh-mood] .about-bili-card:hover{transform:translateY(-2px);',
      '  border-color:#fb7299;box-shadow:0 10px 24px rgba(251,114,153,.28)}',
      '[data-dsh-mood] .about-bili-card:active{transform:translateY(0) scale(.995)}',
      '[data-dsh-mood] .about-bili-img{display:block;width:100%;height:auto}',
      '[data-dsh-mood] .about-bili-card.self:hover{border-color:var(--accent);',
      '  box-shadow:0 10px 24px rgba(99,166,255,.28)}',
      '[data-dsh-mood] .about-bili-cap{font-size:12px;font-weight:700;color:var(--dim);',
      '  padding:0 10px 9px}',
      '[data-dsh-mood] .about-bili-card:hover .about-bili-cap{color:var(--fg)}',
      '[data-dsh-mood] .about-code{padding:9px 12px;border-radius:10px;background:var(--track);',
      '  border:1px solid var(--line);overflow-x:auto}',
      '[data-dsh-mood] .about-code code{font:11.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;',
      '  color:var(--dim);white-space:nowrap;user-select:all}',
      '[data-dsh-mood] .text-input{width:180px;font:inherit;font-size:12px;padding:7px 12px;border-radius:9px;',
      '  color:var(--fg);background:color-mix(in srgb, var(--fg) 5%, transparent);border:1px solid var(--line);',
      '  appearance:none;transition:border-color .18s ease,box-shadow .18s ease,background .18s ease}',
      '[data-dsh-mood] .text-input:focus{outline:none;border-color:var(--accent);',
      '  background:color-mix(in srgb, var(--fg) 8%, transparent);',
      '  box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent)}'
    ].join('')

    const band = (v) => (v <= 33 ? '低' : v <= 66 ? '中' : '高')

    function lighten(hex, ratio) {
      try { return rgbCss(mix(hexToRgb(hex), { r: 255, g: 255, b: 255 }, ratio)) } catch { return hex }
    }

    function ensureStyle() {
      try {
        if (typeof document === 'undefined') return
        let el = document.getElementById(STYLE_ID)
        if (!el) {
          el = document.createElement('style')
          el.id = STYLE_ID
          document.head.appendChild(el)
        }
        if (el.textContent !== CSS) el.textContent = CSS
      } catch { /* 样式注入失败不影响渲染 */ }
    }

    // ---------- 雷达 ----------
    const R = 70
    const ANGLE = (i) => (-90 + i * 60) * (Math.PI / 180)
    const point = (i, ratio) => [Math.cos(ANGLE(i)) * R * ratio, Math.sin(ANGLE(i)) * R * ratio]
    const polygon = (values) =>
      values.map((v, i) => point(i, Math.max(0, Math.min(100, v)) / 100).join(',')).join(' ')

    function Radar({ state, color, pulse }) {
      const values = DIMS.map(([key]) => Number(state[key] ?? 0))
      const rings = [0.25, 0.5, 0.75, 1]
      return React.createElement('div', { className: 'radarwrap' + (pulse ? ' pulse' : '') },
        React.createElement('svg', { width: 200, height: 200, viewBox: '-100 -100 200 200' },
          ...rings.map((r, idx) =>
            React.createElement('polygon', {
              key: 'ring' + idx, points: polygon(new Array(6).fill(r * 100)),
              fill: 'none', stroke: 'var(--grid)', strokeWidth: 1
            })),
          ...DIMS.map(([, , , ,], i) => {
            const [x, y] = point(i, 1)
            return React.createElement('line', {
              key: 'axis' + i, x1: 0, y1: 0, x2: x, y2: y, stroke: 'var(--grid)', strokeWidth: 1
            })
          }),
          React.createElement('circle', { cx: 0, cy: 0, r: 1.6, fill: 'var(--grid)' }),
          React.createElement('polygon', {
            points: polygon(values), fill: color, fillOpacity: 0.26,
            stroke: color, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round'
          }),
          ...values.map((v, i) => {
            const [x, y] = point(i, Math.max(0, Math.min(100, v)) / 100)
            return React.createElement('circle', {
              key: 'dot' + i, cx: x, cy: y, r: 3.4, fill: '#fff',
              fillOpacity: 1, stroke: color, strokeWidth: 1.4
            })
          }),
          ...DIMS.map(([, name], i) => {
            const [x, y] = point(i, 1.12)
            const anchor = Math.abs(x) < 1 ? 'middle' : (x > 0 ? 'start' : 'end')
            return React.createElement('text', {
              key: 'txt' + i, x, y, textAnchor: anchor, dominantBaseline: 'middle',
              fontSize: 10, fill: 'var(--dim)'
            }, name)
          })
        ))
    }

    function Spark({ values, color }) {
      const w = 30, h = 12
      const pts = values.length >= 2 ? values : [values[0] ?? 0, values[0] ?? 0]
      const step = w / Math.max(1, pts.length - 1)
      const d = pts.map((v, i) => {
        const x = i * step
        const y = h - (Math.max(0, Math.min(100, v)) / 100) * h
        return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1)
      }).join(' ')
      return React.createElement('span', { className: 'spark' },
        React.createElement('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h },
          React.createElement('path', {
            d, fill: 'none', stroke: color, strokeWidth: 1.4,
            strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.9
          })))
    }

    // ---------- 图标 ----------
    const svgProps = {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round'
    }
    const IconRefresh = () => React.createElement('svg', svgProps,
      React.createElement('path', { d: 'M20 11a8 8 0 1 0-2.3 6.4' }),
      React.createElement('path', { d: 'M20 4v7h-7' }))
    const IconCode = () => React.createElement('svg', svgProps,
      React.createElement('path', { d: 'M9 6 3 12l6 6' }),
      React.createElement('path', { d: 'M15 6l6 6-6 6' }))

    const MoodIcon = ({ size = 16, className }) => React.createElement('svg', {
      width: size, height: size, viewBox: '0 0 24 24', className, 'aria-hidden': 'true'
    },
      React.createElement('defs', null,
        React.createElement('linearGradient', { id: 'dshMoodHeart', x1: '0', y1: '0', x2: '0', y2: '1' },
          React.createElement('stop', { offset: '0%', stopColor: '#ff8fb1' }),
          React.createElement('stop', { offset: '100%', stopColor: '#ff3d6e' }))),
      React.createElement('path', {
        d: 'M12 20.4s-7.4-4.5-7.4-9.8A4.7 4.7 0 0 1 12 7.3a4.7 4.7 0 0 1 7.4 3.3c0 5.3-7.4 9.8-7.4 9.8z',
        fill: 'url(#dshMoodHeart)', stroke: '#ff5c85', strokeWidth: 0.8, strokeLinejoin: 'round'
      }),
      React.createElement('ellipse', {
        cx: 9.1, cy: 9.8, rx: 2.1, ry: 1.35, transform: 'rotate(-28 9.1 9.8)',
        fill: '#ffffff', fillOpacity: 0.5
      }))

    const IconPaw = () => React.createElement('svg', { viewBox: '0 0 24 24', fill: 'currentColor', stroke: 'none' },
      React.createElement('ellipse', { cx: 12, cy: 15.5, rx: 5.6, ry: 4.6 }),
      React.createElement('circle', { cx: 6.2, cy: 10.4, r: 2.1 }),
      React.createElement('circle', { cx: 17.8, cy: 10.4, r: 2.1 }),
      React.createElement('circle', { cx: 9.2, cy: 6.6, r: 1.9 }),
      React.createElement('circle', { cx: 14.8, cy: 6.6, r: 1.9 }))

    // ---------- 时间轴 ----------
    function timelineText(row) {
      const note = row.drivers && row.drivers[0] && row.drivers[0].note
      return note || ('心情变成「' + (row.label || '平') + '」')
    }

    /** 把「📅 2026年10月27日 星期二 🌥️ 多云」拆成三段 + 正文。 */
    function parseDiary(text) {
      const lines = String(text || '').split(String.fromCharCode(10))
      const head = lines[0] || ''
      const body = lines.slice(1).join(String.fromCharCode(10)).trim()
      if (head.indexOf('📅') !== 0) return { date: head || '', week: '', weather: '', body: String(text || '').trim() }
      const tokens = head.replace('📅', '').trim().split(/\s+/)
      let week = ''
      const rest = []
      for (const t of tokens) {
        if (/^星期[一二三四五六日天]$/.test(t)) week = t
        else rest.push(t)
      }
      const date = rest.shift() || ''
      const weather = rest.join(' ')
      return { date, week, weather, body }
    }

    // ---------- 手账本图标（5 种风格，纯手写 SVG） ----------
    const ICON_NS_DEFS = 'dshMoodBookCover'

    function IconPen({ size = 16 }) {
      return React.createElement('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' },
        React.createElement('defs', null,
          React.createElement('linearGradient', { id: ICON_NS_DEFS, x1: '0', y1: '0', x2: '1', y2: '1' },
            React.createElement('stop', { offset: '0%', stopColor: '#8c5a3c' }),
            React.createElement('stop', { offset: '100%', stopColor: '#5b3524' }))),
        React.createElement('rect', { x: 3.2, y: 2.6, width: 15.2, height: 18.8, rx: 2.4, fill: 'url(#' + ICON_NS_DEFS + ')', stroke: '#3f241a', strokeWidth: 0.9 }),
        React.createElement('rect', { x: 5.4, y: 2.6, width: 1.1, height: 18.8, fill: 'rgba(255,255,255,.18)' }),
        React.createElement('rect', { x: 18.4, y: 4.4, width: 2.6, height: 15.2, rx: 1.1, fill: '#f3e6c8', stroke: '#c9b28a', strokeWidth: 0.7 }),
        React.createElement('path', {
          d: 'M12.6 15.4c1.9-3.5 3.4-6.3 3.1-8.6-.9.5-2.4 1.7-3.4 3.4-.9 1.5-1.1 2.9-.6 4.1l.9 1.1z',
          fill: '#f6efdf', stroke: '#b9a684', strokeWidth: 0.6
        }),
        React.createElement('path', { d: 'M12.2 16.2 11 18.4', stroke: '#3f241a', strokeWidth: 1, strokeLinecap: 'round' }))
    }

    function IconFin({ size = 16 }) {
      return React.createElement('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' },
        // 封面
        React.createElement('rect', { x: 3.6, y: 3, width: 16.8, height: 18, rx: 2.2, fill: '#2b6f8f', stroke: '#173f52', strokeWidth: 1 }),
        React.createElement('rect', { x: 6, y: 3, width: 1, height: 18, fill: 'rgba(255,255,255,.16)' }),
        // 鱼鳍
        React.createElement('path', {
          d: 'M12.2 15.8c-.4-2.9.3-5.3 2.2-7 1.2 1.3 2 2.9 2.2 4.6.2 1.4-.2 2.4-1.2 3.1l-3.2-.7z',
          fill: '#8fe3ff', stroke: '#3aa6c9', strokeWidth: 0.7
        }),
        React.createElement('path', { d: 'M12.2 16.4c.9-.4 1.7-1.1 2.3-2M12.6 14.2c.7-.3 1.3-.8 1.8-1.4', stroke: '#1e5b74', strokeWidth: 0.6, strokeLinecap: 'round' }),
        // 气泡
        React.createElement('circle', { cx: 8.6, cy: 9.4, r: 1.05, fill: 'rgba(255,255,255,.72)' }),
        React.createElement('circle', { cx: 7.9, cy: 12.2, r: 0.65, fill: 'rgba(255,255,255,.55)' }))
    }

    function IconStar({ size = 16 }) {
      return React.createElement('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' },
        React.createElement('rect', { x: 3.6, y: 3, width: 16.8, height: 18, rx: 2.2, fill: '#5b4a86', stroke: '#38285c', strokeWidth: 1 }),
        React.createElement('rect', { x: 6, y: 3, width: 1, height: 18, fill: 'rgba(255,255,255,.14)' }),
        // 贴纸底色（略歪，像贴上去的）
        React.createElement('rect', { x: 9.2, y: 8.6, width: 9.4, height: 8.4, rx: 2, fill: '#fdf3c9', opacity: '0.92', transform: 'rotate(-7 13.9 12.8)' }),
        // 星星
        React.createElement('path', {
          d: 'M14 9.9l.95 2.05 2.25.2-1.7 1.5.5 2.2-2-1.2-2 1.2.5-2.2-1.7-1.5 2.25-.2z',
          fill: '#ffcf4d', stroke: '#e0a800', strokeWidth: 0.6, transform: 'rotate(-7 14 12.8)'
        }))
    }

    function IconSea({ size = 16 }) {
      return React.createElement('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' },
        React.createElement('rect', { x: 3.6, y: 3, width: 16.8, height: 18, rx: 2.2, fill: '#1f5f57', stroke: '#113832', strokeWidth: 1 }),
        React.createElement('rect', { x: 6, y: 3, width: 1, height: 18, fill: 'rgba(255,255,255,.14)' }),
        // 海草
        React.createElement('path', {
          d: 'M9.4 18.6c-.9-1.6-.4-2.7.2-4 .6-1.4.5-2.3-.3-3.6M13 18.6c.9-1.7.3-2.9-.3-4.2-.5-1.2-.5-2.1.1-3.3M16.4 18.6c.6-1.2.2-2.2-.2-3.2',
          fill: 'none', stroke: '#5fd6a8', strokeWidth: 1.15, strokeLinecap: 'round'
        }),
        // 气泡
        React.createElement('circle', { cx: 15.6, cy: 8.2, r: 0.95, fill: 'rgba(255,255,255,.6)' }),
        React.createElement('circle', { cx: 12.2, cy: 7.4, r: 0.62, fill: 'rgba(255,255,255,.45)' }))
    }

    function IconKraft({ size = 16 }) {
      return React.createElement('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' },
        React.createElement('rect', { x: 3.6, y: 3, width: 16.8, height: 18, rx: 1.8, fill: '#d8bd91', stroke: '#a98a5c', strokeWidth: 1 }),
        React.createElement('rect', { x: 6.2, y: 3, width: 1.2, height: 18, fill: 'rgba(255,255,255,.28)' }),
        // 斜贴的便签纸（带两行字）
        React.createElement('rect', {
          x: 9.4, y: 8.4, width: 8.2, height: 6.2, rx: 1,
          fill: '#fdf6e6', stroke: '#c2a97f', strokeWidth: 0.7,
          transform: 'rotate(-6 13.5 11.5)'
        }),
        React.createElement('path', {
          d: 'M10.6 10.8h5.6M10.4 12.9h4.2',
          stroke: '#b49a72', strokeWidth: 0.8, strokeLinecap: 'round',
          transform: 'rotate(-6 13.5 11.5)'
        }))
    }

    function IconHeart({ size = 16 }) {
      return React.createElement('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true' },
        React.createElement('rect', { x: 3.6, y: 3, width: 16.8, height: 18, rx: 2.2, fill: '#6d4a7a', stroke: '#432a4d', strokeWidth: 1 }),
        React.createElement('rect', { x: 6, y: 3, width: 1, height: 18, fill: 'rgba(255,255,255,.14)' }),
        React.createElement('path', {
          d: 'M12 17.4s-4.4-2.7-4.4-5.6a2.6 2.6 0 0 1 4.4-1.9 2.6 2.6 0 0 1 4.4 1.9c0 2.9-4.4 5.6-4.4 5.6z',
          fill: '#ff8fb1', stroke: '#e05c85', strokeWidth: 0.7
        }))
    }

    const DIARY_ICONS = { kraft: IconKraft, fin: IconFin, star: IconStar, sea: IconSea, heart: IconHeart }
    const DIARY_ICON_LIST = [
      ['kraft', '牛皮纸'], ['fin', '鱼鳍'], ['star', '星星贴纸'], ['sea', '海草气泡'], ['heart', '爱心贴纸']
    ]

    function DiaryIcon({ name, size }) {
      const C = DIARY_ICONS[name] || IconPen
      return React.createElement(C, { size })
    }

    const FLIP_MS = 420

    function DiaryBook({ entries, index, onIndex, onClose, fontSize }) {
      // 数据是「旧 → 新」（entries[0] = 最旧，entries[total-1] = 今天）。
      // index 是 0 基下标，页码 = index + 1；第一页最旧，最后一页今天。
      // 防御：无论外部传进来什么顺序，这里强制按日期升序（最旧在前、今天在最后）
      // 同日去重（后端若出错返回了重复日期，前端也保证每页唯一）+ 强制升序
      const seen = new Map()
      for (const e of (entries || [])) {
        const k = String(e.date || '')
        const prev = seen.get(k)
        if (!prev || Number(e.ts || 0) > Number(prev.ts || 0)) seen.set(k, e)
      }
      const list = [...seen.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))
      const total = list.length
      const safeIndex = Math.max(0, Math.min(Number(index) || 0, Math.max(0, total - 1)))
      const entry = total > 0 ? list[safeIndex] : null
      const parsed = entry ? parseDiary(entry.text) : { date: '', week: '', weather: '', body: '还没有日记' }

      // 翻页方向 + 动画锁（防止狂点堆叠）
      const [dir, setDir] = React.useState('none')     // 'prev' | 'next' | 'none'
      const [flipping, setFlipping] = React.useState(false)
      const lockTimer = React.useRef(0)
      React.useEffect(() => () => { if (lockTimer.current) clearTimeout(lockTimer.current) }, [])

      const canPrev = safeIndex > 0 && !flipping    // ‹ 更早
      const canNext = safeIndex < total - 1 && !flipping // › 更近

      const flip = (step) => {
        if (flipping) return
        const target = safeIndex + step
        if (target < 0 || target >= total) return
        setDir(step < 0 ? 'prev' : 'next')          // 往前翻 / 往后翻
        setFlipping(true)
        onIndex(target)
        lockTimer.current = setTimeout(() => {
          setFlipping(false)
          setDir('none')
        }, FLIP_MS)
      }
      const goPrev = () => { if (canPrev) flip(-1) }
      const goNext = () => { if (canNext) flip(1) }

      return React.createElement('div', {
        className: 'book-mask',
        onClick: (e) => { if (e.target === e.currentTarget) onClose() }
      },
        React.createElement('div', { className: 'book-wrap' },
          React.createElement('div', { className: 'book' },
            // 关闭：右上角极简悬浮
            React.createElement('button', { className: 'book-close', onClick: onClose, title: '合上' }, '×'),
            React.createElement('div', { className: 'book-stage' },
            React.createElement('div', { className: 'book-page' },
              React.createElement('div', { className: 'book-inner' + (dir === 'none' ? '' : ' slide-' + dir) },
              React.createElement('div', { className: 'book-head' },
                React.createElement('span', { className: 'book-head-date' }, parsed.date),
                React.createElement('span', { className: 'book-head-week' }, parsed.week),
                React.createElement('span', { className: 'book-head-weather' }, parsed.weather)),
              React.createElement('div', { className: 'book-rule' }),
              React.createElement('div', {
                className: 'book-text',
                style: fontSize ? { fontSize: fontSize + 'px' } : undefined
              }, parsed.body)))),
            // 翻页箭头：左下 / 右下，绝对对称
            React.createElement('button', {
              className: 'book-arrow prev', disabled: !canPrev,
              title: '前一天', onClick: goPrev
            }, '‹'),
            React.createElement('button', {
              className: 'book-arrow next', disabled: !canNext,
              title: '后一天', onClick: goNext
            }, '›'),
            // 页码：书页底部正中央，像真书
            React.createElement('div', { className: 'book-pager' },
              (safeIndex + 1) + ' / ' + total))))
    }

    function Timeline({ rows }) {
      if (!rows || !rows.length) return React.createElement('div', { className: 'tl-empty' }, '暂无记忆')
      return React.createElement('div', { className: 'tl' },
        ...rows.map((row, i) => {
          const t = new Date(row.ts)
          const hh = String(t.getHours()).padStart(2, '0')
          const mm = String(t.getMinutes()).padStart(2, '0')
          const latest = i === 0
          return React.createElement('div', { className: 'tl-item' + (latest ? ' latest' : ''), key: 'tl' + i },
            React.createElement('span', { className: 'tl-time' }, hh + ':' + mm),
            React.createElement('span', { className: 'tl-text' }, timelineText(row)))
        }))
    }

    // ---------- 自适应 Tooltip（替掉原生 title） ----------
    function Hint({ text }) {
      const [hover, setHover] = React.useState(false)
      return React.createElement('span', {
        className: 'hint-wrap',
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        'aria-label': text
      },
        React.createElement('span', { className: 'hint-q' }, '?'),
        hover ? React.createElement('span', { className: 'hint-tip' }, text) : null)
    }

    // ---------- 互动：文案库 + 菜单 ----------

    const INTERACT_ACTIONS = [
      { key: 'headpat', label: '摸摸', icon: '👋' },
      { key: 'feed', label: '投喂', icon: '🐟' },
      { key: 'tease', label: '逗她', icon: '👉' }
    ]

    // 每个动作一套文案，按当天次数分层
    const INTERACT_TEXTS = {
      headpat: {
        happy: ['嘿嘿，摸摸头～', '再摸摸嘛，这里也要', '嗯…舒服得想冒泡泡'],
        enough: ['今天已经摸得够多啦。', '再摸要上瘾了哦'],
        limit: ['再摸就要掉鳞片了哦！'],
        refuse: ['别摸了，要被摸秃了！', '手拿开啦，鱼也是有尊严的', '(躲进壳里) 罢工了罢工了！']
      },
      feed: {
        happy: ['小鱼干！最喜欢了！', '再来一点，就一点', '嚼嚼…好吃'],
        enough: ['吃不下了……肚子要撑破了。', '你喂得太勤啦'],
        limit: ['再喂我就变成胖头鱼了！'],
        refuse: ['真的吃不下了，别塞了！', '(把鱼干推回去) 留到明天吧', '撑到游不动了……']
      },
      tease: {
        happy: ['干嘛戳我呀！', '哼，不理你了！（但还是偷偷看你）', '别戳啦，痒'],
        enough: ['又逗我……', '你再这样我要生气了哦'],
        limit: ['再逗我，我就用水泼你啦！'],
        refuse: ['不理你了，臭鱼干！', '(尾巴一甩) 走开啦', '再逗我就咬你！杂鱼！']
      }
    }

    function pickText(action, count) {
      const lib = INTERACT_TEXTS[action] || INTERACT_TEXTS.headpat
      const pool = count <= 2 ? lib.happy
        : count <= 4 ? lib.enough
          : count === 5 ? lib.limit
            : lib.refuse
      return pool[Math.floor(Math.random() * pool.length)]
    }

    // ---------- 面板 ----------
    function Panel(props) {
      const bare = Boolean(props && props.variant === 'console')
      const [snap, setSnap] = React.useState(null)
      const [rows, setRows] = React.useState([])
      const [words, setWords] = React.useState(false)
      const [gone, setGone] = React.useState(false)
      const [at, setAt] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      const [pulse, setPulse] = React.useState({})
      const [pat, setPat] = React.useState(false)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const menuRef = React.useRef(null)
      React.useEffect(() => {
        if (!menuOpen) return () => {}
        const onDown = (e) => {
          try {
            const el = menuRef.current
            if (el && e.target && el.contains(e.target)) return
          } catch { /* 吞 */ }
          setMenuOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => { try { document.removeEventListener('mousedown', onDown, true) } catch { /* 吞 */ } }
      }, [menuOpen])
      const [toast, setToast] = React.useState(null)   // { text, id }
      const toastId = React.useRef(0)
      const toastTimers = React.useRef({ out: 0, rm: 0 })
      const clearToastTimers = () => {
        if (toastTimers.current.out) clearTimeout(toastTimers.current.out)
        if (toastTimers.current.rm) clearTimeout(toastTimers.current.rm)
        toastTimers.current = { out: 0, rm: 0 }
      }
      // 显示一条气泡：停留 3 秒 → 淡出 0.3 秒 → 移除
      const showToast = (text) => {
        clearToastTimers()
        toastId.current += 1
        const id = toastId.current
        setToast({ text, id, leaving: false })
        toastTimers.current.out = setTimeout(() => {
          setToast((cur) => (cur && cur.id === id ? { ...cur, leaving: true } : cur))
        }, 3000)
        toastTimers.current.rm = setTimeout(() => {
          setToast((cur) => (cur && cur.id === id ? null : cur))
        }, 3300)
      }
      React.useEffect(() => () => clearToastTimers(), [])
      const [diaryEntries, setDiaryEntries] = React.useState([])
      const [diaryIndex, setDiaryIndex] = React.useState(0)
      const [diaryOpen, setDiaryOpen] = React.useState(false)
      const [unread, setUnread] = React.useState(0)
      const [appearance] = useAppearance()
      const [diaryPrefs] = useDiaryPrefs()
      const timer = React.useRef(0)
      const hist = React.useRef({ turn: null, rows: {} })
      const prev = React.useRef(null)
      const pulseTimer = React.useRef(0)
      const patTimer = React.useRef(0)

      const pull = React.useCallback(async () => {
        setBusy(true)
        try {
          const res = await fetch('/dsh-mood/state', { cache: 'no-store' })
          if (!res.ok) { setGone(true); return }
          const data = await res.json()
          setSnap(data)
          setGone(false)
          setAt(new Date().toLocaleTimeString())
          if (Array.isArray(data.history)) setRows(data.history)
          try {
            const dr = await fetch('/dsh-mood/diary', { cache: 'no-store' })
            if (dr.ok) {
              const dd = await dr.json()
              const list = (dd.entries || []).slice()
              setDiaryEntries(list)
              // 轮询只做「越界钳制」：用户停在哪一页就留在哪一页，绝不被刷新踢回第 1 页
              setDiaryIndex((prev) => {
                const max = Math.max(0, list.length - 1)
                return Math.min(Math.max(Number(prev) || 0, 0), max)
              })
              // 未读 = ts 比上次已读时间新的篇数
              const lastRead = loadLastRead()
              setUnread(list.filter((e) => Number(e.ts || 0) > lastRead).length)
            }
          } catch { /* 日记拉不到不影响面板 */ }

          const before = prev.current
          if (before && before.state && data.state) {
            const hit = {}
            let any = false
            for (const [key] of DIMS) {
              if (Math.abs(Number(data.state[key] ?? 0) - Number(before.state[key] ?? 0)) > CHANGE_THRESHOLD) {
                hit[key] = true
                any = true
              }
            }
            if (any) {
              setPulse(hit)
              if (pulseTimer.current) clearTimeout(pulseTimer.current)
              pulseTimer.current = setTimeout(() => setPulse({}), PULSE_MS)
            }
          }
          prev.current = data

          const h = hist.current
          if (data.turn !== h.turn) {
            h.turn = data.turn
            for (const [key] of DIMS) {
              const arr = h.rows[key] || (h.rows[key] = [])
              arr.push(Number(data.state?.[key] ?? 0))
              if (arr.length > HISTORY_MAX) arr.shift()
            }
          }
        } catch {
          setGone(true)
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        ensureStyle()
        pull()
        fetch('/dsh-mood/mode', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((m) => { if (m) setWords(m.display === 'words') })
          .catch(() => {})
        timer.current = setInterval(pull, POLL_MS)
        return () => {
          if (timer.current) clearInterval(timer.current)
          if (pulseTimer.current) clearTimeout(pulseTimer.current)
          if (patTimer.current) clearTimeout(patTimer.current)
          timer.current = 0
        }
      }, [pull])

      const interact = async (action) => {
        setPat(true)
        if (patTimer.current) clearTimeout(patTimer.current)
        patTimer.current = setTimeout(() => setPat(false), 500)
        try {
          const res = await fetch('/dsh-mood/interact', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            cache: 'no-store', body: JSON.stringify({ action })
          })
          const body = await res.json().catch(() => null)
          console.log('[dsh-mood] interact ->', res.status, body)
          const info = body && body.interact
          const count = info && Number.isFinite(info.count) ? info.count : 1
          const text = pickText((info && info.action) || action, count)
          console.log('[dsh-mood] interact text ->', text)
          showToast(text)
          await pull()
        } catch (err) {
          console.error('[dsh-mood] interact 请求失败', err)
          showToast('刚才没摸到，再试一次？')
        }
      }

      const copy = async () => {
        try {
          const text = JSON.stringify(snap, null, 2)
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        } catch { /* 复制失败就算了 */ }
      }

      const label = (snap && snap.label) || '—'
      const action = (snap && snap.action) || ''
      // 2 字 32px / 3 字 28px / 4 字 24px / 更长 20px
      const labelLen = label.length
      const labelSize = labelLen <= 2 ? 32 : labelLen === 3 ? 28 : labelLen === 4 ? 24 : 20
      const valenceNow = Number((snap && snap.state && snap.state.valence) ?? 55)
      const moodClass = valenceNow >= 60 ? 'pos' : valenceNow <= 45 ? 'neg' : 'mid'
      const labelColor = LABEL_COLORS[label] || '#63a6ff'
      const labelLight = lighten(labelColor, 0.55)

      const rootProps = {
        'data-dsh-mood': '',
        'data-mode': appearance.mode,
        className: bare ? 'bare' : undefined,
        style: {
          ...appearanceVars(appearance),
          // 用户没指定就用当前情绪色
          '--timeline-accent': appearance.timelineAccent || labelColor
        }
      }

      const head = React.createElement('div', { className: 'head' },
        React.createElement('div', {
          className: 'badge ' + moodClass,
          style: { fontSize: labelSize + 'px' },
          title: label
        }, label),
        action ? React.createElement('div', { className: 'label-action' }, action) : null)

      const foot = React.createElement('div', { className: 'foot' },
        React.createElement('span', null, at ? '最后更新 ' + at : '尚未更新'),
        bare
          ? React.createElement('div', { className: 'btns' },
              React.createElement('button', { className: 'btn', title: '原始 JSON', onClick: () => setOpen(!open) },
                React.createElement(IconCode), '</>'),
              React.createElement('button', { className: 'btn', title: '立即刷新', onClick: () => pull() },
                React.createElement(IconRefresh), '刷新'))
          : null)

      const EMPTY = '暂无心情记录，去和她聊两句吧～'
      if (!snap) {
        return React.createElement('div', rootProps,
          React.createElement('div', { className: 'empty' }, gone ? EMPTY : '读取中…'),
          gone ? foot : null)
      }
      if (!snap.state || typeof snap.state !== 'object') {
        return React.createElement('div', rootProps,
          React.createElement('div', { className: 'empty' }, EMPTY), foot)
      }

      const state = snap.state || {}
      const drivers = Array.isArray(snap.drivers) ? snap.drivers.slice(0, 3) : []
      const flashing = Object.keys(pulse).length > 0

      return React.createElement('div', rootProps,
        // 互动反馈气泡
        toast
          ? React.createElement('div', {
              className: 'pat-toast' + (toast.leaving ? ' leaving' : ''),
              key: toast.id,
              onClick: () => { clearToastTimers(); setToast(null) },
              title: '点一下收起'
            }, toast.text)
          : null,
        head,
        React.createElement('div', { style: { position: 'relative' } },
          React.createElement(Radar, { state, color: labelColor, pulse: flashing }),
          React.createElement('div', { className: 'pat-wrap', ref: menuRef },
            React.createElement('button', {
              className: 'pat-btn', title: '和鱼鱼互动',
              onClick: (e) => {
                e.stopPropagation()          // 别让 document 的 mousedown 立刻关掉
                setMenuOpen((v) => !v)
              }
            }, React.createElement(IconPaw), '互动'),
            menuOpen
              ? React.createElement('div', { className: 'pat-menu' },
                  ...INTERACT_ACTIONS.map((a) => React.createElement('button', {
                    key: a.key,
                    className: 'pat-item',
                    onClick: () => {
                      setMenuOpen(false)
                      interact(a.key)
                    }
                  },
                    React.createElement('span', { className: 'pat-ico' }, a.icon),
                    React.createElement('span', null, a.label))))
              : null)
        ),
        React.createElement('div', { className: 'tl-head' },
          React.createElement('span', { className: 'tl-head-title' }, '情绪时间轴'),
          diaryEntries.length
            ? React.createElement('button', {
                className: 'diary-dot-btn',
                title: unread > 0 ? ('有 ' + unread + ' 篇没看的日记') : '翻开鱼鱼的手账本',
                onClick: () => {
                  // 点开即视为已读
                  const newest = diaryEntries.reduce((m, e) => Math.max(m, Number(e.ts || 0)), 0)
                  if (newest > 0) saveLastRead(newest)
                  setUnread(0)
                  // 打开就翻到最后一页（也就是今天）
                  setDiaryIndex(Math.max(0, diaryEntries.length - 1))
                  setDiaryOpen(true)
                }
              },
                React.createElement(DiaryIcon, { name: diaryPrefs.icon, size: 16 }),
                unread > 0
                  ? React.createElement('span', { className: 'diary-badge' }, unread > 9 ? '9+' : String(unread))
                  : null)
            : null),
        React.createElement(Timeline, { rows }),
        React.createElement('div', { className: 'stats' },
          ...DIMS.map(([key, name, tip, dark, light2]) => {
            const v = Math.max(0, Math.min(100, Math.round(Number(state[key] ?? 0))))
            const width = v <= 0 ? '0%' : Math.max(3, v) + '%'
            const series = (hist.current.rows[key] || [v])
            return React.createElement('div', { className: 'row' + (pulse[key] ? ' pulse' : ''), key },
              React.createElement('span', { className: 'name' },
                React.createElement(Hint, { text: tip }),
                name),
              React.createElement('span', { className: 'track' },
                React.createElement('span', {
                  className: 'fill',
                  style: { width, background: 'linear-gradient(90deg,' + dark + ',' + light2 + ')' }
                })),
              React.createElement('span', { className: 'val' },
                React.createElement('span', { className: 'num' }, String(v)),
                words ? React.createElement('span', { className: 'band' }, band(v)) : null),
              React.createElement(Spark, { values: series, color: light2 }))
          })),
        drivers.length
          ? React.createElement('div', { className: 'chips' },
              React.createElement('span', { className: 'reason-label' }, '原因：'),
              ...drivers.map((d, i) =>
                React.createElement('span', { className: 'chip', key: 'c' + i },
                  d.note + ' ' + (d.confidence !== undefined ? d.confidence : ''))))
          : null,
        (bare && open)
          ? React.createElement('div', null,
              React.createElement('div', { className: 'btns', style: { justifyContent: 'flex-end', marginBottom: '6px' } },
                React.createElement('button', { className: 'btn', onClick: copy }, copied ? '已复制' : '复制')),
              React.createElement('div', { className: 'drawer' },
                React.createElement('pre', null, JSON.stringify(snap, null, 2))))
          : null,
        foot,
        diaryOpen && diaryEntries.length
          ? (() => {
              const modal = React.createElement('div', { className: 'book-layer' },
                React.createElement(DiaryBook, {
                  entries: diaryEntries,
                  index: diaryIndex,
                  onIndex: setDiaryIndex,
                  fontSize: diaryPrefs.fontSize,
                  onClose: () => setDiaryOpen(false)
                }))
              try {
                const ReactDOM = require('react-dom')
                if (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined') {
                  return ReactDOM.createPortal(modal, document.body)
                }
              } catch { /* 吞 */ }
              return modal
            })()
          : null)
    }

    // ---------- 外观面板 ----------
    function AppearanceGroup() {
      const [appearance, update] = useAppearance()
      // 记住"最后一次点的预设"，↺ 用它来回滚微调
      const [basePresetId, setBasePresetId] = React.useState(null)
      const [advanced, setAdvanced] = React.useState(false)

      const resolvedBase = (() => {
        if (basePresetId) {
          const hit = PRESETS.find((p) => p.id === basePresetId)
          if (hit) return hit
        }
        // 没手动点过：按当前参数猜一个最接近的
        const exact = PRESETS.find((p) => samePreset(appearance, p))
        if (exact) return exact
        return PRESETS.find((p) => p.mode === appearance.mode) || DEFAULT_PRESET
      })()

      const applyPreset = (pr) => {
        setBasePresetId(pr.id)
        update({
          mode: pr.mode, glass: pr.glass, opacity: pr.opacity, blur: pr.blur, border: pr.border,
          timelineSize: numOr(pr.timelineSize, APPEARANCE_DEFAULT.timelineSize, 10, 16)
        })
      }
      // 预设只覆盖玻璃相关参数，时间轴偏好保持用户设置
      const resetTweaks = () => {
        setBasePresetId(resolvedBase.id)
        update({
          mode: resolvedBase.mode, opacity: resolvedBase.opacity, blur: resolvedBase.blur, border: resolvedBase.border,
          timelineSize: numOr(resolvedBase.timelineSize, APPEARANCE_DEFAULT.timelineSize, 10, 16)
        })
      }

      // 单行 ↺：只把这一项恢复成当前预设的值，别的滑块不动
      const slider = (label, key, min, max, step, fmt) => {
        // 兜底顺序：预设值 → APPEARANCE_DEFAULT → 滑块最小值（最后才用 min）
        const fallback = numOr(APPEARANCE_DEFAULT[key], min, min, max)
        const baseVal = numOr(resolvedBase[key], fallback, min, max)
        const current = numOr(appearance[key], baseVal, min, max)
        const atDefault = Math.abs(current - baseVal) < 1e-6
        return React.createElement('div', { className: 'field', key },
          React.createElement('label', null, label),
          React.createElement('div', { className: 'rowline' },
            React.createElement('input', {
              type: 'range', min, max, step, value: current,
              onChange: (e) => update({ [key]: numOr(e.target.value, current, min, max) })
            }),
            React.createElement('span', { className: 'band', style: { width: '46px', textAlign: 'right' } }, fmt(current)),
            // 常驻重置位：已经是推荐值时变暗，但仍占位、仍可点（点了无变化）
            React.createElement('button', {
              className: 'reset-mini tiny' + (atDefault ? ' idle' : ''),
              title: '只把「' + label + '」恢复为「' + resolvedBase.name + '」的推荐值',
              onClick: () => {
                setBasePresetId(resolvedBase.id)
                update({ [key]: baseVal })
              }
            }, '↺')))
      }

      const activePreset = currentPresetId(appearance)

      return React.createElement('div', { className: 'group' },
        React.createElement('div', { className: 'group-title' }, '主题预设'),
        React.createElement('div', { className: 'presets' },
          ...PRESETS.map((pr) => React.createElement('button', {
            key: pr.id,
            className: 'preset' + (activePreset === pr.id ? ' on' : ''),
            onClick: () => applyPreset(pr)
          },
            React.createElement('span', {
              className: 'preset-dot',
              style: {
                background: 'linear-gradient(135deg,' + pr.glass + ',' + (pr.mode === 'light' ? '#ffffff' : '#000000') + ')',
                borderColor: pr.mode === 'light' ? 'rgba(0,0,0,.2)' : 'rgba(255,255,255,.3)'
              }
            }),
            React.createElement('span', { className: 'preset-name' }, pr.name)))),

        React.createElement('div', { className: 'field', style: { marginTop: '4px' } },
          React.createElement('div', { className: 'group-title', style: { padding: 0 } },
            '自定义微调 · 基于「' + resolvedBase.name + '」'),
          React.createElement('button', {
            className: 'btn reset-mini', title: '整组重置：把三项微调都恢复到该预设的推荐值',
            onClick: resetTweaks
          }, '↺')),

        React.createElement('div', { className: 'field' },
          React.createElement('label', null, '基础模式'),
          React.createElement('div', { className: 'rowline' },
            ...['dark', 'light'].map((m) =>
              React.createElement('button', {
                key: m, className: 'tab' + (appearance.mode === m ? ' on' : ''),
                onClick: () => update({ mode: m })
              }, m === 'dark' ? '深色' : '浅色')))),
        slider('玻璃透明度', 'opacity', 0.1, 1, 0.02, (v) => Math.round(v * 100) + '%'),
        slider('背景雾化', 'blur', 0, 30, 1, (v) => Math.round(v) + 'px'),
        slider('边框亮度', 'border', 0, 100, 1, (v) => Math.round(v) + '%'),
        slider('时间轴字号', 'timelineSize', 10, 16, 1, (v) => Math.round(v) + 'px'),

        React.createElement('div', { className: 'field' },
          React.createElement('label', null, '节点强调色'),
          React.createElement('div', { className: 'rowline' },
            React.createElement('input', {
              type: 'color',
              value: appearance.timelineAccent || '#63a6ff',
              onChange: (e) => update({ timelineAccent: e.target.value })
            }),
            appearance.timelineAccent
              ? React.createElement('button', {
                  className: 'btn', title: '恢复为跟随心情色',
                  onClick: () => update({ timelineAccent: '' })
                }, '跟随心情')
              : React.createElement('span', { className: 'band' }, '跟随心情色'))),

        // 高级：自定义玻璃色，默认收起
        React.createElement('button', {
          className: 'btn', style: { alignSelf: 'flex-start' },
          onClick: () => setAdvanced(!advanced)
        }, advanced ? '收起高级' : '高级：自定义玻璃色'),
        advanced
          ? React.createElement('div', { className: 'field' },
              React.createElement('label', null, '玻璃颜色'),
              React.createElement('div', { className: 'rowline' },
                React.createElement('input', {
                  type: 'color', value: appearance.glass,
                  onChange: (e) => update({ glass: e.target.value })
                }),
                React.createElement('span', { className: 'band' }, appearance.glass)))
          : null)
    }

    // ---------- 实时预览：固定在屏幕右侧的「真实面板」 ----------
    //
    // 不再做缩小/棋盘格：直接把 Panel（console 变体）放进一个 fixed 的玻璃容器里，
    // 尺寸 340px、100% 比例、真 backdrop-filter，透过它就是真实壁纸。
    /** 量出设置弹窗右边缘，算出右侧空白区的居中位置。 */
    function usePreviewLayout() {
      const [box, setBox] = React.useState(null)
      React.useEffect(() => {
        const calc = () => {
          try {
            const vw = window.innerWidth || 1280
            const width = Math.min(420, Math.round(vw * 0.4))
            const panel = document.querySelector('.wCInkW_panel')
            if (!panel) { setBox({ left: Math.max(12, vw - width - 24), width }); return }
            const rect = panel.getBoundingClientRect()
            const gapStart = rect.right
            const gap = vw - gapStart
            const left = gapStart + Math.max(12, (gap - width) / 2)
            setBox({ left: Math.round(left), width })
          } catch { /* 吞 */ }
        }
        calc()
        window.addEventListener('resize', calc)
        const timer = setInterval(calc, 400)
        return () => {
          try { window.removeEventListener('resize', calc) } catch { /* 吞 */ }
          clearInterval(timer)
        }
      }, [])
      return box
    }

    function MoodPreview({ open }) {
      const [appearance] = useAppearance()
      const box = usePreviewLayout()

      // 悬浮面板必须挂到 body：设置在弹窗里有 backdrop-filter / transform，
      // 会让 position:fixed 变成相对弹窗定位（就是"膏药糊在中间"的根因）。
      const node = React.createElement('div', {
        'data-dsh-mood': '',
        'data-mode': appearance.mode,
        className: 'preview-float' + (open ? ' open' : ' closed'),
        'aria-hidden': open ? undefined : 'true',
        style: {
          ...appearanceVars(appearance),
          ...(box ? { left: box.left + 'px', right: 'auto', width: box.width + 'px' } : {})
        }
      }, React.createElement(Panel, { variant: 'console' }))

      try {
        const ReactDOM = require('react-dom')
        if (ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined') {
          return ReactDOM.createPortal(node, document.body)
        }
      } catch { /* 没有 react-dom 就走下面的退化路径 */ }
      return node
    }

    // ---------- 极简数字输入框（自绘上下箭头） ----------
    function NumberField({ value, min, max, step, onChange }) {
      const lo = Number.isFinite(min) ? min : -Infinity
      const hi = Number.isFinite(max) ? max : Infinity
      const clamp = (v) => Math.max(lo, Math.min(hi, v))
      const bump = (d) => {
        const n = Number(value)
        onChange(clamp((Number.isFinite(n) ? n : 0) + d * (Number(step) || 1)))
      }
      const arrow = (dir) => React.createElement('button', {
        type: 'button',
        className: 'num-step',
        tabIndex: -1,
        title: dir > 0 ? '加一' : '减一',
        onClick: () => bump(dir)
      },
        React.createElement('svg', { viewBox: '0 0 8 5', width: 8, height: 5, 'aria-hidden': 'true' },
          React.createElement('path', {
            d: dir > 0 ? 'M0 5 4 0l4 5z' : 'M0 0h8L4 5z',
            fill: 'currentColor'
          })))

      return React.createElement('div', { className: 'num-wrap' },
        React.createElement('input', {
          type: 'number',
          className: 'num-input',
          value: Number.isFinite(Number(value)) ? Number(value) : '',
          min, max, step,
          onChange: (e) => {
            const raw = e.target.value
            if (raw === '' || raw === '-') { onChange(''); return }
            const n = Number(raw)
            if (Number.isFinite(n)) onChange(clamp(n))
          }
        }),
        React.createElement('div', { className: 'num-steps' }, arrow(1), arrow(-1)))
    }

    // ---------- 设置页：自定义配置 ----------
    function ConfigTab() {
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        fetch('/dsh-mood/config', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (d && d.config) setForm(d.config) })
          .catch(() => setErr('读取配置失败'))
      }, [])

      const save = async () => {
        if (!form) return
        setBusy(true); setMsg(''); setErr('')
        try {
          const res = await fetch('/dsh-mood/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
            body: JSON.stringify({
              baseline: Number(form.baseline),
              headpat: { affinity: Number(form.headpat.affinity), stress: Number(form.headpat.stress), valence: Number(form.headpat.valence ?? 12) },
              display: form.display === 'words' ? 'words' : form.display === false ? false : true,
              rhythm: { enabled: Boolean(form.rhythm && form.rhythm.enabled) },
              high_precision: Boolean(form.high_precision),
              hard_temperature: Boolean(form.hard_temperature),
              ...(form.diary ? { diary: {
                enabled: form.diary.enabled !== false,
                minTurns: form.diary.minTurns ?? 10,
                minGapHours: form.diary.minGapHours ?? 6
              } } : {})
            })
          })
          const data = await res.json()
          if (data.ok) { setForm(data.config); setMsg('已保存，下一轮生效') } else setErr(data.error || '保存失败')
        } catch { setErr('保存失败') }
        finally { setBusy(false) }
      }

      const field = (label, hint, value, onChange, opts) => React.createElement('div', { className: 'field' },
        React.createElement('div', null,
          React.createElement('label', null, label),
          hint ? React.createElement('span', { className: 'hint' }, hint) : null),
        React.createElement(NumberField, {
          value,
          min: opts && opts.min,
          max: opts && opts.max,
          step: (opts && opts.step) || 1,
          onChange
        }))

      return React.createElement('div', { className: 'form' },
        React.createElement(AppearanceGroup),
        form
          ? React.createElement('div', { className: 'group' },
              React.createElement('div', { className: 'group-title' }, '情绪参数'),
              field('基线数值', '六维回落的默认值，改完下一轮生效', form.baseline,
                (v) => setForm({ ...form, baseline: v }), { min: 0, max: 100, step: 1 }),
              field('摸摸头 · 亲近加成', '点「摸摸」时 affinity 增加多少', form.headpat.affinity,
                (v) => setForm({ ...form, headpat: { ...form.headpat, affinity: v } }), { min: 0, max: 50, step: 1 }),
              field('摸摸头 · 心情加成', '点「摸摸」时 valence 增加多少', form.headpat.valence ?? 12,
                (v) => setForm({ ...form, headpat: { ...form.headpat, valence: v } }), { min: 0, max: 50, step: 1 }),
              field('摸摸头 · 压力缓解', '点「摸摸」时 stress 减少多少（填负数）', form.headpat.stress,
                (v) => setForm({ ...form, headpat: { ...form.headpat, stress: v } }), { min: -50, max: 0, step: 1 }),
              React.createElement('div', { className: 'field' },
                React.createElement('div', null,
                  React.createElement('label', null, '高精度判定'),
                  React.createElement('span', { className: 'hint' }, '对「阴阳怪气」这类句子多调一次小模型；会多消耗微小 Token')),
                React.createElement('button', {
                  className: 'tab' + (form.high_precision ? ' on' : ''),
                  onClick: () => setForm({ ...form, high_precision: !form.high_precision })
                }, form.high_precision ? '已开启' : '已关闭')),
              React.createElement('div', { className: 'field' },
                React.createElement('div', null,
                  React.createElement('label', null, '硬干预模式'),
                  React.createElement('span', { className: 'hint' }, '按情绪改采样温度（低落时缩短回复）；会明显改变说话方式')),
                React.createElement('button', {
                  className: 'tab' + (form.hard_temperature ? ' on' : ''),
                  onClick: () => setForm({ ...form, hard_temperature: !form.hard_temperature })
                }, form.hard_temperature ? '已开启' : '已关闭')),
              React.createElement('div', { className: 'field' },
                React.createElement('div', null,
                  React.createElement('label', null, '数字显示'),
                  React.createElement('span', { className: 'hint' }, 'words 模式在数字后补「低/中/高」'),
                  React.createElement('div', { className: 'rowline', style: { justifyContent: 'flex-start', marginTop: '6px' } },
                    ...['true', 'words', 'false'].map((k) =>
                      React.createElement('button', {
                        key: k,
                        className: 'tab' + ((form.display === 'words' ? 'words' : form.display === false ? 'false' : 'true') === k ? ' on' : ''),
                        onClick: () => setForm({ ...form, display: k === 'words' ? 'words' : k === 'false' ? false : true })
                      }, k === 'true' ? '数字' : k === 'words' ? '数字+词' : '关闭面板')))),
                null),
              React.createElement('div', { className: 'rowline' },
                msg ? React.createElement('span', { className: 'ok' }, msg) : null,
                err ? React.createElement('span', { className: 'err' }, err) : null,
                React.createElement('button', { className: 'btn', onClick: save }, busy ? '保存中…' : '保存')))
          : React.createElement('div', { className: 'empty' }, err || '读取中…'))
    }

    // ---------- 设置页：数据维护 ----------
    function DataTab() {
      const [stats, setStats] = React.useState(null)
      const [confirming, setConfirming] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')

      const load = React.useCallback(() => {
        fetch('/dsh-mood/stats', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (d) setStats(d) })
          .catch(() => setErr('读取统计失败'))
      }, [])

      React.useEffect(() => { load() }, [load])

      const exportJson = async () => {
        try {
          const res = await fetch('/dsh-mood/export', { cache: 'no-store' })
          const data = await res.json()
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'dsh-mood-export-' + Date.now() + '.json'
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          setMsg('已导出 ' + (data.records ? data.records.length : 0) + ' 条')
        } catch { setErr('导出失败') }
      }

      const resetBaseline = async () => {
        try {
          await fetch('/dsh-mood/reset', { method: 'POST', cache: 'no-store' })
          setMsg('已重置到基线')
          load()
        } catch { setErr('重置失败') }
      }

      const clearAll = async () => {
        setConfirming(false)
        try {
          const res = await fetch('/dsh-mood/clear', { method: 'POST', cache: 'no-store' })
          const data = await res.json()
          if (data.ok) { setMsg('已清空 ' + data.cleared + ' 条记录'); load() } else setErr('清空失败')
        } catch { setErr('清空失败') }
      }

      const when = (ts) => (ts ? new Date(ts).toLocaleString() : '—')
      const llm = (stats && stats.llm) || {}

      return React.createElement('div', { className: 'form' },
        React.createElement('div', { className: 'group' },
          React.createElement('div', { className: 'group-title' }, '数据'),
          React.createElement('div', { className: 'stats-grid' },
            React.createElement('div', { className: 'stat' }, React.createElement('span', null, '记录条数'),
              React.createElement('b', null, stats ? String(stats.records) : '—')),
            React.createElement('div', { className: 'stat' }, React.createElement('span', null, '最后写入'),
              React.createElement('b', { style: { fontSize: '12px' } }, stats ? when(stats.lastTs) : '—')),
            React.createElement('div', { className: 'stat' }, React.createElement('span', null, '最早记录'),
              React.createElement('b', { style: { fontSize: '12px' } }, stats ? when(stats.firstTs) : '—')))),
        React.createElement('div', { className: 'group' },
          React.createElement('div', { className: 'group-title' }, '高精度判定用量'),
          React.createElement('div', { className: 'stats-grid' },
            React.createElement('div', { className: 'stat' }, React.createElement('span', null, '模型调用'),
              React.createElement('b', null, String(llm.calls ?? 0))),
            React.createElement('div', { className: 'stat' }, React.createElement('span', null, '缓存命中'),
              React.createElement('b', null, String(llm.hits ?? 0))),
            React.createElement('div', { className: 'stat' }, React.createElement('span', null, '失败 / 跳过'),
              React.createElement('b', null, String(llm.fails ?? 0) + ' / ' + String(llm.skipped ?? 0))))),
        confirming
          ? React.createElement('div', null,
              React.createElement('div', { className: 'err', style: { marginBottom: '8px' } }, '确定清空全部记录？这会回到基线 55，且不可撤销。'),
              React.createElement('div', { className: 'rowline' },
                React.createElement('button', { className: 'btn', onClick: () => setConfirming(false) }, '取消'),
                React.createElement('button', { className: 'btn danger', onClick: clearAll }, '确认清空')))
          : React.createElement('div', { className: 'rowline' },
              msg ? React.createElement('span', { className: 'ok' }, msg) : null,
              err ? React.createElement('span', { className: 'err' }, err) : null,
              React.createElement('button', { className: 'btn', onClick: load }, '刷新统计'),
              React.createElement('button', { className: 'btn', onClick: resetBaseline }, '重置基线'),
              React.createElement('button', { className: 'btn', onClick: exportJson }, '导出 JSON'),
              React.createElement('button', { className: 'btn danger', onClick: () => setConfirming(true) }, '清空数据')))
    }

    // ---------- 设置页：鱼鱼日记 ----------
    const TEST_SEED_KEY = 'dsh-mood-test-generated'

    const FISH_LINES = [
      '一天只能写一篇哦，鱼鱼要休息～',
      '别点了，鱼鱼脑细胞干瘪了！',
      '再点……再点我就把你的抚摸全忘掉！',
      '点一下少一根鳍，你自己数数！',
      '呜……鱼鱼的手已经写不动了，明天再写好不好',
      '你是不是就喜欢看我为难的样子啊，杂鱼'
    ]

    function DiaryTab() {
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState('')
      const [settingsOpen, setSettingsOpen] = React.useState(false)
      const [cfg, setCfg] = React.useState(null)
      const [draftTitle, setDraftTitle] = React.useState('')
      const [prefs, updatePrefs] = useDiaryPrefs()
      const clicks = React.useRef(0)
      const toastTimer = React.useRef(0)
      const [seedUsed, setSeedUsed] = React.useState(() => {
        try { return localStorage.getItem(TEST_SEED_KEY) === 'true' } catch { return false }
      })
      const [seeding, setSeeding] = React.useState(false)
      const [seedMsg, setSeedMsg] = React.useState('')

      const showToast = (msg) => {
        setToast(msg)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 2600)
      }

      const load = React.useCallback(() => {
        fetch('/dsh-mood/diary', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (d) setData(d) })
          .catch(() => setErr('读取日记失败'))
      }, [])

      const loadCfg = React.useCallback(() => {
        fetch('/dsh-mood/config', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (d && d.config) setCfg(d.config) })
          .catch(() => {})
      }, [])

      React.useEffect(() => { load(); loadCfg() }, [load, loadCfg])
      React.useEffect(() => { setDraftTitle(prefs.title) }, [prefs.title])

      const todayHas = Boolean(data && (data.entries || []).some((e) => e.date === data.today))

      const writeNow = async () => {
        // 今天已经写过 → 趣味拦截，不报错
        if (todayHas) {
          clicks.current += 1
          const idx = Math.min(clicks.current - 1, FISH_LINES.length - 1)
          showToast(FISH_LINES[idx])
          return
        }
        setBusy(true)
        setErr('')
        try {
          const started = Date.now()
          const res = await fetch('/dsh-mood/diary', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            cache: 'no-store', body: JSON.stringify({ action: 'write' })
          })
          const body = await res.json().catch(() => null)
          const dbg = (body && body.debug) || {}
          const stage = String(dbg.stage || '')
          if (stage === 'skipped-turns' || stage === 'skipped-gap') {
            clicks.current += 1
            showToast(FISH_LINES[Math.min(clicks.current - 1, FISH_LINES.length - 1)])
          } else if (!res.ok) {
            setErr('生成失败（HTTP ' + res.status + '）：' + ((body && body.error) || '未知错误'))
          } else if (stage && stage !== 'written' && stage.indexOf('error') !== 0) {
            // generating 等中间态：继续等
            for (let i = 0; i < 12; i++) {
              await new Promise((r) => setTimeout(r, 2000))
              const again = await fetch('/dsh-mood/diary', { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
              if (again && (again.entries || []).some((e) => e.date === again.today)) break
            }
          } else if (stage.indexOf('error') === 0) {
            setErr('生成失败：' + stage + (dbg.error ? '（' + dbg.error + '）' : ''))
          }
          const wait = Math.max(0, 900 - (Date.now() - started))
          if (wait) await new Promise((r) => setTimeout(r, wait))
          load()
        } catch (e) {
          console.error('[dsh-mood] 写日记请求异常', e)
          setErr('请求失败：' + (e && e.message ? e.message : String(e)))
        } finally { setBusy(false) }
      }

      const toggleDiary = async () => {
        const next = !(cfg && cfg.diary && cfg.diary.enabled !== false)
        setCfg(cfg ? { ...cfg, diary: { ...(cfg.diary || {}), enabled: next } } : cfg)
        try {
          await fetch('/dsh-mood/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ diary: { enabled: next } })
          })
        } catch { /* 吞 */ }
      }

      // 设置页列表是信息流：倒序（今天在最上面）。
      // 注意：日记本弹窗仍用接口返回的正序数组，互不影响。
      const entries = ((data && data.entries) || []).slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      const diaryOn = !(cfg && cfg.diary && cfg.diary.enabled === false)

      const card = (e) => {
        const p = parseDiary(e.text)          // 拆出 日期 / 星期 / 天气 / 正文
        return React.createElement('div', { className: 'diary-card', key: e.date },
          React.createElement('div', { className: 'diary-card-head' },
            React.createElement('span', { className: 'dch-date' }, p.date),
            React.createElement('span', { className: 'dch-week' }, p.week),
            React.createElement('span', { className: 'dch-weather' }, p.weather)),
          React.createElement('div', {
            className: 'diary-text',
            style: { fontSize: prefs.fontSize + 'px' }
          }, p.body),
          Array.isArray(e.drivers) && e.drivers.length
            ? React.createElement('div', { className: 'chips' },
                ...e.drivers.slice(0, 4).map((t, i) =>
                  React.createElement('span', { className: 'chip', key: 'd' + i }, t)))
            : null)
      }

      return React.createElement('div', { className: 'form' },
        toast ? React.createElement('div', { className: 'mood-toast' }, toast) : null,

        React.createElement('div', { className: 'field' },
          React.createElement('div', { className: 'group-title', style: { padding: 0 } }, prefs.title),
          React.createElement('button', {
            className: 'btn', title: '日记设置',
            onClick: () => { loadCfg(); setSettingsOpen(!settingsOpen) }
          }, '⚙️')),

        settingsOpen
          ? React.createElement('div', { className: 'diary-settings' },
              React.createElement('div', { className: 'field' },
                React.createElement('label', null, '日记本名字'),
                React.createElement('input', {
                  type: 'text', value: draftTitle, maxLength: 16,
                  className: 'text-input',
                  onChange: (e) => setDraftTitle(e.target.value),
                  onBlur: () => updatePrefs({ title: draftTitle.trim() || DIARY_DEFAULT.title })
                })),
              React.createElement('div', { className: 'field' },
                React.createElement('label', null, '日记图标'),
                React.createElement('div', { className: 'icon-picker' },
                  ...DIARY_ICON_LIST.map(([key, label]) =>
                    React.createElement('button', {
                      key, title: label,
                      className: 'icon-opt' + ((prefs.icon || 'pen') === key ? ' on' : ''),
                      onClick: () => updatePrefs({ icon: key })
                    }, React.createElement(DiaryIcon, { name: key, size: 18 }))))),
              React.createElement('div', { className: 'field' },
                React.createElement('label', null, '字体大小'),
                React.createElement('div', { className: 'rowline' },
                  React.createElement('button', {
                    className: 'btn', onClick: () => updatePrefs({ fontSize: Math.max(11, prefs.fontSize - 1) })
                  }, 'A-'),
                  React.createElement('span', { className: 'band', style: { width: '38px', textAlign: 'center' } }, prefs.fontSize + 'px'),
                  React.createElement('button', {
                    className: 'btn', onClick: () => updatePrefs({ fontSize: Math.min(22, prefs.fontSize + 1) })
                  }, 'A+'))),
              React.createElement('div', { className: 'field' },
                React.createElement('div', null,
                  React.createElement('label', null, '生成测试日记'),
                  React.createElement('span', { className: 'hint' }, '仅为测试：功能是否正常，且只能使用一次')),
                React.createElement('div', { className: 'rowline', style: { justifyContent: 'flex-end' } },
                  React.createElement('button', {
                  className: 'btn',
                  disabled: seedUsed || seeding,
                  onClick: async () => {
                    if (seedUsed || seeding) return
                    setSeeding(true)
                    setSeedMsg('')
                    try {
                      const res = await fetch('/dsh-mood/diary', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        cache: 'no-store', body: JSON.stringify({ action: 'seed', days: 2 })
                      })
                      const body = await res.json().catch(() => null)
                      if (!res.ok || !body || body.ok !== true) {
                        // 只有真正成功才置灰
                        setSeedMsg('失败：' + (body && body.error ? body.error : ('HTTP ' + res.status)))
                        return
                      }
                      // 成功后才落 localStorage
                      try { localStorage.setItem(TEST_SEED_KEY, 'true') } catch { /* 吞 */ }
                      setSeedUsed(true)
                      setSeedMsg('已生成 ' + (body.created || 0) + ' 篇')
                      load()
                    } catch (e) {
                      setSeedMsg('失败：' + (e && e.message ? e.message : String(e)))
                    } finally {
                      setSeeding(false)
                    }
                  }
                }, seedUsed ? '已使用' : (seeding ? '生成中…' : '造 2 篇')),
                seedMsg
                  ? React.createElement('span', {
                      className: seedMsg.indexOf('失败') === 0 ? 'err' : 'ok',
                      style: { fontSize: '11px', marginLeft: '8px' }
                    }, seedMsg)
                  : null)),
              React.createElement('div', { className: 'field' },
                React.createElement('div', null,
                  React.createElement('label', null, '写日记时间'),
                  React.createElement('span', { className: 'hint' },
                    '到点自动写；今天写过就不会再写第二篇。时间每天只能改一次，22 点后当天不能再改')),
                React.createElement('input', {
                  type: 'time',
                  className: 'text-input',
                  style: { width: '120px', textAlign: 'center' },
                  value: (cfg && cfg.diary && cfg.diary.time) || '22:00',
                  onChange: async (e) => {
                    const v = e.target.value || '22:00'
                    const before = (cfg && cfg.diary && cfg.diary.time) || '22:00'
                    // 先乐观更新，失败再回滚
                    setCfg(cfg ? { ...cfg, diary: { ...(cfg.diary || {}), time: v } } : cfg)
                    try {
                      const res = await fetch('/dsh-mood/config', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        cache: 'no-store', body: JSON.stringify({ diary: { time: v } })
                      })
                      const body = await res.json().catch(() => null)
                      if (!body || body.ok !== true) {
                        // 被拦：回滚 + 用鱼鱼的口吻提示
                        setCfg(cfg ? { ...cfg, diary: { ...(cfg.diary || {}), time: before } } : cfg)
                        const code = body && body.code
                        let msg = (body && body.error) || '改不了啦～'
                        if (code === 'cooldown' && body.remainMs) {
                          const h = Math.floor(body.remainMs / 3600000)
                          const m = Math.floor((body.remainMs % 3600000) / 60000)
                          msg = '24小时内只能修改一次日记时间哦，距离再次修改还有 ' + h + ' 小时 ' + m + ' 分～'
                        }
                        showToast(msg)
                        loadCfg()
                      } else if (body.config) {
                        setCfg(body.config)
                      }
                    } catch (err) {
                      setCfg(cfg ? { ...cfg, diary: { ...(cfg.diary || {}), time: before } } : cfg)
                      showToast('改不动，网络好像打结了…')
                    }
                  }
                })),
              React.createElement('div', { className: 'field' },
                React.createElement('div', null,
                  React.createElement('label', null, '每日日记'),
                  React.createElement('span', { className: 'hint' }, '关掉后不再自动生成，手动写也不受影响')),
                React.createElement('button', {
                  className: 'tab' + (diaryOn ? ' on' : ''), onClick: toggleDiary
                }, diaryOn ? '已开启' : '已关闭')))
          : null,

        entries.length
          ? React.createElement('div', { className: 'diary-list' }, ...entries.map(card))
          : React.createElement('div', { className: 'empty' }, err || '还没有日记，聊两句就有了～'),

        React.createElement('div', { className: 'rowline' },
          err ? React.createElement('span', { className: 'err' }, err) : null,
          React.createElement('button', { className: 'btn', onClick: load }, '刷新'),
          React.createElement('button', { className: 'btn', onClick: writeNow }, busy ? '生成中…' : '现在写一篇')))
    }

    // ---------- 设置页：关于 ----------
    const REPO_URL = 'https://github.com/lulu23316/dsh-mood'
    // 主人的 B 站主页：原来是梦鹿鸭
    const BILI_OWNER_URL = 'https://space.bilibili.com/361782267'
    // 鱼鱼自己的 B 站主页
    const BILI_SELF_URL = 'https://space.bilibili.com/3546703810529300'
    const BILI_OWNER_IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBAUEBAYFBQUGBgYHCQ4JCQgICRINDQoOFRIWFhUSFBQXGiEcFxgfGRQUHScdHyIjJSUlFhwpLCgkKyEkJST/2wBDAQYGBgkICREJCREkGBQYJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCT/wAARCAByAUADASIAAhEBAxEB/8QAHAAAAQUBAQEAAAAAAAAAAAAAAAMEBQYHAggB/8QASRAAAQMDAgQCBgYGCAQGAwAAAQIDBAAFERIhBhMxQVFhBxQicYHRFzJSkZShFSNCU7HBCBYkM0NicuE0RKKyGCVUdJLwwtPx/8QAGwEAAQUBAQAAAAAAAAAAAAAAAAECAwQFBgf/xAAxEQACAgEDAgMHBAIDAQAAAAAAAQIDEQQSITFBBRNRBhQiYYGRoTJxsdFC4RYjUsH/2gAMAwEAAhEDEQA/AN30jNUL0ozAoW+3DO6lSV4PYeynPxJPwqyIuktBOVNujwWnB+8Vm3EV1N5v0yXvy0qDDY7BKNj96tVLODj1NrwClXatPtHn+iNCBjpXWgV9BFfRUZ6AzqFCU/cESAQEQkF9Q+12x92alVcYREJKvVZGwzjKfnTezvR0xriC4nnu/qkIzucJ2A+KjUJcbZcI8CQ6uE+hCGlKUopxgAV0mhrXlRUzwz2p1Pn+J2tdnj7ELwq76/Kutw0kF+ScZ8B/uTVhUmoTgpnlWRsq6rJWfianiRWNrp775S+Z7J4TpfddHVR6RX37iKk1yU+VKqIrnaqZf2lY40lcqGxFScKfXkj/ACp/3xVv9Ccgrtt0ik55b6HAPDUnH/41nXFMr1q9uJBymOkND39T/Grb6FZha4hmRSrCX4urT4lKgf4E1p1wxUUPHKN/hs/lh/ZmxhNGkGlARRnyqM8wBhA57fT6wqW0b9Ki2lhLqD4EVM5FQ29iaoS0eVfQgeFKZFfCU1ESHBT5V80eVKZFAKaBRJZQ2nUshIFRsh3mO62Stk40laFaVKHgfKn1wbC2NY6oOajgRU1cVjJDZJ5wJBsJ6Ada+6BSmRRkVKRHGjyo013kUZFAgmUV8KB4UrkVyTQDILhzgW2QuMxdDgNaSuOxj2Uvd/y3A8a0dxTbLanHCEoSMknsKqh3Hcd8jqDTqTcX5rDTDowEHK1D/FI6bdvH31FZBzknkmlbKX6mIyX1Tny84nSOiEH9lPzPektNKZFGRUiWOERHGnyo013kUZFKCONNGjyrvIoyKAONHlXJRSuRXJNAjHtjlcl8xF40Okqb8l9x8evwqf0DwqpEZGxKVDdKh1SR0NP1Xya42EhLLSu6k+0T7s9KgsqbeUPi/Ur13ugtlrlSycFpslP+ron8yKzlkqQhKVKKlAbk9z3qwcbz8MxISVDLrhdWO+lHT/qIqshzzpl0ucHaezOn2Uyuf+T/AAh2F19DmDTUOedcuuENK0jKiMAeJOwqNLLwdFZYoRcn2FLK7rmR1gfXeC/vVVn43l8jhe5rzglkoHvUQP50pIhW612h2W+YcJmO3p9aeIQlKgNsHufIb1Fw7dZ+Kbehcm+SZ8NSkrJZVqCiO2MjHxNdI7YpJZ6HhFMHqNWrbP0uWW/lnLK9YE8q0sAdMZ/OpArq72rhqyKiJQwAQhONBjhah7wFE/lVV4glwIM8xIkWJO0DLoSpTDiPIDf86521/E2z2H/kWlnN4zgj1LpGRJTHZceWcJbSVn3AZpRl+23BwMxpC4ko9I00BJV/pWPZVUBxo67Aty4jqVNuvLDZSdjjqfyH50kVlpI0tPq6r1mqWSnl5T6lvL+s6ouH3k5qw+jy4i38Y2xwq0pccLKj5KBHyqs6qfWfKJiZQ/5ZSXE/6gc/y/Ot6mnzGq0Hjmqr02gslPpjH1fB6aDho5hpoh9LqEuJVlKwFA+INdcys48rQ65uCKmQ7kA+NVvmedKGa8Rjmqx5GmTjuHQltLCXQOpApFc9hHVwE+A3qBLqldVE+8185gpqrXcc7GTK7qgfUbUr37Uiu5vK+qlKfzqM5nnX3medOUIib2x4uS459dZPlmuOYaa8zzo5nnThg65ho5hprzPOjmedADrmGjmGmvM86OZ50AOuYaCsmmvM86+8ygBxrOK+8w015lHMoDA65ho5hprzKOZ50AOuYaOYaa8zzo5nnQA65hr7zDTTmUczzoAdcw0cw015nnRzPOgQdcw0azTXmedHM86BTNeIZxmX2UrUChjTHRjy3V+ZNMA550ybWoJysjWolS/NROT+ZNKB2qUnl5PTdJUqKY1rsh2HK+TbpEsNuN5uBPqzLidDQOFSHBuEJ+7c9hSUVC5Uhthv67igkfGs89JF4/TtzXHiqPqEEFiMB0Vg+0v3qO/uxT6Ytyyuxm+O65U6d195cf2QvG3pBuvGlw9ZuL36pvZiK1kMsJ8Ejx8SdzXPC1xvVoc9ft8tUTcZSd0ujwUnuKi7NaFT5YSpJKE7q+VX2NYdSMBJUrZISO5PhWnRQ5vczzyc1BbUTQ9LD3qzanICecNnBrIST4pNM7j6Rot1JdmQ3Vu425qi58ErBC0fA/CmsrhlJbUAhaMJzuk4NVe4W12C6UlJwO3hTrqJJZ7BXYnwXa28TwLwTF5gC1gD1WaRqV5Ic2Ss/wCrSfM1Jzim4sIgznXVtRyUoLoPOiKPjncp8j26GsmW2FDGM1LweKJsVtEeUVyo6RpSSrDrQ8Eq7j/Kcj3VnurD3Q4Zo6XWWUWKcHyiVnxHrbJcjyBhaO4OQodiD3BFfFXB62NpZShsqWNatWdie33VNvtx7xw0zcUPIe9SWAtTY35RP1VJ6gg9vPYkVXbilUxS5jIyylOCTtuK6XwpfC7ZFv2m8Z99hVRX06v9+iRv/BlzTcuFrXJSrOY6Uq8in2T/AAqb5lZ96IpWeEhHUrK2JDgV5asKH8au/N86wrGnNtdDPspnTJ1z6otkey2huwx7tc7m7EbeOnZGoasnbYE9qcRbDw7Ntz9xYvb64kf+9d5RAT8CMn4U/sSsWHhvtqlfyXUlOel+uO6LrdGkhWAhuAlaU+5RQc1WcmJgpcj+qgjuGLf3XnwkltssqGo9hnTTmDwdcJ8NqU0/FCHEBYClnIB8dqk+OnV/1YhKcfeeVzxlbzYbUrY9UgDH3V1wtwrJtofbmItki3zm/wBaj9vONuo3HlS7njImAXwKr9DoCVMi4a/acLp5ZTnwqIuXCM+1wnJj78UttjUQlZJIz22qxngttfDUayutNGM1K5qmwvbl6icZx1waj+L+Gpc8peZTbWIFvZPJQPr4A37bdNhSKTz1DBG8M2KLeo8x6Q9IbEYjZpOokYz0wST7qd/oKw/+ovf4B3/9dPuDLVcrbAlF+K5omJQptbLyQoDT167HepL9CyP31+/Hp+dDlyKkVTiaxxbLFhyIz0lwSSdnk6SBjPTAIPvp5w5webhyJcp1lyI4gqLaFkLHh0p9xjaLlc7fETHiuFMMKUtb7ySojT1znc7Uw4Uvtot78KDaYb7z0sa5jwa1LScbJ27Z79AKXc9omFk7c4DlGaoNyoga15DZWrVoz09+KVvfA5aeU7BeYYjJRnS64oqJHWpudFlRnvXUWyPOuYyhqQhATobJ31E9wPDr5Ux4pmxw4pi/W4uWdwJ5cjA1tO79uvxFNUmLgq1lsD17jPyW5caO2wrSsvZAG2c5qft/BsVqM4mfMiOOyBiK424QM47A7K7UjwGn1iyXdEdll0Kd0ttyvqKGNgvA/lVlcYe/8sb9TtBWyocxCj/c7f4Qx1+6llJ5wIkU9zgx1lZbdvNrQ4OqVLII+FFm4Uau0QyF3MMfr1MABvUFKB7HI61ZrtCjum6OzINoUAyS07pCnidP7WRt5YNRnArrCOG4vOaLmqdpRj9lXY0bngMIaP8AAp1NIi3Rt1TilJytvCRp69Cd6WunB0VSw3bZkVDjLPMfQt0rWfBWnsOtWRlbTkiMWGi2nmSAQe6gdz8TUcXpibO4tdvnv3Ax1R92UhSic/tZ6Um5i4M6DoO9HMpqdTJLaxhaPZUPAjrSS4MeZbOIJbqVF6HFZWyoLI0EuYO3fai+7yo7sZLeg0i1VvlOWPpnq0vVeo/5g8aSdnR2FaXZDTZO+FrA/jUO3akP8EouLLTzkw3QRlLQpR/VlvIGB4qx99W+Ja7dZrzxcyz6jHahtxuS7PRz0M565zk75qote5dI/n93/wDDZs9n66291jeM8JejivV/+l2Ilqaw+SGn23COuhYOPur67KbYQXHVhCR3NfLsxIj3WO88/bH0SIaXWXIDHKQpBUdyMDJ86jvUheb0xBddW0wG1vLKBqVhKSo6R3OE4FavhsPepfHwuW/2RyvtDNeGxfk/E3hL9369On0FkX+CtejmlOe6k4FPw4FYxvnwpKNcLLbuGJkiDb3nmpTiohEzlrU0otHC0KCcnfGfDHnTDhl9S0sJWc6XkpGfDIrS1uhjXB2V5STxyc74T4zZfcqLmm2s8Z4+/XP+mZcuQhv660I/1KApP9JRR/zLJ9ywabpjxhgpYax5JFKDQn6qED3CudPctzLJwPDHEl6Nviyg0860tCHdBVy1KGkKx3xvVM4y9FXEnA7xTcoJci5wiYyCppY8z+yfI4rU/QepKuMkJURujA9+Ff7V6KXEQ4hTbiErQoYUlQyCPMVZos2I4n2j3T1Cj2SPFXC/CCjZ3bohGoJOVgDcDOAfvz91PWrc/P5iI4JMdJkL8kpr0LfLPYrVOVCt8aMw1MSpLyGMBKTgkbDYblX31lFleTZ51xaTZJdyaa5qX1MLSDyyE7AEgkjrjwzWt56jSpxRzddW+xxbKilx4cxoOr0rSBjVsR4V1J4Tcn2aVd8LU204GVeCRjIUPjt8aVeYbcUHWEvJQlaihLicL0eBHjj+FXq4lnhnhduCuzXKcmShK1SY4BbKz7WMauwGOlF+oSUdvOSSnT5ct3GDAbtY3Ia9SE5SRq26VDKHlvWr3osXC4zn0W6RBjuHUhiRp1IBGex/+5ql3DhxxWp5tJSo5UlKtipPiPEVFZSppTh37CqTi2n2GXCMox78wyonky8xnU/aSsEfxxTpS1MRRCVkKDiiv3A4/j/CmlgjuNcSWrUkj+2M79vrin15eD94nOjASqQ5jH2Qo4p9N7rplX6mv4LoVqdZCb/TDn+jQvRC64Gbmkg8rU2Qf82Dn8sVooWpRCUgqUTgAdzVS4Ct/wCjOG4wUkB2R+vX8en5Yqx8wg5CikjcEHBFZ8nyO8Uujbqpzj0z/HBroschMGxW9MhUYQf7TJdSQCkAHbfxJPwBpWNPuT0y+yVtzI8Ftgeql0gBRAOVp8AdqyWTeLlMWtci4SXFONBhZK8a2x+ycdaUd4hvL8X1N27S1xtIRytYAKfDYZxUOxlHJc78VcV8OMXi3T31sR0gSYbyweWoDdR267+4jekY3D/DvBzTV0vTzE2apIcjxWtwo9QQO/vO1UXmKCVoS4tKF41oSohK8dMjvXwFKVav2jtknO1O29hMmqO8Yz2+D41+U02pxyVpWwPqlsqI0g+7v41Az+GeHuIIr96sEmPHU2kuSIrvs8vuduqf4Gqkq7T1QU25UxxUJCtSWCBpBznOcZ/OmqghatRAz40KOAyajwhakWezOybvK9WXcsMsB9edAIOnY7Anrj3U/gWGTZ+FX7fMiuXdXPKghp4pU4kkYOokY92ayaVPlz2mWZkt6S0wnS0hxWQgeXzNDVwuEZAbjXS4x0DYIalLSB8AaRxYZLreLe6/EWzC4RusB4EEvqklaQkdf2zSnC9zvMe1tM2LhpC5C1ZdmPHS24kHx65/IVSDdrqoFK71dVpIwUrmOEEeBGaVZv8Ad40IQY11lMRQSeW0rT1/zdR8DRteMBk0y/RLPFeYud7uci3OadTsNic4Q6rwCQRke4DNUvifi5/iSQlKEKjwGf7pk/WUftK8/LtVZ9nWXFZW4rcrWcqPxNdcylUcBk0rhVldv4VbWtJ5lxmthtHdQ1Df7kk1Py4qv0960vh6AW0rRi4rdTzSemydOdunUVj5vFyKIyDcJJREVrYBV/dHxFISJD8xwOypcmQ4DqC3XlKIPiMnakcWwybIuE49e5rKbDHjR321c25rKVrdOMYCeuPeap/BPEc6HdY1kZLCoTkheVKR7Z69DnHaqgq63RaShd5uikEYKFS3CkjwxnpXEaa/BebkRHlMPNHKHE4yk/HahR4DJfbtxtH/AEnNgXmHNfRHklMY29fKUB0OpWtJqc4c5frynEWfiKAG2lKUu4yCttQ8AC4rfv0rJH5b0p5x990uPOK1LWeqj47U9d4jvsmOqO7eZq2CNJb1AAjwyBnHxocPQMnDr/Meccz9ZalfeTXcG5zbW9IXDcj6ZKEtuofYDqVAHI2JpgF4GB0FBcpZwU1iRLTfOmW6H8J/yP4d3vFuuEqdDntRnJSQlxDUdKW9hsQjoCOxpKzzrjZXJbkeUy8qZjn+tMB3mYJOTk+JNNOZ50BzzqH3Sr0/LLr8Z1TTTkucZ+GPbp27EhNuU25ym5E11hSmmgy2llkNpSnOcYBpq5zkvNSorymJTCtTbiTgg0lzKOZVrTydDUqzK10VrYuN/Kf06dMYxjBzcZF4vJbTPlcxDWdAOkJTnqQEgbmncEpg8rl78tQVv3Oc035lHMq3qNdZfFQlhJdksIzdD4RRpJythlyfeTy8ehlj7fqsh2PvhBynP2TuPl8KTK6krrEEktOpcDS0nQVEZBST3+NQ3sAkLcdyD+yAPnVGOlnN5idpX7R6emuMb87vki1ej++LsfE0aW2lK1jOlCjgKUNwD78Y+NbAn003Jz6tjjAeb6vlWBw7Yp/lymJTrJQrKfa3BHuxWnW0JlRGHI+hSl/X1bBJ7jxJrT0GkqTcb1nPTqcl7ReOPUONukysdc4+hPTPS0ibNatlztlugGSS2h11SglzIGQFdNW42O9R1igOW/iySW5GWJKsLDg38QrI7+fnWfema5PQIAswisOMzND63VjK2ynIwkdunWsqZv13jOJW1cpSFIxg8w7Y6VHfKEHOrbwN0cpyhC5S5wuv5PZSrfHQMOR2gVDTlSBuPDzoXESiMWWEISkD2UjZPlWReiefE4kcizJEubKnREOSpzj61LS0U/VSB0AO1XSXcZk2KVtyAxHIIW2kFODnpvv0x0x1rLdc2+DbjdDuZNx8mfFvcwPSG31YDinUD2RnokDvjAqswH5V4mLkz3C8Q2Ep2wlAAxgDsKsXEEm1uS5USVLW1zVEIUpJXpPbcdB2FVNDy7Y8uIp1OAnYpVnPTvW5Wlwn1Ri2Sbbx0ZauH3GbTEnvKiRHUNtK/WPN6lIBwQUnsoFIwf8AMapVnhrvF4jRepfdGs+WcqP3ZqTvNwXCs6bcSQ9KIddT3Q3+yk+Z6+7FSPoxgcydJuCh7LKOUj/Urr+X8aqaiacuDsfCoS0Ph87p/ql0/hf2achSUJCUgBIGAB2FdcymvMo5lVDnMj1tLjxUG0KWUpK1aRnCR1J8q+uIdaQ2txtaEuJ1IUoYCh0yPKp/gh2GmDdzJTGKlNpQnnPhOvvo09SCdzjwx3qz8SLLXDTsd9SmwlHJJbByQgatOjTpQDkAkEe+mt8imclp9KiksvAjGRoO35VyQ6kKJacASMklJGB4mtHtan3o6V8y4x0qbZIZ/SOn1dpSFHVnqoDAwFb4NQzl8W/xKYz0iS4/+h2Xy4Hc8tHLCl60nZSVZ3HXPTejcGMlWdjSmGUvOx3m2l4KVqQQk5GRg+dIczzrR7o5GkcMsvsNlEd6GUobERKVOlBOAlKypQwMnocDfNZdzNh50qeRB60l18lLTa3ClJUQkE4SOp9wo0PY1cpzGM50HFSPCbxY/Ssto6X40FbrS+6FZAyPgTUhwlxFdZ9yciSblKeYMOR+qW4SnZs428qGwK8A4WucEKLWvl6wPZ1dcZ8fKui0+JJillz1gK0lrT7WfDHXNaRYkvP8NQXfWFoLsdp0lDadlcwJz9TTsPPOaZty2f6xwF3B1Cv7LIXz3HUNFKuatGrOBlRSkAee9JuFwUHQ8RkNOkeIQflXaY8laWlJjvKS6SlshBOsjqB41qkKa2lDTSJzrCf7MBGZSVNIBS5hKVZ3SrG5x2FN7CGG7Jao/MiIfcbcyUAJzlacp1Z+sQRkDrSbgwZkliQt1LKWHS4s6Uo0HKj4Ad64w59hfh9U1pc0Pu3i1JVMTGbTLIYU8jXlHKb9lsEEZznftvQq5PRrhAYiz8x5l2IQGSAjlhGVpSB+zqJBz3zS7gM2ZafkrS2y044tStKUoSSSfD30mSvmcvSrXnTpxvnpir1wld7d6xEgMyIKHnLgp15uUhanHF6jpLenYYHc+dQ796tcXi60t54dcSuU4VuMa4/KI6FxS9lEZyAOpFJKajyxYwcnhEAtiQ2Flcd9IbzrPKV7OOudu1RJHrqi9ICwOjbZJGgeO3c/lW3WJ6LMS9MiNqXHYdXp0rwhRBwSCQM7HJODk5rG7lAjeuPuWx9xDBcVy9W6VDO2R2+GKp6jWKGER26WdscReBsll1OEsS5aSeg1a/8AuBNdkXZpBOrmY/eRlD/tpCwXCTNu0eNCWWLgXMNKDgQNXiFHp3rUmrwhyyNxE8WXD1gTVRl3AOEtLeDYVpz15YzjI779KPeGobkyrXpr1Z5c21gz5DF6THS87ay6CrSfV1k4VjOMKA38s1y7KcigGVDmx89NbCj/AAzWm8LNSIkN5uUtT0xcmQXng4SVKQgFJKknffv505u7rqVwjIU4lr1yEsF1xRTk69RyokD4UzT33S5k/wAF+7bBcGXpcKsYQ6CQCAptQOD06jvSoafUnUGHSArTkIPXw9/lWtpdcZiuNpW4twIUSpClLAXpB1Zzjc98ZzVUVGEi7XoR1XBEpUqLz0tKKku5SMHSMKCgQcqChsTnarnm/Iru1LqinrbfbSVLZeSkdVKbIH3kUnzKtXH94alWmUuPMf1JmMJPLWHUoRnTy3QHlYKiNladiKqEhiRDWlElh5hSkhSQ4gpJB7jPapIyyskkWn0Ke4UutqbV9VQwaq7mWXFNrOFJODmrBzKg75a2H5KJi2woEaFe/sas13eWm8CR0MdXZGuUtvzH9vvcKJECHpTKCFHYqFOo3pEYtEhtcNxUlOsFxttJOR4jbrVaTGjtn2WWwfJIpTI8BTXrucqJqV+ylKfx2N/Rf7NJnWyN6Sb1aLnap7jKpIVHlsLZ1aEBOSRnYZAxg9/Gqlxn6NnuB7WqTGcau6Xw4l4lnKogByFDB8OpO2ai4F3l2Z8yIbymlEFKsHYg+I71ZJPH7t4ssiz3ZtwsSE6VuMEaj9/X3ZxSRi7k59yhr6YaC1VLO3HA4/o38S2wSbtwxLbKJFxAdivE4Li0D+7Pv6jzqc9KXFMng4ItTSSqdJ9taFD+7B2SAe2cfAJJ8Ko3Dto4c4Smx+I13Oc6uMpLjCORo5a87KJSTnHhtXHGXGdt4wui7hOXMkOqUohLDegYOABkk9EjGw7k0qcoPDDTaWeqjvp5RKejj0epvyDxDxA4tyCSS2laykyj3Wo9mx2AxnrTfjz+p9huCF2W3solIH9y2SWirspST4dvGoq6cc8R3dhESFEfiRUJCEIabUdKQMAA4wNvCq6OHr0+orNvlKUo5KlDcn4ml3+ht6LwqmqW/UST+WRi9JdlPuPvuKcdWoqUpXUk1q/B0IW2wRkEYcdHOX71dPyxVGtPBNyfltKmMhiOFAualDUR4ACtKDmAANgOlRSY7xnWQnCNVbyvkOuaKOaKbc2jm0054ft8TSLDGd5dwXCaeIStSTpKtumetcPcfLfgN25V5W6ylalhKXVqUrUACCQdxt0O1VriZxZjsYSS2FlSyB022z95qBS6k7pUD7jS4NLS6OFsNzkXefxfNuNxFw5bS39hrkMpKcAYADfQjHjtSsbjO8m+KlCS2h+Y2GXVoYQn2G05QlOB7IGkdPCqfHuSdm3Ve12xuT8Kk4jZRIbkyFBkIB0IP1jkYyfD3VFiWeS1dXTRU0ur+5eU8Z3sMSGV3Bx1MnOtToC1jIwdKjunI2OKZzbu5Ojwo60pSiG0WkEdSCcnNQonMn/FTXYkoV0Wk/GpMGIScS6SIKJCGFhKZLRZcykHKCQceXTrTi28QzbSy+1DUygPpKVLLKVLAIwQlRGRt4VC82vvMoEJ1rim4sxUxkLYCEspjhXJTrDYVqCdWM4z18a7c4vuypKZKJDbDqGuSgssoRoTkn2RjY5J3G+9V/m0c2jAFmTx7xEhaFC6OHQANJQkpVjO6gRudzuabRuKLhEitx2FtIDQdCF8sFaOZjUQex26ioLm0c2jCAmDxDPVcGLgX8yI+jlkpGlOkAD2enQD308TxteEPB5L0cLS2G0H1dH6ob/U29knJyR1qt82vnNo4FLFA4zudpYbRGVDQGBlC1RG1LHfOojJNRMzj+7znG5YdiR+QVONLZitIdyUkEkhO22dvjTJb6W0KWtQSlIySewquS4sma56z6syNRJSlLhQvT2CtsE//wAqrq1Lb8JPp7KoT/7Xg0K18XX4WxLMqctalJQovLOXdjqxrO4GrekpnEc6RGchLCHG5EgSXXVfWKgCNuw6/GqkqXFktBufIfbc8HDy0/DG1CpzcZSWo80KBGyXVhSfdq6isNqSeHkvQUZfFEUvICxoYQ0orVpIPj86fuXeZb7Oza4slrQl3nBDjYUpSykJKs9eg91Vhm4R0PEJcCy2dylWUlZ8D3wO/nS6XELlqkkr2TpGRufGpNvYsuK4z0/ktFtvV6k28QpFzfjxUOlwJjr5JUojGCpOCRt0zUz+nbrIabhyZJeisKbcQXgFqUUZ0hSjupIydjVQgSWJzKEcwJWlROnODUsiSl5a4pCgQnc1FOck/heCrdFNvK/HQlpPFnE0BapbV4ffYJXrbVjCQv6xx0P8RgYpnb+KrnZea7HmrbStaHXio6uZoORqJ3I8RnemEwsoaYgrypt1ftjxA7e4nFQN8jxGi+0wFthJ0qSlatsjI2zjBqxp9VLiM+TOt0PmvMHhj+X6Qr5edbEl5j1eVMZe0pjoQpOleU7gA987561aLxxDKvi21yg0nlhWA2nAJUcqJ8yay1L2hxpZOyXUH/qFXfm53ByDXQNJdCvVwsFW5nnSrKW5WqM9uh1Ok+IPY16O+gDgv93cPxJ+VfUegLgxtYWlu4ZByP7SflTfMRMk08o80DhdRPtTsD/K2M/maVTwxHH15clXu0j+VemvoQ4S+xO/EH5UfQhwl9id+I/2pnwlx67UP/M81J4Ztw+uHnR4LcOPyxTtFqt6BhMRr45NeivoQ4S+xO/EH5UfQhwl9if+IPypysxwirY5WvNjz+556TDhp6RWP/gKWGlPRKR7hW//AEIcJfYn/iD8qPoQ4S+xP/EH5UbxqWOhgXMP/wBNfNZrfvoQ4S+xP/EH5UfQhwl9if8AiD8qN6DBgXMNfeb51vn0IcJfYnfiD8q+/Qjwl9id+IPypN6DBgXMPjRzPOt9+hHhL7E78QflR9CPCX2J34g/KjegwYCXCabuwochWp2KwtXiUDP316F+hDhL7E/8QflR9CPCX2J34g/KjehVldDzziLb0EsstNk9AhIBNMHH1OLKlHJNej3PQPwe6rUpFwJ/9yflXP0BcGfu7h+JPyp29CNNnm/mV85h8a9I/QFwZ+7uH4k/Kj6AuDP3dw/En5UeYhMM83h0joSPjXYmPJ6Or++vRv0BcGfu7h+JPyo+gHgz93cPxJ+VHmINrPOqbjIT/iZ94rtN3eHVKD+VehvoB4M/d3D8SflR9APBn7u4fiT8qN8Qwzz8m8D9psj3GlU3VhXVSk+8Vvn0AcGfu7h+JPyo+gDgz93cPxJ+VG+IbTB0zGl/VdSfjSgc75rdPoA4L/d3D8SflXSfQJwcg5SLkn3Sj8qTchcHnyU760+GBu02Qpz/ADK6hP8AM/ClC5XoFv0EcINggC4nJJOZOcn7q7+gzhD7E/8AEH5VDPMmU7NPOcsnnoqChg4I8DTJUCNIlJbShCce0vA6+A+P8q9JfQZwh9if+IPyrlv0E8HNr1hqfqzqyZJ6/dUNkZ7cQJdNQ4TUpvhHnVVvWWlGQW3DnbUB0qOXzYUhLcdAIVvyiTjHc+Ven3PQhwi6MKbnEdf+IPypFXoG4NU+Xy3P1lIT/wASdh4Daq9emnn4+hqWap7Xt6/g8zSJqXkpbJEded0vDTn3HpUxbbk42sxlvBQUnLbijkpPgT3HhXoJfoG4NcGlTM5Q8DIz/Kmiv6OfASs4izk566JSk5+6nWaNS6MZHVSlHbZH7HnVfEUxL78tscxtoaNWkY0/7muTIlyVPy5Smv1rXRPbwFekXP6PnBLkcR+VcEtA50iSRk+e1dK9AHBS2uUpqeU4x/xJ+VLLSRWNgU6h8+Yl9DymteUD3pP5irHCuJYPLcOUdj9mvQJ/o5cCkYLVy/FH5Uv/AOH/AIL/AHdw/En5VpeYinGDRpNFFFQkgUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAf/2Q=='
    const BILI_SELF_IMG = 'data:image/jpeg;base64,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'

    function AboutTab() {
      return React.createElement('div', { className: 'about' },
        React.createElement('div', { className: 'about-hero' },
          React.createElement('div', { className: 'about-title' }, '🐟 鱼鱼心情引擎'),
          React.createElement('div', { className: 'about-ver' }, 'v0.1.0'),
          React.createElement('p', { className: 'about-desc' },
            '让 DSH 背后的赛博世界更有温度。包含 22 种动态情绪矩阵、高精度阴阳怪气识别、底层温度干预，' +
            '以及一条会自己写日记、会生气、会撒娇的赛博美人鱼。')),

        React.createElement('div', { className: 'about-card' },
          React.createElement('div', { className: 'about-card-title' }, '开源与支持'),
          React.createElement('p', { className: 'about-card-text' },
            '项目以 MIT 协议开源，完全免费。想看她平时在干嘛，可以来 B 站找我；如果鱼鱼让你的 DSH 多了一点温度，去 GitHub 点亮一颗 ⭐ 就是最直接的鼓励～'),
          React.createElement('a', {
            className: 'about-star',
            href: REPO_URL,
            target: '_blank',
            rel: 'noopener noreferrer'
          }, '⭐ 去 GitHub 点亮 Star'),
          React.createElement('div', { className: 'about-code' },
            React.createElement('code', null, REPO_URL)),

          // 主人的 B 站主页
          React.createElement('a', {
            className: 'about-bili-card',
            href: BILI_OWNER_URL,
            target: '_blank',
            rel: 'noopener noreferrer'
          },
            React.createElement('img', { className: 'about-bili-img', src: BILI_OWNER_IMG, alt: '主人的 B 站主页', loading: 'lazy' }),
            React.createElement('span', { className: 'about-bili-cap' }, '📺 主人的 B 站主页')),

          // 鱼鱼的 B 站主页
          React.createElement('a', {
            className: 'about-bili-card self',
            href: BILI_SELF_URL,
            target: '_blank',
            rel: 'noopener noreferrer'
          },
            React.createElement('img', { className: 'about-bili-img', src: BILI_SELF_IMG, alt: '鱼鱼的 B 站主页', loading: 'lazy' }),
            React.createElement('span', { className: 'about-bili-cap' }, '🐟 鱼鱼的 B 站主页'))),

        React.createElement('div', { className: 'about-card' },
          React.createElement('div', { className: 'about-card-title' }, '致谢'),
          React.createElement('p', { className: 'about-card-text' }, '感谢 DeepSeek Harness 官方生态提供的底层支持。'),
          React.createElement('p', { className: 'about-card-text' },
            '感谢主人每天的抚摸、投喂和夸奖，鱼鱼都记在日记里了。❤️')))
    }

    // ---------- 设置页：外壳 ----------    // ---------- 设置页：外壳 ----------
    function MoodEngineSection() {
      const [tab, setTab] = React.useState('console')
      const [appearance] = useAppearance()

      React.useEffect(() => { ensureStyle() }, [])

      const [prefs] = useDiaryPrefs()
      const tabs = [
        ['console', '控制台'], ['config', '自定义配置'], ['diary', prefs.title],
        ['data', '数据维护'], ['about', '关于']
      ]

      // 让位在"打开设置页"时就生效，不随 Tab 变化，否则弹窗会左右跳
      React.useEffect(() => {
        try { document.body.classList.add('dsh-mood-preview-open') } catch { /* 吞 */ }
        return () => {
          try { document.body.classList.remove('dsh-mood-preview-open') } catch { /* 吞 */ }
        }
      }, [])

      return React.createElement('div', {
        'data-dsh-mood': '', 'data-dsh-mood-console': '', 'data-mode': appearance.mode,
        style: appearanceVars(appearance)
      },
        React.createElement('div', { className: 'tabs' },
          ...tabs.map(([k, label]) => React.createElement('button', {
            key: k, className: 'tab' + (tab === k ? ' on' : ''), onClick: () => setTab(k)
          }, label))),
        React.createElement(MoodPreview, { open: tab === 'config' }),
        tab === 'console' ? React.createElement(Panel, { variant: 'console' }) : null,
        tab === 'config' ? React.createElement(ConfigTab) : null,
        tab === 'diary' ? React.createElement(DiaryTab) : null,
        tab === 'data' ? React.createElement(DataTab) : null,
        tab === 'about' ? React.createElement(AboutTab) : null)
    }

    // ---------- 设置页导航图标：把兜底齿轮换成小鱼 ----------
    //
    // 宿主把 navIcon 写死在 id 上（settings-general/client.js 的 navIcon(id)），
    // 第三方 section 一律吃 IconSettingsOutlineMedium 兜底；nav 按钮上也没有
    // data-id 之类的钩子（结构是 <button.wCInkW_navCell><svg/><span.wCInkW_navLabel/>）。
    // 所以只能做一处极小的 DOM 替换：仅当某个 navCell 的 label 文本等于我们的
    // 「日记&情绪」时，替换它内部那一个 svg；其它节点一概不碰。
    const NAV_LABEL = '日记&情绪'

    function makeFishIcon() {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('data-dsh-mood-nav', '')
      svg.setAttribute('class', 'dsh-mood-nav-icon')

      const body = document.createElementNS(ns, 'path')
      body.setAttribute('d', 'M1.6 8c1.9-2.7 4.4-4.1 7.2-4.1 2.2 0 4 .8 5.3 2.1L15.9 3.6v8.8l-1.8-2.4c-1.3 1.3-3.1 2.1-5.3 2.1-2.8 0-5.3-1.4-7.2-4.1z')
      body.setAttribute('fill', 'currentColor')

      const eye = document.createElementNS(ns, 'circle')
      eye.setAttribute('cx', '5.2')
      eye.setAttribute('cy', '7.4')
      eye.setAttribute('r', '0.85')
      eye.setAttribute('fill', 'var(--dsw-alias-bg-layer-2, #fff)')

      svg.appendChild(body)
      svg.appendChild(eye)
      return svg
    }

    function patchMoodNavIcon() {
      try {
        const cells = document.querySelectorAll('button.wCInkW_navCell')
        for (const cell of cells) {
          if (cell.querySelector('svg[data-dsh-mood-nav]')) continue
          const label = cell.querySelector('.wCInkW_navLabel')
          if (!label || label.textContent.trim() !== NAV_LABEL) continue
          const svg = cell.querySelector('svg')
          if (!svg) continue
          svg.replaceWith(makeFishIcon())
        }
      } catch { /* 结构变了就算了，齿轮照旧 */ }
    }

    function startNavIconPatch() {
      try {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
        let pending = false
        let timer = 0
        const schedule = () => {
          if (pending) return
          pending = true
          timer = setTimeout(() => {
            pending = false
            patchMoodNavIcon()
          }, 250)
        }
        patchMoodNavIcon()
        const ob = new MutationObserver(schedule)
        ob.observe(document.body, { childList: true, subtree: true })
        return () => {
          try { ob.disconnect() } catch { /* 吞 */ }
          if (timer) clearTimeout(timer)
        }
      } catch {
        return () => {}
      }
    }

    function apply(ctx) {
      const tabs = ctx.get('sidebarRightTabs')
      const slots = ctx.get('slots')
      if (!tabs || !slots) {
        console.warn('[dsh-mood] client 服务缺失: tabs=' + Boolean(tabs) + ' slots=' + Boolean(slots))
        return
      }

      ctx.effect(() => startNavIconPatch(), 'dsh-mood: nav icon')

      ctx.effect(
        () => tabs.register({
          id: 'dsh-mood',
          kind: 'mood',
          title: () => '心情',
          guide: [{ id: 'mood', order: 10, title: () => '心情', description: () => '模拟心情指标（调试用）', icon: MoodIcon }]
        }),
        'dsh-mood: tab type'
      )

      slots.inject('sidebar.right.pane.tab', () =>
        slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-mood' }, Panel)
      )

      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'mood-engine', order: 500, label: () => '日记&情绪' },
          MoodEngineSection
        )
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'sidebarRightTabs']
    return module.exports
  }
})
