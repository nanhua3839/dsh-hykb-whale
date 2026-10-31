/**
 * dsh-hykb-whale —— 客户端半边：DSH「设置」里的 **快爆** section
 *
 * 设计原则（v4，对齐 DSH / Harmony 原生视觉）：
 *   1. 视觉只用平台设计变量（--dsw-alias-*）与原生原语的尺寸：按钮胶囊 28/36、Pill 24、
 *      输入框 32 圆角 8、hint 12/18、tooltip 13/20。不自己造色值。
 *   2. 说明文字一律收进 tooltip。行内只留标签 + ⓘ，界面不再堆小字。
 *   2b. 登录两条路并列成 tab：扫码 / 手动填 Cookie。扫码失败或已有现成登录态时不用绕路。
 *   3. 顶部四张模式卡一次点掉所有开关；卡片序号 1→6 就是上手顺序。
 *   4. 关掉的卡只留一行摘要，不占版面。
 *   5. 没有保存按钮：改哪个就存哪个，去抖 400ms 后整份提交，页头只留一行保存状态。
 *
 * 数据流没变：section ⇄ /dsh-hykb/api/* ⇄ ~/.dsh/hykb-whale.config.json（与 tools/hykb.mjs 同一份）
 * 自动保存同样提交整份配置，未显示的字段不会被抹掉。
 */
window.__ModuleLoader__.load({
  id: "dsh-hykb-whale",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createElement: h, useCallback, useEffect, useState, useRef } = React;

    const API = "/dsh-hykb/api";
    const CSS_TAG = "dsh-hykb-whale/section.css";

    /* 只用平台上真实存在的 token。多写一个不存在的变量名 = 该项样式静默失效。 */
    const CSS = [
      /* ── 容器 ── */
      ".hkw{max-width:720px;container-type:inline-size;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;-webkit-font-smoothing:antialiased}",
      ".hkw *,.hkw *::before,.hkw *::after{box-sizing:border-box}",

      /* ── 页头 ── */
      ".hkw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:2px 0 10px}",
      ".hkw-ht{flex:1;min-width:0}",
      ".hkw-title{margin:0;font-size:15px;line-height:22px;font-weight:600;letter-spacing:.2px}",
      ".hkw-sub{margin:3px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",

      /* ── 状态 pill 行（原生 Pill 规格：h24 r12 12/18）── */
      ".hkw-chips{display:flex;flex-wrap:wrap;gap:6px;padding-bottom:8px}",
      ".hkw-pill{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap}",
      ".hkw-pill>b{font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".hkw-dot{display:inline-block;flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-dimmed)}",
      ".hkw-dot[data-s=ok]{background:var(--dsw-alias-state-success-primary)}",
      ".hkw-dot[data-s=warn]{background:var(--dsw-alias-state-warn-primary)}",
      ".hkw-dot[data-s=bad]{background:var(--dsw-alias-state-error-primary)}",

      /* ── 模式卡 ── */
      ".hkw-modes{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:2px 0 12px}",
      ".hkw-mode{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;transition:background .12s,border-color .12s}",
      ".hkw-mode>b{font-size:12.5px;line-height:18px;font-weight:600}",
      ".hkw-mode>span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".hkw-mode:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".hkw-mode:disabled{cursor:not-allowed;opacity:.5}",
      ".hkw-mode[data-on='1']{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",

      /* ── 卡片 ── */
      ".hkw-card{padding:14px 16px 16px;border:none;border-radius:12px;background:var(--dsw-alias-interactive-bg-active)}",
      ".hkw-chead{display:flex;align-items:center;gap:8px;min-height:24px}",
      ".hkw-no{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;font-weight:600}",
      ".hkw-ct{flex:1;min-width:0}",
      ".hkw-ct>h4{margin:0;font-size:13px;line-height:20px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".hkw-ct>p{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".hkw-cbody{padding:6px 0 0}",
      ".hkw-card[data-off='1']>.hkw-cbody{display:none}",
      ".hkw-badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:9px;font-size:11px;line-height:18px;font-weight:500;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}",
      ".hkw-badge[data-s=ok]{color:var(--dsw-alias-state-success-primary)}",
      ".hkw-badge[data-s=warn]{color:var(--dsw-alias-state-warn-primary)}",

      /* ── 行：左标签右控件 ── */
      ".hkw-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(120px,200px);column-gap:16px;align-items:center;padding:8px 0;min-height:38px}",
      ".hkw-row--block{grid-template-columns:minmax(0,1fr);row-gap:6px;align-items:stretch}",
      ".hkw-l{min-width:0;display:flex;align-items:center;gap:5px;flex-wrap:wrap}",
      ".hkw-lbl{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary)}",
      ".hkw-c{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0}",
      ".hkw-c>*{width:100%}",
      ".hkw-c>.hkw-sw{width:36px}",".hkw-c>.hkw-btn{width:auto}",
      ".hkw-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",

      /* ── tooltip：完全复刻平台 bubble 规格 ── */
      ".hkw-tipwrap,.hkw-tipslot{display:contents}",
      ".hkw-i{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border-radius:50%;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:10px;line-height:1;font-weight:600;cursor:help;user-select:none;vertical-align:middle}",
      ".hkw-i:hover,.hkw-i:focus-visible{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary);outline:none}",
      ".hkw-bubble{position:fixed;z-index:100;width:max-content;max-width:min(320px,50vw);padding:3px 7px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.16)}",
      ".hkw-bubble[data-side=right]{transform:translateY(-50%)}",
      ".hkw-bubble[data-side=bottom]{transform:translateX(-50%)}",
      ".hkw-bubble[data-side=top]{transform:translate(-50%,-100%)}",

      /* ── 输入：原生 input wrapper 规格 h32 r8 ── */
      ".hkw-in{display:block;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);outline:none;transition:border-color .12s}",
      ".hkw-in:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".hkw-in::placeholder{color:var(--dsw-alias-label-dimmed)}",
      ".hkw-in:disabled{opacity:.5;cursor:not-allowed}",
      ".hkw-ta{display:block;width:100%;min-height:68px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-family:inherit;font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);outline:none;resize:vertical;transition:border-color .12s}",
      ".hkw-ta:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".hkw-ta::placeholder{color:var(--dsw-alias-label-dimmed)}",
      ".hkw-ta:disabled{opacity:.5;cursor:not-allowed}",

      /* ── 开关 36x20 ── */
      ".hkw-sw{position:relative;flex:none;width:36px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .16s}",
      ".hkw-sw::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .16s}",
      ".hkw-sw[data-on='1']{background:var(--dsw-alias-state-success-primary)}",
      ".hkw-sw[data-on='1']::after{transform:translateX(16px)}",
      ".hkw-sw:disabled{cursor:not-allowed;opacity:.4}",
      ".hkw-sw:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",

      /* ── 分段切换 ── */
      ".hkw-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover)}",
      ".hkw-seg>button{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:1;height:26px;padding:0 10px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .12s,color .12s}",
      ".hkw-seg>button:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
      ".hkw-seg>button[data-on='1']{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.06)}",
      ".hkw-seg>button:disabled{cursor:not-allowed;opacity:.5}",
      ".hkw-tabs{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:0 0 8px}",
      ".hkw-grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}",

      /* ── 按钮：原生 Button 规格（胶囊）── */
      ".hkw-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none;height:30px;padding:0 14px;border:none;border-radius:15px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background .12s,border-color .12s;white-space:nowrap}",
      ".hkw-btn:disabled{cursor:not-allowed;opacity:.4}",
      ".hkw-btn[data-v=primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}",
      ".hkw-btn[data-v=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
      ".hkw-btn[data-v=outline]{border:1px solid var(--dsw-alias-border-l2)}",
      ".hkw-btn[data-v=outline]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".hkw-btn[data-v=ghost]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".hkw-btn[data-v=ghost]:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}",
      ".hkw-btn[data-sz=sm]{height:26px;padding:0 11px;font-size:12px;line-height:18px;border-radius:13px}",
      ".hkw-link{display:inline-flex;align-items:center;height:26px;padding:0 4px;border:none;background:transparent;color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;border-radius:6px}",
      ".hkw-link:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".hkw-link:disabled{cursor:not-allowed;opacity:.4}",

      /* ── 保存状态行：没有保存按钮，改完就去抖提交 ── */
      ".hkw-saverow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:18px;padding:0 0 8px}",
      ".hkw-err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);white-space:pre-line}",
      ".hkw-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}",

      /* ── 折叠 / 日志 / 二维码 / 页脚 ── */
      ".hkw-more{margin-top:2px}",
      ".hkw-more>summary{display:flex;align-items:center;gap:4px;padding:8px 0 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;cursor:pointer;list-style:none;user-select:none}",
      ".hkw-more>summary::-webkit-details-marker{display:none}",
      ".hkw-more>summary:hover{color:var(--dsw-alias-label-primary)}",
      ".hkw-more>summary::before{content:'▸';font-size:10px;line-height:1;transition:transform .12s}",
      ".hkw-more[open]>summary::before{transform:rotate(90deg)}",
      ".hkw-log{margin:8px 0 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;white-space:pre-wrap;overflow:auto;max-height:260px}",
      ".hkw-qrbox{display:flex;align-items:flex-start;gap:12px;padding:8px 0 4px}",
      ".hkw-qrimg{flex:none;width:112px;height:112px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:#fff}",
      ".hkw-qrph{display:flex;align-items:center;justify-content:center;flex:none;width:112px;height:112px;border:1px dashed var(--dsw-alias-border-l3);border-radius:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
      ".hkw-qrside{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}",
      ".hkw-stack{display:flex;flex-direction:column;gap:6px;width:100%}",
      ".hkw-rowbtns{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}",
      ".hkw-foot{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",

      /* ── 窄屏单列降级 ── */
      "@container (max-width:520px){.hkw-grid4{grid-template-columns:repeat(2,minmax(0,1fr))}.hkw-row{grid-template-columns:minmax(0,1fr);row-gap:5px;align-items:stretch}.hkw-c{justify-content:flex-start}.hkw-modes{grid-template-columns:repeat(2,minmax(0,1fr))}}",
    ].join("");


    /* ───────────────── 提示气泡：界面上的所有说明文字都住在这里 ─────────────────
       复刻平台的 bubble：fixed 定位、13/20、tooltip 底色、pointer-events:none。
       位置在 hover / focus 时才用 getBoundingClientRect 算，纯渲染阶段不读 DOM，
       这样没有浏览器的静态渲染测试也能跑。 */
    function Tip({ text, side, children }) {
      const [pos, setPos] = useState(null);
      const ref = useRef(null);
      const show = useCallback(() => {
        const el = ref.current;
        if (!el || typeof el.getBoundingClientRect !== "function") return;
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 800;
        const want = side || (r.right + 340 <= vw ? "right" : r.bottom + 90 <= vh ? "bottom" : "top");
        if (want === "right") {
          setPos({ side: "right", left: Math.round(r.right + 8) + "px", top: Math.round(Math.min(vh - 20, Math.max(20, r.top + r.height / 2))) + "px" });
          return;
        }
        // 气泡上限 320px，居中摆时两侧各占 160px；夹一下中心点，别让气泡探出视口
        const half = 168;
        const cx = Math.max(half, Math.min(Math.max(half, vw - half), Math.round(r.left + r.width / 2)));
        setPos({ side: want, left: cx + "px", top: Math.round(want === "bottom" ? r.bottom + 6 : r.top - 6) + "px" });
      }, [side]);
      const hide = useCallback(() => setPos(null), []);
      const bare = children == null || (Array.isArray(children) && children.length === 0);
      const props = { ref, onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide };
      if (bare) {
        props.className = "hkw-i";
        props.tabIndex = 0;
        props.role = "img";
        props["aria-label"] = text;
      } else {
        props.className = "hkw-tipslot";
      }
      return h("span", { className: "hkw-tipwrap" },
        h("span", props, bare ? "i" : children),
        pos ? h("span", { className: "hkw-bubble", role: "tooltip", "data-side": pos.side, style: { left: pos.left, top: pos.top } }, text) : null);
    }

    /* ── 字段清单：唯一真相。sec = 属于哪张卡；tier 1 = 默认显示，tier 2 = 收进「高级」
          hint 不再画在行里，全部由 Row 送进 tooltip。 ── */
    const FIELDS = [
      { sec: "ai", path: ["ai", "baseUrl"], label: "接口地址", hint: "OpenAI 兼容的 base URL。\n只支持 http/https", kind: "text", ph: "https://api.deepseek.com/v1" },
      { sec: "ai", path: ["ai", "model"], label: "模型", hint: "填服务商给的模型名，例如 deepseek-chat", kind: "text", ph: "deepseek-chat" },
      { sec: "ai", path: ["ai", "apiKey"], label: "密钥", hint: "存在 ~/.hykb-ai/ai-key，权限 600。\n保存后只显示掩码，永不回显", kind: "password", ph: "sk-…" },
      { sec: "ai", path: ["ai", "temperature"], label: "温度", hint: "0–2，越高越活泼。回帖建议 0.8 左右", kind: "number", tier: 2 },
      { sec: "ai", path: ["ai", "maxTokens"], label: "回复字数上限", hint: "按 token 计。回帖 200–400 就够，写多了反而啰嗦", kind: "number", tier: 2 },

      { sec: "who", path: ["persona", "name"], label: "角色名", hint: "她怎么称呼自己，会出现在回复落款里", kind: "text", ph: "小号" },
      { sec: "who", path: ["persona", "ownerTitle"], label: "她怎么称呼你", hint: "会出现在她写的回复里", kind: "text", ph: "主人" },
      { sec: "who", path: ["persona", "style"], label: "说话风格", hint: "一句话写清口吻和长度，直接影响回帖质量", kind: "text", ph: "像真人回帖，口语，不超过 60 字" },
      { sec: "who", path: ["owner", "uid"], label: "你的 uid（大号）", hint: "填了以后只回你这个号的楼，别人的 @ 一律跳过", kind: "text", tier: 2 },
      { sec: "who", path: ["owner", "name"], label: "你的昵称", hint: "只用于日志，不参与判断", kind: "text", tier: 2 },

      { sec: "reply", path: ["listen", "windows"], label: "时间段", hint: "写成 08:00-24:00；跨零点写 22:00-06:00。\n多个时段用逗号隔开", kind: "windows", tier: 2 },
      { sec: "reply", path: ["listen", "oncePerPerson"], label: "同一个人只回一次", hint: "30 天内同一个人只回一条，防刷屏", kind: "switch", tier: 2 },
      { sec: "reply", path: ["listen", "maxTopicsPerTick"], label: "每轮最多读几帖", hint: "默认 6。列了很多帖时只读前几个，省读额度", kind: "number", tier: 2 },
      { sec: "reply", path: ["listen", "maxRepliesPerTick"], label: "每轮最多回几条", hint: "默认 3。一轮扫到的 @ 不会全回一遍", kind: "number", tier: 2 },

      { sec: "browse", path: ["browse", "intervalSec"], label: "多久刷一轮（秒）", hint: "默认 3600，一小时一轮", kind: "number" },
      { sec: "browse", path: ["browse", "pick"], label: "日报写几帖", hint: "默认 8。写太多 AI 会开始编", kind: "number" },
      { sec: "browse", path: ["browse", "deep"], label: "深读几帖", hint: "前几帖拉楼层压成速读，再合成日报", kind: "number" },
      { sec: "browse", path: ["summary", "maxComments"], label: "深读每帖读几层", hint: "默认 50。几百层的大帖靠它压住读额度", kind: "number", tier: 2 },
      { sec: "browse", path: ["browse", "wake"], label: "刷完叫醒她", hint: "关掉 = 只写日报文件，不在她会话里说话", kind: "switch" },
      { sec: "browse", path: ["browse", "autoReply"], label: "顺手回高分帖", hint: "会真的发出去。只回分数线以上的帖，\n仍受「安全阀」里的写额度与写冷却约束", kind: "switch" },
      { sec: "browse", path: ["browse", "replyMinScore"], label: "回帖分数线", hint: "低于这个分不回，默认 40", kind: "number", tier: 2 },
      { sec: "browse", path: ["browse", "replyMax"], label: "每轮最多回几条", hint: "默认 3", kind: "number", tier: 2 },
      { sec: "browse", path: ["browse", "sections"], label: "扫哪些板块", hint: "留空 = 六个公共讨论区。填板块 ID，逗号分隔", kind: "list", tier: 2 },
      { sec: "browse", path: ["browse", "allDay"], label: "全天刷", hint: "关掉后只在时间段里刷", kind: "switch", tier: 2 },

      { sec: "risk", path: ["risk", "writeGapSec"], label: "两次写之间隔（秒）", hint: "默认 120。太密容易被风控", kind: "number" },
      { sec: "risk", path: ["risk", "writeHourly"], label: "每小时最多写几条", hint: "默认 12", kind: "number" },
      { sec: "risk", path: ["risk", "writeDaily"], label: "每天最多写几条", hint: "默认 30。超过 50 像刷量", kind: "number" },
    ];

    /* ───────────────── 取值 / 写值 / 差异 ───────────────── */

    /** "08:00-24:00, 22:00-06:00" ⇄ [{start,end}] */
    const parseWindows = (text) =>
      String(text || "")
        .split(/[,，\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const m = s.match(/^(\d{1,2}:\d{2})\s*[-~到]\s*(\d{1,2}:\d{2})$/);
          return m ? { start: m[1], end: m[2] } : null;
        })
        .filter(Boolean);
    const parseList = (s) => String(s || "").split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

    const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

    /** 不可变写入：路径上每一层都换新对象。
        自动保存靠引用判断「这份是不是新的」，就地改会让排队中的那份被后续改动污染。 */
    const setPath = (obj, path, value) => {
      if (!path.length) return value;
      const [k, ...rest] = path;
      const src = obj == null || typeof obj !== "object" ? (typeof k === "number" ? [] : {}) : obj;
      const next = Array.isArray(src) ? src.slice() : { ...src };
      next[k] = rest.length ? setPath(src[k], rest, value) : value;
      return next;
    };

    /* ───────────────── 基础件 ───────────────── */

    function Sw({ on, onChange, disabled }) {
      return h("button", {
        type: "button",
        className: "hkw-sw",
        "data-on": on ? 1 : 0,
        role: "switch",
        "aria-checked": !!on,
        disabled,
        onClick: () => onChange(!on),
      });
    }

    /** 行：左标签（+ⓘ），右控件。hint 一律进 tooltip；block=true 时控件换行占满整行 */
    function Row({ label, hint, block, children, side }) {
      const head = h("div", { className: "hkw-l" },
        h("span", { className: "hkw-lbl" }, label),
        hint ? h(Tip, { text: hint, side }) : null);
      if (block) return h("div", { className: "hkw-row hkw-row--block" }, head, children);
      return h("div", { className: "hkw-row" }, head, h("div", { className: "hkw-c" }, children));
    }

    function SwRow({ label, hint, on, onChange, disabled }) {
      return h(Row, { label, hint },
        h(Sw, { on: !!on, onChange, disabled }));
    }

    /** 逗号列表输入：本地保留原文，避免边打字边被切碎 */
    function ListInput({ value, onChange, placeholder, disabled }) {
      const arr = Array.isArray(value) ? value : [];
      const key = arr.join("，");
      const [text, setText] = useState(key);
      useEffect(() => {
        setText((t) => (parseList(t).join("，") === key ? t : key));
      }, [key]);
      return h("input", {
        className: "hkw-in",
        value: text,
        placeholder: placeholder || "逗号分隔",
        disabled,
        onChange: (e) => { setText(e.target.value); onChange(parseList(e.target.value)); },
      });
    }

    function Field({ field, cfg, setCfg, disabled }) {
      const raw = getPath(cfg, field.path);
      const off = disabled || field.readOnly;
      const set = (v) => setCfg((c) => setPath(c, field.path, v));
      let control;
      if (field.kind === "switch") {
        control = h(Sw, { on: !!raw, onChange: set, disabled: off });
      } else if (field.kind === "list") {
        control = h(ListInput, { value: raw, onChange: set, placeholder: field.ph, disabled: off });
      } else if (field.kind === "windows") {
        control = h(ListInput, {
          value: Array.isArray(raw) ? raw.map((w) => w.start + "-" + w.end) : [],
          onChange: (arr) => set(arr.map((s) => {
            const m = String(s).match(/^(\d{1,2}:\d{2})\s*[-~到]\s*(\d{1,2}:\d{2})$/);
            return m ? { start: m[1], end: m[2] } : null;
          }).filter(Boolean)),
          placeholder: "08:00-24:00",
          disabled: off,
        });
      } else if (field.kind === "number") {
        control = h("input", {
          className: "hkw-in", type: "number", value: raw ?? "", disabled: off,
          onChange: (e) => set(e.target.value === "" ? "" : Number(e.target.value)),
        });
      } else {
        control = h("input", {
          className: "hkw-in",
          type: field.kind === "password" ? "password" : "text",
          autoComplete: "off",
          value: raw ?? "",
          placeholder: field.ph || "",
          disabled: off,
          onChange: (e) => set(e.target.value),
        });
      }
      return h(Row, { label: field.label, hint: field.hint }, control);
    }

    /** 一张卡：序号 + 标题 + 一句副标题 + 可选右上开关 + 可选徽标。off=true 时正文不渲染 */
    function Card({ no, title, sub, badge, right, off, children }) {
      return h("section", { className: "hkw-card", "data-off": off ? 1 : 0, "data-n": no ? String(no) : undefined },
        h("div", { className: "hkw-chead" },
          no ? h("div", { className: "hkw-no" }, String(no)) : null,
          h("div", { className: "hkw-ct" },
            h("h4", null, title, badge ? h("span", { className: "hkw-badge", "data-s": badge.s }, badge.t) : null),
            sub ? h("p", null, sub) : null),
          right || null),
        children ? h("div", { className: "hkw-cbody" }, children) : null);
    }

    /** 卡片里的「高级」折叠 */
    function More({ children, label }) {
      return h("details", { className: "hkw-more" },
        h("summary", null, label || "高级"),
        children);
    }

    /* ───────────────── 扫码登录 ───────────────── */

    function QrLogin({ disabled, onAccount, onActiveChange, ck, setCk, onSave, saving, msg }) {
      const [qr, setQr] = useState(null);
      const [phase, setPhase] = useState("");
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);
      const timer = useRef(null);
      const alive = useRef(true);
      // "qr" 扫码 / "cookie" 手动粘贴登录态，两条路随时可切
      const [mode, setMode] = useState("qr");
      // 扫码成功的一次性回执；不放 phase 里，是因为 phase 会被轮询下一次覆盖
      const [ok, setOk] = useState("");

      const clear = useCallback(() => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        if (onActiveChange) onActiveChange(false);
      }, [onActiveChange]);
      useEffect(() => () => { alive.current = false; if (timer.current) clearTimeout(timer.current); }, []);

      const stop = useCallback(() => { clear(); setPhase(""); setQr(null); setOk(""); }, [clear]);

      // 服务端 /auth/qr/poll 只认 POST，回的是 { ok, phase, done, uid, nickname, error }。
      const TEXT = {
        WAIT: "等待扫码",
        SCANNED: "已扫码，在手机上点确认",
        CONFIRMED: "手机已确认，正在向服务端换凭据（几秒）",
        AUTH: "手机已确认，正在向服务端换凭据（几秒）",
        NEED_IDCARD: "这个账号没实名，去网页端补完再扫一次",
        AUTH_FAILED: "确认了但服务端没下发凭据，点「重新获取」再扫一次",
        EXPIRED: "二维码过期了，点「重新获取」",
        CANCELLED: "手机上取消了",
      };

      const poll = useCallback(async () => {
        if (!alive.current) return;
        let terminal = false;
        try {
          const r = await fetch(API + "/auth/qr/poll", { method: "POST" });
          const j = await r.json();
          if (!alive.current) return;
          if (!j.ok) {
            setPhase("");
            setError(j.error || ("查询失败（HTTP " + r.status + "）"));
            terminal = r.status >= 400 && r.status < 500;
          } else if (j.done) {
            // 服务端此时已经把凭据落盘了，这里只做三件事：清掉二维码、给回执、让上层重读配置
            setPhase("");
            setQr(null);
            setError("");
            setOk("✓ 已登录：" + (j.nickname || "（没昵称）") + "（" + (j.uid || "") + "）");
            terminal = true;
            if (onAccount) onAccount({ uid: j.uid || "", nickname: j.nickname || "" });
          } else {
            setPhase(TEXT[j.phase] || "等待扫码");
            if (j.error) setError(j.error);
            if (j.phase === "EXPIRED" || j.phase === "CANCELLED" || j.phase === "NEED_IDCARD" || j.phase === "AUTH_FAILED") terminal = true;
          }
        } catch (e) { setError(String(e.message || e)); }
        if (terminal) { clear(); return; }
        timer.current = setTimeout(poll, 2000);
      }, [onAccount, clear]);

      const start = useCallback(async () => {
        setBusy(true); setError(""); setQr(null); setPhase(""); setOk("");
        if (onActiveChange) onActiveChange(true);
        try {
          const r = await fetch(API + "/auth/qr/start", { method: "POST" });
          const j = await r.json();
          if (!j.ok) { setError(j.error || "取二维码失败"); if (onActiveChange) onActiveChange(false); return; }
          setQr({ image: j.image || "" });
          setPhase("等待扫码");
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(poll, 1500);
        } catch (e) {
          setError(String(e.message || e));
          if (onActiveChange) onActiveChange(false);
        } finally { setBusy(false); }
      }, [poll, onActiveChange]);

      const running = !!qr || !!phase;
      const pick = (k, e) => setCk((cur) => ({ ...cur, [k]: e.target.value }));

      // 手动填的一格；password 只挡肩窥，提交后服务端落盘 600，永不回显
      const field = (k, ph, secret) => h("input", {
        key: k, className: "hkw-in", autoComplete: "off",
        type: secret ? "password" : "text",
        placeholder: ph, value: ck[k] || "",
        disabled: disabled || saving,
        onChange: (e) => pick(k, e),
      });

      return h("div", null,
        h("div", { className: "hkw-tabs" },
          h("div", { className: "hkw-seg" }, [
            h("button", { key: "qr", type: "button", "data-on": mode === "qr" ? 1 : 0, disabled: saving, onClick: () => setMode("qr") }, "扫码登录"),
            h("button", { key: "ck", type: "button", "data-on": mode === "cookie" ? 1 : 0, disabled: saving, onClick: () => { stop(); setMode("cookie"); } }, "手动填 Cookie"),
          ]),
          h(Tip, { text: "两条路等效：扫码走手机确认，手动填是从浏览器复制现成的登录态。\n手动填适合扫码一直失败、或者已经有别的号在浏览器里登着的时候。", side: "bottom" })),

        mode === "qr"
          ? h("div", { className: "hkw-qrbox" },
              qr && qr.image
                ? h("img", { className: "hkw-qrimg", src: qr.image, alt: "好游快爆登录二维码", width: 112, height: 112 })
                : h("div", { className: "hkw-qrph" }, busy ? "生成中…" : "二维码"),
              h("div", { className: "hkw-qrside" },
                ok ? h("div", { className: "hkw-ok" }, ok) : h("div", { className: "hkw-note" }, phase || "用手机上的好游快爆 App 扫这个码"),
                error ? h("div", { className: "hkw-err" }, error) : null,
                h("div", { className: "hkw-rowbtns", style: { justifyContent: "flex-start", paddingTop: "2px" } },
                  h("button", { type: "button", className: "hkw-btn", "data-v": "primary", "data-sz": "sm", onClick: start, disabled: disabled || busy },
                    busy ? "获取中…" : qr ? "重新获取" : "扫码登录"),
                  running ? h("button", { type: "button", className: "hkw-btn", "data-v": "ghost", "data-sz": "sm", onClick: stop, disabled: busy }, "取消") : null)))
          : h("div", null,
              h("div", { className: "hkw-grid4" }, [
                field("uid", "uid（必填）", false),
                field("nickname", "昵称（可空）", false),
                field("Pauth", "Pauth（必填）", true),
                field("Uauth", "Uauth（可空）", true),
              ]),
              h("div", { className: "hkw-rowbtns", style: { justifyContent: "flex-start", paddingTop: "8px" } },
                h("button", { type: "button", className: "hkw-btn", "data-v": "primary", "data-sz": "sm", onClick: onSave, disabled: disabled || saving || !ck.uid || !ck.Pauth },
                  saving ? "写入中…" : "写入凭据"),
                h(Tip, { text: "浏览器 F12 → Application → Cookies → www.3839.com，复制 uid / Pauth / Uauth。\n写入 ~/.hykb-ai，权限 600，页面永不回显。", side: "right" })),
              msg ? h("div", { className: msg.startsWith("✓") ? "hkw-ok" : "hkw-err", style: { paddingTop: "6px" } }, msg) : null));
    }

    /* ───────────────── 四个监听源 ───────────────── */

    const SOURCES = [
      {
        key: "atme", tab: "@ 我通知", noItems: true,
        hint: "直接读消息中心的「@我的」列表。不用填任何 ID，也不用开别的源——别人 @ 她就能回",
      },
      {
        key: "forum", tab: "板块",
        hint: "扫这个板块里的最新帖。板块 ID 可以先点「查板块 ID」看一眼",
        itemsLabel: "板块 ID", itemsHint: "每行一个，可以写「23064 爆友生活区」，标题只是备注", itemsPh: "23064 爆友生活区",
      },
      {
        key: "topic", tab: "帖子",
        hint: "盯住指定帖子的楼层和楼中楼。可以直接粘链接",
        itemsLabel: "帖子", itemsHint: "每行一个，可以写「1000001 帖子备注」", itemsPh: "1000001",
        extra: [
          { path: ["floors"], label: "扫主楼层", hint: "帖子里的每一层" },
          { path: ["comments"], label: "扫楼中楼", hint: "楼层下面的回复" },
        ],
      },
      {
        key: "at", tab: "@ 的规矩",
        hint: "对上面所有源扫到的内容统一判定「算不算叫我」。留空 = 谁 @ 都算，任何板块任何帖子都算",
        itemsLabel: "额外要看的帖子", itemsHint: "前两个源没覆盖到的帖子写这里——填了以后它同时变成「只在这些帖子里算 @」", itemsPh: "1000001",
        forums: true,
      },
    ];

    const FILTER_ROWS = [
      { key: "allowUsers", label: "只回这些人", hint: "uid 或昵称，逗号分隔。空 = 不限" },
      { key: "denyUsers", label: "不回这些人", hint: "黑名单，优先于白名单" },
      { key: "allowForums", label: "只回这些板块", hint: "板块 id 或名字。空 = 不限" },
      { key: "denyForums", label: "不回这些板块", hint: "黑名单" },
      { key: "allowTopics", label: "只回这些帖子", hint: "帖子 id 或链接。空 = 不限" },
      { key: "denyTopics", label: "不回这些帖子", hint: "黑名单" },
    ];

    function SourcePanel({ def, cfg, setCfg, disabled, onPickSections }) {
      const src = getPath(cfg, ["listen", def.key]) || {};
      const set = (path, value) => setCfg((c) => setPath(c, ["listen", def.key, ...path], value));
      const itemsArr = (Array.isArray(src.items) ? src.items : []).map((it) =>
        typeof it === "string" ? it : [it.id, it.title].filter(Boolean).join(" "));
      const forumsArr = (Array.isArray(src.forums) ? src.forums : []).map((it) =>
        typeof it === "string" ? it : [it.id, it.title].filter(Boolean).join(" "));
      const toItems = (arr) => arr.map((line) => {
        const sp = line.search(/\s/);
        return sp < 0 ? { id: line, title: "" } : { id: line.slice(0, sp), title: line.slice(sp + 1).trim() };
      });

      // 范围语义说明：这个源的开关和清单是「与」关系，两个都满足才扫。
      // 关掉开关 = 这个源完全不参与；开关开着但清单空 = 没有地方可扫，同样什么都不出。
      const scopeNote = def.noItems
        ? !src.enabled
          ? "关着：不去读消息中心的通知，别人的 @ 一条都收不到"
          : "开着：每轮读一次消息中心的「@我的」，有新 @ 就回。这里没有要填的东西"
        : !src.enabled
          ? "关着：这个源完全不参与，一条都不扫"
          : itemsArr.length === 0
            ? "开着但清单是空的：没有可扫的地方，实际上什么都不扫。要让它自己出去找帖，去开「自动刷论坛」"
            : "开着，扫这 " + itemsArr.length + " 个地方";

      return h("div", null,
        h("div", { className: "hkw-note", style: { paddingBottom: "2px" } }, scopeNote),
        def.noItems ? null : h(Row, { label: def.itemsLabel, hint: def.itemsHint, block: true },
          h("textarea", {
            className: "hkw-ta", disabled, placeholder: def.itemsPh, value: itemsArr.join("\n"),
            onChange: (e) => set(["items"], toItems(e.target.value.split(/\n+/).map((s) => s.trim()).filter(Boolean))),
          })),

        // at.forums 只做限制、不扩大扫描范围（collect() 根本不读它），所以标题不能写成「额外盯的板块」。
        def.forums ? h(Row, { label: "只在这些板块里应 @", hint: "留空 = 不限板块。\n填了以后，只有这些板块里的 @ 才算数；它不会扩大扫描范围——扫哪儿由上面的「板块」和「帖子」决定", block: true },
          h("textarea", {
            className: "hkw-ta", disabled, placeholder: "23064", value: forumsArr.join("\n"),
            onChange: (e) => set(["forums"], toItems(e.target.value.split(/\n+/).map((s) => s.trim()).filter(Boolean))),
          })) : null,

        (def.extra || []).map((x) =>
          h(SwRow, {
            key: x.path.join("."), label: x.label, hint: x.hint,
            on: !!getPath(src, x.path), onChange: (v) => set(x.path, v), disabled,
          })),

        def.key === "forum" && onPickSections
          ? h("div", { className: "hkw-rowbtns", style: { paddingTop: "4px" } },
              h("button", { type: "button", className: "hkw-link", onClick: onPickSections, disabled }, "查板块 ID"))
          : null,

        h(More, { label: "这个源专属的白名单 / 黑名单" },
          FILTER_ROWS.map((f) =>
            h(Row, { key: f.key, label: f.label, hint: f.hint },
              h(ListInput, {
                value: Array.isArray(src[f.key]) ? src[f.key] : [],
                onChange: (v) => set([f.key], v),
                placeholder: "空 = 不限",
                disabled,
              })))));
    }

    /* ───────────────── 主组件 ───────────────── */

    /** 保存状态的三态文案。没有保存按钮，这行就是用户唯一能看到的确认。 */
    const SAVE_TEXT = {
      idle: { cls: "hkw-note", text: "改动会自动保存" },
      saving: { cls: "hkw-note", text: "保存中…" },
      saved: { cls: "hkw-ok", text: "✓ 已保存" },
      failed: { cls: "hkw-err", text: "✗ 保存失败，改一下会重试" },
    };

    /** @ 触发口径。和 tools/lib/trigger.mjs 的 TRIGGER_MODES 一一对应。 */
    const TRIGGER_OPTS = [
      { key: "both", t: "两种都认" },
      { key: "rich", t: "只认真 @" },
      { key: "plain", t: "只认文字 @" },
    ];

    const MODES = [
      { key: "reply", t: "只回 @", s: "有人喊她才说话" },
      { key: "both", t: "两个都要", s: "回帖 + 刷帖都开" },
      { key: "browse", t: "只刷不发", s: "自己翻帖、写日报" },
      { key: "off", t: "先关着", s: "装好，不自动跑" },
    ];

    function HykbWhaleSection() {
      const [cfg, setCfg] = useState(null);
      const [sys, setSys] = useState(null);
      const [out, setOut] = useState("");
      const [err, setErr] = useState("");
      const [note, setNote] = useState("");
      const [saveState, setSaveState] = useState("idle");
      const [warn, setWarn] = useState("");
      const [busy, setBusy] = useState("");
      const [ck, setCk] = useState({ uid: "", Pauth: "", Uauth: "", nickname: "" });
      const [ckMsg, setCkMsg] = useState("");
      const [qrActive, setQrActive] = useState(false);
      const [personaText, setPersonaText] = useState("");
      const [personaMsg, setPersonaMsg] = useState("");
      // 默认停在 @ 我通知：它是唯一默认开着、且不用填任何东西的源
      const [tab, setTab] = useState("atme");
      const [secList, setSecList] = useState(null);
      /** cfg 的当前值。自动保存是纯计算，不能塞进 setState 的 updater。 */
      const cfgRef = useRef(null);

      useEffect(() => {
        if (document.querySelector('style[data-dsh-css="' + CSS_TAG + '"]')) return;
        const el = document.createElement("style");
        el.setAttribute("data-dsh-css", CSS_TAG);
        el.textContent = CSS;
        document.head.appendChild(el);
      }, []);

      const load = useCallback(async () => {
        setErr("");
        try {
          const r = await fetch(API + "/settings");
          const j = await r.json();
          if (!j.ok) { setErr(j.error || "读取失败"); return; }
          cfgRef.current = j.config;
          setCfg(j.config);
        } catch (e) { setErr(String(e.message || e)); }
      }, []);

      const probe = useCallback(async (quiet) => {
        if (!quiet) setBusy("status");
        try {
          const r = await fetch(API + "/status");
          const j = await r.json();
          if (j.ok) setSys(j);
          else if (!quiet) setErr(j.error || "状态读取失败");
        } catch (e) { if (!quiet) setErr(String(e.message || e)); }
        finally { if (!quiet) setBusy(""); }
      }, []);

      const loadPersona = useCallback(async () => {
        try {
          const r = await fetch(API + "/persona");
          const j = await r.json();
          if (j.ok) setPersonaText(j.text || "");
        } catch { /* 人设读不到不影响主流程 */ }
      }, []);

      useEffect(() => { load(); loadPersona(); probe(true); }, [load, loadPersona, probe]);

      /* ── 自动保存 ──
         没有保存按钮：改一次就排一次队，去抖 400ms 后把最新一份 cfg 提交上去。
         连点开关时上一个 POST 可能还在飞，所以用 ref 记「最新要存的那份」：
         请求回来发现又有新改动，就接着存；没有才算存干净。
         cfg 的当前值另存在 ref 里 —— 改配置是纯计算，不能塞进 setState 的 updater
         （React 会重复调用 updater，副作用会执行两遍）。 */
      const pending = useRef(null);   // 还没提交的最新配置
      const flying = useRef(false);   // 是否有一个 POST 在飞
      const timer = useRef(null);     // 去抖计时器

      const flush = useCallback(async () => {
        if (flying.current || !pending.current) return;
        const payload = pending.current;
        pending.current = null;
        flying.current = true;
        setSaveState("saving"); setErr("");
        try {
          const r = await fetch(API + "/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: payload }),
          });
          const j = await r.json();
          if (!j.ok) { setSaveState("failed"); setErr(j.error || "保存失败"); return; }
          setWarn(j.warn || "");
          setSaveState("saved");
          // 服务端会把超范围的数值钳回去。只有这期间没人再改，才把规范化后的配置贴回界面，
          // 否则会把用户正在敲的东西冲掉。
          if (!pending.current && !timer.current && j.config) {
            cfgRef.current = j.config;
            setCfg(j.config);
          }
          probe(true);
        } catch (e) {
          setSaveState("failed");
          setErr(String(e.message || e));
        } finally {
          flying.current = false;
          if (pending.current) flush();
        }
      }, [probe]);

      /** 改一个字段：立刻更新界面，并把整份新配置排进保存队列 */
      const patch = useCallback((fn) => {
        const next = fn(cfgRef.current);
        cfgRef.current = next;
        setCfg(next);
        pending.current = next;
        // 一改就翻成「保存中…」：否则去抖那 400ms 里页尾还挂着上一轮的「✓ 已保存」，
        // 看起来像刚改的东西已经存好了，其实还在排队。
        setSaveState("saving");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => { timer.current = null; flush(); }, 400);
      }, [flush]);

      useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

      const saveCookie = useCallback(async () => {
        setBusy("cookie"); setErr(""); setCkMsg("");
        try {
          const r = await fetch(API + "/cookie", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(ck),
          });
          const j = await r.json();
          setCkMsg(j.ok ? "✓ 已写入：" + j.nickname + "（" + j.uid + "）" : "✗ " + (j.error || "写入失败"));
          if (j.ok) { await load(); probe(true); }
        } catch (e) { setCkMsg("✗ " + String(e.message || e)); }
        finally { setBusy(""); }
      }, [ck, load, probe]);

      const savePersona = useCallback(async () => {
        setBusy("persona"); setPersonaMsg("");
        try {
          const r = await fetch(API + "/persona", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: personaText }),
          });
          const j = await r.json();
          setPersonaMsg(j.ok ? "✓ 已保存 " + j.bytes + " 字节" : "✗ " + (j.error || "保存失败"));
        } catch (e) { setPersonaMsg("✗ " + String(e.message || e)); }
        finally { setBusy(""); }
      }, [personaText]);

      const refreshStatus = useCallback(async () => {
        setNote(""); setOut("");
        await probe(false);
        try {
          const r = await fetch(API + "/status");
          const j = await r.json();
          if (!j.ok) return;
          const bb = j.browse;
          setOut([
            "账号：" + (j.credentials.present ? j.credentials.nickname + "（" + j.credentials.uid + "）" : "未登录"),
            "AI：" + (j.aiReady ? "已配置" : "未配置（地址 / 模型 / 密钥 缺一个）"),
            "读：" + j.traffic.readHour + "/时 " + j.traffic.readDay + "/天　写：" + j.traffic.writeHour + "/时 " + j.traffic.writeDay + "/天" + (j.traffic.pausedUntil ? "　⚠ 风控暂停中" : ""),
            "自动回帖：" + (j.listen.running ? "运行中" : "停") + (j.listen.lastTickAt ? "，上次扫描 " + new Date(j.listen.lastTickAt).toLocaleTimeString() : "") + (j.listen.lastError ? "\n　⚠ " + j.listen.lastError : ""),
            "自动刷帖：" + (!bb ? "时钟未启动" : (bb.enabled ? "开" : "关") + (bb.lastRunAt ? "，上次 " + new Date(bb.lastRunAt).toLocaleTimeString() : "，还没刷过") + (bb.hasSession ? "" : "\n　⚠ 宿主没给会话能力：只写日报，不会叫醒她")) + (bb && bb.lastError ? "\n　⚠ " + bb.lastError : ""),
            bb && bb.lastResult ? "　上轮：扫 " + bb.lastResult.scanned + " 帖 / 选 " + bb.lastResult.picked + " 帖 / 回 " + bb.lastResult.replied + " 条" : "",
          ].filter(Boolean).join("\n"));
        } catch (e) { setErr(String(e.message || e)); }
      }, [probe]);

      const toggleListen = useCallback(async (action) => {
        setBusy("listen");
        try {
          const r = await fetch(API + "/listen", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          });
          const j = await r.json();
          setNote(j.ok ? (action === "stop" ? "✓ 已停止" : "✓ 已启动") : "✗ " + (j.error || "操作失败"));
          probe(true);
        } catch (e) { setErr(String(e.message || e)); }
        finally { setBusy(""); }
      }, [probe]);

      const browse = useCallback(async (action, extra) => {
        setBusy("browse"); setErr(""); setOut(""); setNote("");
        try {
          const r = await fetch(API + "/browse", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, ...(extra || {}) }),
          });
          const j = await r.json();
          if (!j.ok) { setErr(j.error || "操作失败"); return; }
          if (action === "preview") {
            const top = (j.top || []).map((x, i) =>
              String(i + 1).padStart(2, " ") + ". " + String(x.score).padStart(6) + " 分  " + x.title +
              "\n      " + (x.sectionTitle || "") + " · 回复 " + x.replyCount + " · 赞 " + x.upVote
            ).join("\n");
            setOut("扫了 " + j.scanned + " 帖，前 " + (j.top || []).length + " 名：\n" + top + "\n\n" + (j.log || []).join("\n"));
            return;
          }
          if (action === "run") {
            const s = j.stats || {};
            setOut("扫 " + s.scanned + " 帖，选 " + (s.picked || []).length + " 帖，回 " + (s.replied || 0) + " 条" +
              (s.dryRun ? "（预览，未真发）" : "") + "\n日报：" + (s.file || "（未写）") + "\n\n" + (s.text || "").slice(0, 1500));
            return;
          }
          if (action === "sections") {
            setSecList(j.sections || []);
            setOut((j.sections || []).map((s) => s.id + "　" + s.title).join("\n") || "（没有板块）");
            return;
          }
        } catch (e) { setErr(String(e.message || e)); }
        finally { setBusy(""); }
      }, []);

      const loadDigest = useCallback(async () => {
        setBusy("digest"); setErr(""); setOut("");
        try {
          const r = await fetch(API + "/digest");
          const j = await r.json();
          if (!j.ok) { setErr(j.error || "读取失败"); return; }
          const files = j.files || [];
          if (!files.length) { setOut("还没有日报。点「跑一轮」跑一次。"); return; }
          const r2 = await fetch(API + "/digest?date=" + files[0].date);
          const j2 = await r2.json();
          setOut("最近一份：" + files[0].date + "（" + files[0].bytes + " 字节）\n\n" + (j2.text || ""));
        } catch (e) { setErr(String(e.message || e)); }
        finally { setBusy(""); }
      }, []);

      // 扫码成功后服务端已经把 self 写进配置文件了，这里不能只改本地 cfg ——
      // 本地那份会带着旧的 uid 一直显示，跟磁盘上真实登录态不一致。
      // 直接重读配置，让界面与服务端对齐。
      const updateAccount = useCallback(async (acc) => {
        await load();
        probe(true);
        setNote("✓ 登录成功：" + (acc.nickname || "（没昵称）") + "（" + (acc.uid || "") + "）");
      }, [load, probe]);

      const locked = !!busy || qrActive;

      if (!cfg) {
        return h("div", { className: "hkw" },
          h("div", { className: "hkw-head" }, h("div", { className: "hkw-ht" }, h("h3", { className: "hkw-title" }, "快爆小号"))),
          err ? h("div", { className: "hkw-err" }, err) : h("div", { className: "hkw-note" }, "读取配置中…"));
      }

      // 没写 tier 的字段就是 tier 1（默认显示）；只有显式 tier:2 才收进「高级」
      const bySec = (s, tier) => FIELDS.filter((f) => f.sec === s && (f.tier || 1) === tier);
      const acc = sys ? sys.credentials : null;
      const b = sys ? sys.browse : null;
      const aiReady = sys ? !!sys.aiReady : null;
      const replyOn = cfg.listen?.enabled === true;
      const browseOn = cfg.browse?.enabled === true;
      // 宿主调度器是不是真的在跑（/status 里的 listen.running）。启停按钮按它二选一显示。
      const listenRunning = !!(sys && sys.listen && sys.listen.running);
      const mode = replyOn && browseOn ? "both" : replyOn ? "reply" : browseOn ? "browse" : "off";
      const setMode = (key) => patch((c) => {
        const n = setPath(c, ["listen", "enabled"], key === "reply" || key === "both");
        return setPath(n, ["browse", "enabled"], key === "browse" || key === "both");
      });
      const fieldsOf = (s, tier) =>
        bySec(s, tier).map((f) => h(Field, { key: f.path.join("."), field: f, cfg, setCfg: patch, disabled: locked }));

      const pill = (label, state, text, tip) => h("span", { className: "hkw-pill", key: label },
        h("span", { className: "hkw-dot", "data-s": state }), label + " ", h("b", null, text),
        tip ? h(Tip, { text: tip, side: "bottom" }) : null);

      return h("div", { className: "hkw" },

        /* 页头 */
        h("div", { className: "hkw-head" },
          h("div", { className: "hkw-ht" },
            h("h3", { className: "hkw-title" }, "快爆小号"),
            h("p", { className: "hkw-sub" }, "在好游快爆养一个 AI 小号：有人 @ 她就回帖，也能自己刷论坛写日报。")),
          h("button", { type: "button", className: "hkw-btn", "data-v": "outline", "data-sz": "sm", onClick: refreshStatus, disabled: locked },
            busy === "status" ? "读取中…" : "刷新状态")),

        /* 状态条 */
        h("div", { className: "hkw-chips" },
          pill("账号", !acc ? "" : acc.present ? "ok" : "bad", !acc ? "…" : acc.present ? (acc.nickname || acc.uid) : "未登录",
            acc && acc.why ? acc.why : "登录态存在 ~/.hykb-ai，只有 uid 没有 Pauth 时能读不能写。"),
          pill("AI", aiReady === null ? "" : aiReady ? "ok" : "bad", aiReady === null ? "…" : aiReady ? "已接" : "未配置",
            "需要接口地址、模型名、密钥三项齐全。"),
          pill("回帖", !replyOn ? "warn" : "ok", replyOn ? "开" : "关", "开着才会去扫 @。"),
          pill("刷帖", !browseOn ? "warn" : "ok", browseOn ? "开" : "关", "开着才会自己翻板块写日报。"),
          b && b.hasSession === false ? pill("叫醒", "bad", "宿主无会话能力", "宿主没给会话能力：日报照写，但不会在她的会话里说话。") : null),

        /* 用法：一次点掉所有开关 */
        h("div", { className: "hkw-modes" }, MODES.map((m) => h("button", {
          key: m.key, type: "button", className: "hkw-mode", "data-on": mode === m.key ? 1 : 0,
          disabled: locked, onClick: () => setMode(m.key),
        },
          h("b", null, m.t),
          h("span", null, m.s)))),

        /* ① 登录 */
        h(Card, {
          no: 1,
          title: "登录账号",
          sub: acc && acc.present
            ? "已登录：" + (acc.nickname || "") + "（" + acc.uid + "）" + (acc.hasPauth ? "，可以发帖" : "，只能读") + "。换号可以在下面重来一次。"
            : "扫码，或者手动粘贴浏览器里的 Cookie。两条路都行，成功后立刻写入，不用点保存。",
          badge: acc && acc.present ? { s: "ok", t: "已登录" } : { s: "warn", t: "必做" },
        },
          h(QrLogin, {
            disabled: locked, onAccount: updateAccount, onActiveChange: setQrActive,
            ck, setCk, onSave: saveCookie, saving: busy === "cookie", msg: ckMsg,
          }),
          acc && acc.needLogin && acc.why ? h("div", { className: "hkw-err" }, "⚠ " + acc.why) : null),

        /* ② 接上 AI */
        h(Card, {
          no: 2, title: "接上 AI",
          sub: "她写的话由这个模型生成。填 OpenAI 兼容的接口即可",
          badge: aiReady === false ? { s: "warn", t: "必做" } : aiReady ? { s: "ok", t: "已接" } : null,
        },
          fieldsOf("ai", 1),
          h(More, null, fieldsOf("ai", 2))),

        /* ③ 她是谁 */
        h(Card, { no: 3, title: "她是谁", sub: "决定她的口吻。这三行直接影响回帖质量" },
          fieldsOf("who", 1),
          h(Row, { label: "人设补充", hint: "自由文本，会拼进系统提示。写她不会做什么比写她会做什么更有效", block: true },
            h("textarea", {
              className: "hkw-ta",
              value: personaText,
              placeholder: "例如：喜欢用短句和克制的吐槽；不主动提游戏外的话题；不刷表情",
              onChange: (e) => setPersonaText(e.target.value),
            })),
          h("div", { className: "hkw-rowbtns", style: { paddingTop: "6px" } },
            personaMsg ? h("span", { className: personaMsg.startsWith("✓") ? "hkw-ok" : "hkw-err" }, personaMsg) : null,
            h("button", { type: "button", className: "hkw-btn", "data-v": "outline", "data-sz": "sm", onClick: savePersona, disabled: locked },
              busy === "persona" ? "保存中…" : "保存人设")),
          h(More, null, fieldsOf("who", 2))),

        /* ④ 自动回帖 */
        h(Card, {
          no: 4, title: "自动回帖",
          sub: replyOn
            ? "开着：每 " + (cfg.listen?.intervalSec ?? "-") + " 秒扫一次，有人 @ 她就回。"
            : "关着：不会主动发任何回复。",
          badge: replyOn ? { s: "ok", t: "开" } : null,
          off: !replyOn,
          right: h(Sw, { on: replyOn, disabled: locked, onChange: (v) => patch((c) => setPath(c, ["listen", "enabled"], v)) }),
        },
          replyOn
            ? [
                h(Row, { key: "iv", label: "扫描间隔（秒）", hint: "20–3600，默认 60。太短会白烧读额度" },
                  h("input", {
                    className: "hkw-in", type: "number", disabled: locked, value: cfg.listen?.intervalSec ?? "",
                    onChange: (e) => patch((c) => setPath(c, ["listen", "intervalSec"], e.target.value === "" ? "" : Number(e.target.value))),
                  })),
                h(SwRow, {
                  key: "allday", label: "全天扫", hint: "关掉后只在「时间段」里扫",
                  on: cfg.listen?.allDay !== false, disabled: locked,
                  onChange: (v) => patch((c) => setPath(c, ["listen", "allDay"], v)),
                }),
                /* @ 怎么才算叫我：平台只有互相关注才发得出真 @，所以两条路都得能选 */
                (() => {
                  const cur = cfg.listen?.triggerMode || "both";
                  return h(Row, {
                    key: "trig",
                    label: "怎么算 @ 我",
                    hint: "真 @ 是富文本标签，平台会校验好友关系——只有互相关注的人才发得出去。\n纯文本「@昵称」任何号都能打，不要求好友，但可能有人手打昵称冒充叫你。\n拿不准就留「两种都认」",
                    block: true,
                  }, h("div", { className: "hkw-seg" }, TRIGGER_OPTS.map((o) => h("button", {
                    key: o.key, type: "button", "data-on": cur === o.key ? 1 : 0, disabled: locked,
                    onClick: () => patch((c) => setPath(c, ["listen", "triggerMode"], o.key)),
                  }, o.t))));
                })(),
                h("div", { key: "seg", className: "hkw-seg" }, SOURCES.map((d) => h("button", {
                  key: d.key, type: "button", "data-on": tab === d.key ? 1 : 0, disabled: locked,
                  onClick: () => setTab(d.key),
                },
                  d.tab,
                  getPath(cfg, ["listen", d.key, "enabled"]) ? h("span", { className: "hkw-dot", "data-s": "ok" }) : null))),
                (() => {
                  const def = SOURCES.find((d) => d.key === tab) || SOURCES[0];
                  const on = !!getPath(cfg, ["listen", def.key, "enabled"]);
                  return h("div", { key: "src" },
                    h(SwRow, {
                      label: def.noItems ? "读消息中心的「@我的」" : "扫「" + def.tab + "」", hint: def.hint,
                      on, disabled: locked,
                      onChange: (v) => patch((c) => setPath(c, ["listen", def.key, "enabled"], v)),
                    }),
                    h(SourcePanel, { def, cfg, setCfg: patch, disabled: locked, onPickSections: () => browse("sections") }));
                })(),
                h(More, { key: "adv" }, fieldsOf("reply", 2)),
                h("div", { key: "btns", className: "hkw-rowbtns", style: { paddingTop: "8px" } },
                  h("button", {
                    type: "button",
                    className: "hkw-btn",
                    "data-v": listenRunning ? "ghost" : "outline",
                    "data-sz": "sm",
                    disabled: locked,
                    onClick: () => toggleListen(listenRunning ? "stop" : "start"),
                  }, busy === "listen" ? "处理中…" : listenRunning ? "停止" : "启动")),
              ]
            : null),

        /* ⑤ 自动刷论坛 */
        h(Card, {
          no: 5, title: "自动刷论坛",
          sub: browseOn
            ? "开着：每 " + Math.round((cfg.browse?.intervalSec ?? 3600) / 60) + " 分钟扫一轮，" + (cfg.browse?.pick ?? 8) + " 帖进日报" + (cfg.browse?.wake !== false ? "，然后叫醒她的会话。" : "，不叫醒她。")
            : "关着：不会自己扫板块、不写日报。",
          badge: browseOn ? { s: "ok", t: "开" } : null,
          off: !browseOn,
          right: h(Sw, { on: browseOn, disabled: locked, onChange: (v) => patch((c) => setPath(c, ["browse", "enabled"], v)) }),
        },
          browseOn
            ? [
                bySec("browse", 1).filter((f) => f.kind !== "switch").map((f) => h(Field, { key: f.path.join("."), field: f, cfg, setCfg: patch, disabled: locked })),
                bySec("browse", 1).filter((f) => f.kind === "switch" && f.path[1] !== "enabled").map((f) => h(Field, { key: f.path.join("."), field: f, cfg, setCfg: patch, disabled: locked })),
                h(More, { key: "adv" }, fieldsOf("browse", 2)),
                b && b.hasSession === false
                  ? h("div", { key: "nosession", className: "hkw-err" }, "⚠ 宿主没给会话能力：日报照写，但不会叫醒她（headless 模式下属正常）")
                  : null,
                h("div", { key: "btns", className: "hkw-rowbtns", style: { paddingTop: "8px", justifyContent: "flex-start" } },
                  h("button", { type: "button", className: "hkw-btn", "data-v": "outline", "data-sz": "sm", onClick: () => browse("preview"), disabled: locked }, busy === "browse" ? "扫帖中…" : "预览选题"),
                  h("button", { type: "button", className: "hkw-btn", "data-v": "outline", "data-sz": "sm", onClick: () => browse("run", { dry: true }), disabled: locked }, "跑一轮（不真发）"),
                  h("button", { type: "button", className: "hkw-btn", "data-v": "outline", "data-sz": "sm", onClick: loadDigest, disabled: locked }, busy === "digest" ? "读取中…" : "看最新日报")),
              ]
            : null),

        /* ⑥ 安全阀 */
        h(Card, { no: 6, title: "安全阀", sub: "所有出网请求共用这一份额度账本，撞到风控会自己暂停" },
          fieldsOf("risk", 1)),

        /* 运行记录 */
        out || secList
          ? h(Card, {
              title: "运行记录",
              right: h("button", { type: "button", className: "hkw-link", onClick: () => { setOut(""); setSecList(null); } }, "清空"),
            },
              h("pre", { className: "hkw-log" }, out))
          : null,

        err ? h("div", { className: "hkw-err" }, err) : null,

        /* 保存状态：没有按钮，改完自己存 */
        h("div", { className: "hkw-saverow" },
          h("span", { className: SAVE_TEXT[saveState].cls, "data-save": saveState }, SAVE_TEXT[saveState].text),
          warn ? h("span", { className: "hkw-err" }, "⚠ " + warn) : null,
          note ? h("span", { className: note.startsWith("✓") ? "hkw-ok" : "hkw-err" }, note) : null),

        h(More, { label: "命令行用法" },
          h("div", { className: "hkw-foot" }, "node tools/hykb.mjs whoami | read <帖子id> | summary <帖子id> | browse | digest --dry")));
    }

    const inject = ["slots"];
    const NS = "hykb-whale";
    const NAMES = { nav: "快爆" };

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject("settings.section", () =>
            ctx.slots.register(
              { name: "settings.section", id: NS, order: 8, label: () => NAMES.nav },
              HykbWhaleSection,
            ),
            "hykb-whale: settings section",
          ),
        "hykb-whale: settings section",
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.HykbWhaleSection = HykbWhaleSection;
    exports.FIELDS = FIELDS;
    return module.exports;
  },
});
