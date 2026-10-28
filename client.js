/**
 * dsh-her-memory —— 客户端半边（浏览器）
 *
 * 两个落点：
 *   A. 输入框上方的常驻状态条（conversation.input.dock）
 *   B. 设置页里的「记忆与心情」面板（settings.section）
 *
 * 配色默认走浅蓝体系（深蓝 #172347 / 品牌蓝 #526aa8 / 香槟金 #c5a468 只作兜底值），
 * 同时优先吃 --dsw-* 主题变量，换皮肤也能跟着走。
 *
 * 数据来自自己的 Host 半边：GET /her-memory/snapshot（见 index.js 第 5 节）。
 * 形态同 dsh-custom-css / dsh-session-delete：__ModuleLoader__.load 工厂 + require('react')。
 */
window.__ModuleLoader__.load({
  id: 'dsh-her-memory',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    let React = null;
    try {
      React = require('react');
    } catch {
      React = null;
    }

    const ENDPOINT = '/her-memory/snapshot';
    const PLUGIN_ID = 'dsh-her-memory';

    /* ================================================================== *
     * 视觉：浅蓝体系，全部挂在 ID 作用域下（#herm-bar-scope / #herm-scope），
     * 避免和其它插件或皮肤的通用 class 打架。
     * ================================================================== */
    const CSS = `
#herm-bar-scope,#herm-scope{
  --herm-ink:var(--dsw-alias-label-primary,#172347);
  --herm-ink2:var(--dsw-alias-label-secondary,#4d5d7f);
  --herm-ink3:var(--dsw-alias-label-caption,#8a94aa);
  --herm-accent:var(--dsw-alias-brand-primary,#526aa8);
  --herm-gold:#c0a062;
  --herm-hair:rgba(71,91,145,.13);
  --herm-track:rgba(71,91,145,.09);
}

/* ---------- A. 状态条 ---------- */
#herm-bar-scope{
  display:flex;align-items:center;justify-content:center;gap:14px;
  /* 必须单行：内容再挤也不换行（一换行就变两行，很臃肿） */
  flex-wrap:nowrap;white-space:nowrap;
  /* 宽度策略（2026-10-13 三修；前两次的坑见 syncWidth 处注释）：
     ① 不许撑满（会挤坏 token-saver）；② 不许设 max-width 上限
     （会让「366 轮 / 记 N」画到底板外，用户截图抓到）—— 底板必须包住内容。
     ⚠️ 本块 CSS 在 JS 模板字符串里：注释里别写反引号、别写美元加大括号。 */
  width:max-content;max-width:none;
  margin:0 auto 10px;align-self:center;flex:0 0 auto;box-sizing:border-box;
  /* 高度兜底：曾被 flex 父容器压扁导致内容被裁，这里给死最小高度 */
  min-height:34px;height:auto;
  padding:8px 18px;
  font-size:12px;line-height:1;color:var(--herm-ink2);
  background:linear-gradient(180deg,rgba(250,252,255,.9),rgba(240,244,252,.78));
  border:1px solid var(--herm-hair);border-radius:13px;
  box-shadow:0 1px 2px rgba(23,35,71,.035),0 10px 26px -20px rgba(23,35,71,.42);
  backdrop-filter:blur(10px) saturate(1.05);user-select:none;
  /* 注意：这里不能用溢出裁剪 —— 它会把被压扁后的内容切掉（实测踩到过）。
     圆角效果由 border-radius 提供，不依赖裁切。 */
  position:relative;
}
#herm-bar-scope .herm-metric{display:flex;align-items:center;gap:7px;white-space:nowrap;}
#herm-bar-scope .herm-dot{width:6px;height:6px;border-radius:50%;flex:none;}
#herm-bar-scope .herm-d-1{background:#8fa2dc;}
#herm-bar-scope .herm-d-2{background:#dda6c0;}
#herm-bar-scope .herm-d-3{background:#93c6ac;}
#herm-bar-scope .herm-name{color:var(--herm-ink3);letter-spacing:.03em;}
#herm-bar-scope .herm-track{position:relative;width:48px;height:4px;border-radius:999px;background:var(--herm-track);overflow:hidden;}
#herm-bar-scope .herm-fill{position:absolute;inset:0 auto 0 0;border-radius:999px;transition:width .5s cubic-bezier(.22,.61,.36,1);}
#herm-bar-scope .herm-f-1{background:linear-gradient(90deg,#a9b8e8,#7b8fd4);}
#herm-bar-scope .herm-f-2{background:linear-gradient(90deg,#eec3d5,#dda6c0);}
#herm-bar-scope .herm-f-3{background:linear-gradient(90deg,#b3ddc6,#93c6ac);}
#herm-bar-scope .herm-num{font-variant-numeric:tabular-nums;font-weight:650;color:var(--herm-ink);min-width:18px;}
#herm-bar-scope .herm-word{color:var(--herm-ink3);}
#herm-bar-scope .herm-spacer{flex:1;min-width:8px;}
#herm-bar-scope .herm-vline{width:1px;height:13px;background:var(--herm-hair);flex:none;}
#herm-bar-scope .herm-quiet{color:var(--herm-ink3);}
#herm-bar-scope .herm-chip{padding:3px 9px;border-radius:999px;font-size:11px;background:rgba(82,106,168,.085);color:var(--herm-accent);}
#herm-bar-scope .herm-chip-gold{background:rgba(192,160,98,.15);color:#8f7434;cursor:pointer;user-select:none;}
#herm-bar-scope .herm-err,#herm-scope .herm-err{font-size:12.5px;color:#c9422f;}

/* ---------- A2. 双击彩蛋：泡泡与飘字 ----------
   全部挂在一个 position:fixed 的**独立浮层**上，绝不参与状态条布局 ——
   状态条宽度那套逻辑（与 token-saver 共享一列、1.5 秒轮询对齐）碰不得。 */
#herm-fx-layer{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483000;}
#herm-fx-layer .herm-bub{position:fixed;border-radius:50%;opacity:0;
  box-shadow:inset 0 0 6px rgba(255,255,255,.6);
  animation:herm-bub-rise 950ms cubic-bezier(.22,.61,.36,1) forwards;}
#herm-fx-layer .herm-bub-1{background:radial-gradient(circle at 35% 30%,#c9d4f5,#8fa2dc);}
#herm-fx-layer .herm-bub-2{background:radial-gradient(circle at 35% 30%,#f6d7e3,#dda6c0);}
#herm-fx-layer .herm-bub-3{background:radial-gradient(circle at 35% 30%,#cdeade,#93c6ac);}
@keyframes herm-bub-rise{
  0%{transform:translate(0,0) scale(.35);opacity:0;}
  18%{opacity:.95;}
  100%{transform:translate(var(--dx,0px),var(--dy,-60px)) scale(1.2);opacity:0;}
}
#herm-fx-layer .herm-gain{position:fixed;font-size:12.5px;font-weight:700;letter-spacing:.02em;
  text-shadow:0 1px 3px rgba(255,255,255,.95);animation:herm-gain-float 1100ms ease-out forwards;}
#herm-fx-layer .herm-gain-3{color:#4a9b76;}
#herm-fx-layer .herm-gain-1{color:#6a7ec0;}
#herm-fx-layer .herm-gain-2{color:#c9749a;}
@keyframes herm-gain-float{
  0%{transform:translate(-50%,0);opacity:0;}
  20%{opacity:1;}
  100%{transform:translate(-50%,-34px);opacity:0;}
}
/* 可双击的格子给个手型提示 */
#herm-bar-scope .herm-metric{cursor:pointer;}

/* ---------- A3. 设置页条目：开关 ---------- */
#herm-sw-scope{padding:4px 2px 24px;font-size:13px;}
#herm-sw-scope .herm-sw-card{
  background:linear-gradient(180deg,rgba(252,253,255,.92),rgba(243,246,253,.7));
  border:1px solid var(--herm-hair);border-radius:14px;padding:16px 18px 14px;
  box-shadow:0 1px 2px rgba(23,35,71,.03),0 12px 30px -26px rgba(23,35,71,.5);
}
#herm-sw-scope .herm-sw-row{display:flex;align-items:flex-start;gap:16px;}
#herm-sw-scope .herm-sw-text{flex:1;min-width:0;}
#herm-sw-scope .herm-sw-text b{display:block;font-size:13.5px;font-weight:650;color:var(--herm-ink);margin-bottom:6px;}
#herm-sw-scope .herm-sw-text span{display:block;font-size:12.5px;line-height:19px;color:var(--herm-ink3);}
#herm-sw-scope .herm-sw-btn{flex:none;width:46px;height:26px;border-radius:999px;border:1px solid var(--herm-hair);
  background:rgba(71,91,145,.12);position:relative;cursor:pointer;padding:0;transition:background .18s ease;}
#herm-sw-scope .herm-sw-btn.herm-sw-on{background:linear-gradient(90deg,#a9c9b8,#7fb79c);border-color:rgba(127,183,156,.5);}
#herm-sw-scope .herm-sw-knob{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;
  background:#fff;box-shadow:0 1px 3px rgba(23,35,71,.25);transition:transform .18s cubic-bezier(.22,.61,.36,1);}
#herm-sw-scope .herm-sw-btn.herm-sw-on .herm-sw-knob{transform:translateX(20px);}
#herm-sw-scope .herm-sw-btn:disabled{opacity:.6;cursor:default;}
#herm-sw-scope .herm-sw-note{margin-top:12px;font-size:12px;color:var(--herm-ink3);}
#herm-sw-scope .herm-sw-sep{margin-top:16px;padding-top:14px;border-top:1px dashed var(--herm-hair);}
#herm-sw-scope .herm-sw-text span.herm-sw-path{font-size:11.5px;line-height:16px;word-break:break-all;font-family:ui-monospace,Consolas,monospace;}
#herm-sw-scope .herm-sw-open{flex:none;padding:5px 12px;border-radius:8px;border:1px solid var(--herm-hair);background:transparent;color:var(--herm-ink2);font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;}
#herm-sw-scope .herm-sw-open:hover{background:rgba(120,140,180,.14);}
#herm-sw-scope .herm-sw-open:disabled{opacity:.6;cursor:default;}

/* ---------- B. 设置页面板 ---------- */
#herm-scope{padding:4px 2px 24px;font-size:13px;line-height:20px;color:var(--herm-ink2);}
#herm-scope .herm-head{display:flex;align-items:baseline;gap:12px;margin:2px 0 16px;flex-wrap:wrap;}
#herm-scope .herm-head h3{margin:0;font-size:15px;font-weight:650;color:var(--herm-ink);letter-spacing:.01em;}
#herm-scope .herm-head span{font-size:12px;color:var(--herm-ink3);}
#herm-scope .herm-card{
  background:linear-gradient(180deg,rgba(252,253,255,.92),rgba(243,246,253,.7));
  border:1px solid var(--herm-hair);border-radius:14px;
  padding:16px 18px 17px;margin-bottom:12px;
  box-shadow:0 1px 2px rgba(23,35,71,.03),0 12px 30px -26px rgba(23,35,71,.5);
}
#herm-scope .herm-card-title{display:flex;align-items:center;gap:9px;margin:0 0 15px;}
#herm-scope .herm-card-title b{font-size:13.5px;font-weight:650;color:var(--herm-ink);}
#herm-scope .herm-card-title em{font-style:normal;font-size:11.5px;color:var(--herm-ink3);}
#herm-scope .herm-badge{margin-left:auto;font-size:11px;padding:3px 10px;border-radius:999px;background:rgba(82,106,168,.1);color:var(--herm-accent);}
#herm-scope .herm-badge-off{background:rgba(71,91,145,.07);color:var(--herm-ink3);}
#herm-scope .herm-mrow{display:flex;align-items:center;gap:12px;margin:11px 0;}
#herm-scope .herm-mname{width:32px;flex:none;font-size:12px;color:var(--herm-ink3);}
#herm-scope .herm-mtrack{position:relative;flex:1;height:6px;border-radius:999px;background:var(--herm-track);overflow:hidden;}
#herm-scope .herm-mfill{position:absolute;inset:0 auto 0 0;border-radius:999px;transition:width .5s cubic-bezier(.22,.61,.36,1);}
#herm-scope .herm-f-1{background:linear-gradient(90deg,#b3c0eb,#8b9dda);}
#herm-scope .herm-f-2{background:linear-gradient(90deg,#f0cbd9,#e0aec4);}
#herm-scope .herm-f-3{background:linear-gradient(90deg,#bde2cf,#9bcbb2);}
#herm-scope .herm-mval{flex:none;min-width:112px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:var(--herm-ink3);}
#herm-scope .herm-mval b{color:var(--herm-ink);font-weight:650;font-size:12.5px;}
#herm-scope .herm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));gap:8px;margin:16px 0 2px;}
#herm-scope .herm-stat{padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.62);border:1px solid var(--herm-hair);}
#herm-scope .herm-stat u{display:block;text-decoration:none;font-size:10.5px;letter-spacing:.04em;color:var(--herm-ink3);margin-bottom:4px;}
#herm-scope .herm-stat b{font-size:17px;font-weight:650;color:var(--herm-ink);font-variant-numeric:tabular-nums;line-height:1.1;}
#herm-scope .herm-sub{margin:16px 0 7px;font-size:10.5px;letter-spacing:.06em;color:var(--herm-ink3);}
#herm-scope .herm-tags{display:flex;flex-wrap:wrap;gap:6px;}
#herm-scope .herm-tag{padding:3px 10px;border-radius:999px;font-size:12px;background:rgba(82,106,168,.085);color:var(--herm-accent);border:1px solid rgba(82,106,168,.09);}
#herm-scope .herm-note{display:flex;gap:9px;padding:7px 0;font-size:12.5px;line-height:19px;color:var(--herm-ink2);word-break:break-word;}
#herm-scope .herm-note+.herm-note{border-top:1px solid rgba(71,91,145,.06);}
#herm-scope .herm-note i{flex:none;width:5px;height:5px;border-radius:50%;margin-top:7px;background:#a3b2e2;}
#herm-scope .herm-note-gold i{background:#d5bb86;}
#herm-scope .herm-path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;color:var(--herm-ink3);word-break:break-all;line-height:19px;}
#herm-scope .herm-empty{font-size:12.5px;color:var(--herm-ink3);line-height:19px;}
`;

    /* ================================================================== *
     * 数据：拉自己的 Host 端点
     * ================================================================== */
    const PRELOAD = '__dshHerMemoryPreload';
    /** 状态标记：Host 每轮注入 <!--her-memory-state {...json...}-->，客户端从 DOM 里读。 */
    const MARK = 'her-memory-state ';
    const MARK_END = '-->';

    function tryParseAt(text, start) {
      // 从 start 处的 '{' 开始做括号配平，取第一个完整的 JSON 对象（字符串字面量内的括号不计数）
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              const parsed = JSON.parse(text.slice(start, i + 1));
              return parsed && typeof parsed === 'object' ? parsed : null;
            } catch {
              return null;
            }
          }
        }
      }
      return null;
    }

    /**
     * 从对话 DOM 里找 <!--her-memory-state {...}--> 标记并解析 JSON。
     * 找不到返回 null（调用方会退回 HTTP）。
     */
    function readDomState() {
      if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return null;
      let walker = null;
      try {
        walker = document.createTreeWalker(document.body, 0x04 /* SHOW_COMMENT */, null);
      } catch {
        return null;
      }
      const hits = [];
      let node = walker.nextNode();
      while (node !== null && node !== undefined) {
        const text = typeof node.nodeValue === 'string' ? node.nodeValue : '';
        if (text.indexOf(MARK) >= 0) {
          const jsonStart = text.indexOf('{', text.indexOf(MARK));
          if (jsonStart >= 0) {
            const end = text.indexOf(MARK_END, jsonStart);
            const raw = end > jsonStart ? text.slice(jsonStart, end) : text.slice(jsonStart);
            const parsed = tryParseAt(raw, 0);
            if (parsed !== null) hits.push(parsed);
          }
        }
        node = walker.nextNode();
      }
      if (hits.length === 0) return null;
      return hits[hits.length - 1]; // 取最新的一条
    }

    /**
     * 归一化两种数据形态：
     *   注入态（单库）：{ ok, at, scope, store, diag }
     *   HTTP 态（全量）：{ ok, at, stores:[...], byKey:{...}, diag }
     * 统一成 { ok, at, stores, byKey, diag, single }。
     */
    function normalize(raw) {
      if (!raw || typeof raw !== 'object') return null;
      if (raw.stores !== undefined || raw.byKey !== undefined) {
        const stores = Array.isArray(raw.stores) ? raw.stores : Object.values(raw.byKey || {});
        return { ...raw, stores };
      }
      const one = raw.store;
      if (!one || typeof one !== 'object') return null;
      const key = one.key || raw.scope || '_shared';
      return {
        ok: true,
        at: raw.at,
        single: key,
        stores: [one],
        byKey: { [key]: one },
        diag: raw.diag || { registered: [], errors: [] },
      };
    }

    function useSnapshot(intervalMs) {
      const initialRaw = typeof globalThis[PRELOAD] !== 'undefined' ? globalThis[PRELOAD] : null;
      const [data, setData] = React.useState(initialRaw === null ? null : normalize(initialRaw));
      const [err, setErr] = React.useState('');

      /**
       * 数据源优先级：
       *   1) 测试台预置（离线验证用）
       *   2) 对话里 Host 注入的 <!--her-memory-state ...-->（首选，一定能读到，且只含当前工作区）
       *   3) HTTP /her-memory/snapshot（备选，DSH 有鉴权栅栏，未必通得过）
       */
      const fromSource = () => {
        if (typeof globalThis[PRELOAD] !== 'undefined') return normalize(globalThis[PRELOAD]);
        return normalize(readDomState());
      };

      const doFetch = () => {
        fetch(ENDPOINT, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((j) => {
            const n = normalize(j);
            if (n !== null) {
              setData(n);
              setErr('');
            }
          })
          .catch((e) => setErr(String((e && e.message) || e)));
      };

      const tick = () => {
        const next = fromSource();
        if (next !== null) {
          setData(next);
          setErr('');
          return;
        }
        if (typeof globalThis[PRELOAD] === 'undefined') doFetch();
      };

      React.useEffect(() => {
        tick();
        const t = setInterval(tick, intervalMs);
        return () => clearInterval(t);
      }, [intervalMs]);

      return { data, err };
    }

    /* ================================================================== *
     * 小组件
     * ================================================================== */
    const e = React.createElement;
    const pct = (v) => Math.max(0, Math.min(100, Number(v) || 0));

    function moodWord(m) {
      if (m === null || m === undefined) return '—';
      return m >= 79 ? '很开心' : m >= 59 ? '挺好' : m >= 39 ? '平常' : m >= 21 ? '有点闷' : '低落';
    }
    function intimacyWord(v) {
      if (v === null || v === undefined) return '—';
      return v >= 85 ? '自己人' : v >= 60 ? '很亲' : v >= 35 ? '亲近' : v >= 15 ? '熟了' : '刚认识';
    }
    function energyWord(v) {
      if (v === null || v === undefined) return '—';
      return v >= 70 ? '有劲' : v >= 40 ? '一般' : v >= 20 ? '有点累' : '很累';
    }

    /* ---------------- 双击彩蛋（2026-10-13） ----------------
       全部走一个 position:fixed 的独立浮层，**绝不参与状态条布局** ——
       状态条宽度那套（与 token-saver 共享一列 + 1.5 秒轮询对齐）碰不得。 */

    /** 拿（必要时建）浮层。 */
    function fxLayer() {
      let el = document.getElementById('herm-fx-layer');
      if (el === null) {
        el = document.createElement('div');
        el.id = 'herm-fx-layer';
        document.body.appendChild(el);
      }
      return el;
    }

    /** 在被双击的格子上方炸一串对应颜色的泡泡。任何异常都吞掉：特效不许影响功能。 */
    function burstBubbles(target, tone, count) {
      try {
        const el = target && typeof target.getBoundingClientRect === 'function' ? target : null;
        if (el === null || typeof document === 'undefined' || document.body === null) return;
        const r = el.getBoundingClientRect();
        const layer = fxLayer();
        const n = count || 8;
        for (let i = 0; i < n; i++) {
          const b = document.createElement('span');
          const size = 6 + Math.round(Math.random() * 7);
          b.className = `herm-bub herm-bub-${tone}`;
          b.style.width = `${size}px`;
          b.style.height = `${size}px`;
          b.style.left = `${Math.round(r.left + Math.random() * r.width)}px`;
          b.style.top = `${Math.round(r.top + r.height * 0.55)}px`;
          b.style.setProperty('--dx', `${Math.round(Math.random() * 76 - 38)}px`);
          b.style.setProperty('--dy', `${-42 - Math.round(Math.random() * 56)}px`);
          b.style.animationDelay = `${Math.round(Math.random() * 140)}ms`;
          layer.appendChild(b);
          setTimeout(() => { try { b.remove(); } catch { /* ignore */ } }, 1500);
        }
      } catch { /* 特效失败不影响任何功能 */ }
    }

    /** 飘一个 +N 的小字。 */
    function floatGain(target, tone, text) {
      try {
        const el = target && typeof target.getBoundingClientRect === 'function' ? target : null;
        if (el === null || typeof document === 'undefined' || document.body === null) return;
        const r = el.getBoundingClientRect();
        const g = document.createElement('span');
        g.className = `herm-gain herm-gain-${tone}`;
        g.textContent = text;
        g.style.left = `${Math.round(r.right - 2)}px`;
        g.style.top = `${Math.round(r.top + 2)}px`;
        fxLayer().appendChild(g);
        setTimeout(() => { try { g.remove(); } catch { /* ignore */ } }, 1600);
      } catch { /* ignore */ }
    }

    /** 状态条里的一格：圆点 + 名字 + 细条 + 数字 + 形容词。tone 取 1/2/3。双击触发 onDbl。 */
    function Metric({ tone, name, value, word, onDbl, hint }) {
      const v = value === null || value === undefined ? 0 : Number(value);
      return e(
        'span',
        { className: 'herm-metric', onDoubleClick: onDbl, title: hint || undefined },
        e('i', { className: `herm-dot herm-d-${tone}` }),
        e('span', { className: 'herm-name' }, name),
        e('span', { className: 'herm-track' }, e('span', { className: `herm-fill herm-f-${tone}`, style: { width: `${pct(v)}%` } })),
        e('b', { className: 'herm-num' }, value === null || value === undefined ? '—' : String(Math.round(v))),
        word ? e('span', { className: 'herm-word' }, word) : null,
      );
    }

    /** 面板里的粗条一行 */
    function Row({ name, value, tone, word }) {
      const v = value === null || value === undefined ? 0 : Number(value);
      return e(
        'div',
        { className: 'herm-mrow' },
        e('span', { className: 'herm-mname' }, name),
        e('span', { className: 'herm-mtrack' }, e('span', { className: `herm-mfill herm-f-${tone}`, style: { width: `${pct(v)}%` } })),
        e(
          'span',
          { className: 'herm-mval' },
          e('b', null, value === null || value === undefined ? '—' : String(Math.round(v))),
          ` / 100　${word}`,
        ),
      );
    }

    /* ================================================================== *
     * A. 状态条
     * ================================================================== */
    function StatusBar() {
      const { data, err } = useSnapshot(4000);
      /* 双击「精力」后本地先显示新值：DOM 里那份快照要等下一轮对话注入才会刷新。
         （Hook 必须放在所有提前 return 之前，否则违反 Hooks 规则。） */
      const [boost, setBoost] = React.useState(null);

      if (err !== '') {
        return e('div', { id: 'herm-bar-scope' }, e('span', { className: 'herm-err' }, `记忆与心情读取失败 · ${err}`));
      }

      const stores = data && Array.isArray(data.stores) ? data.stores : [];
      const s = stores.find((x) => x.key === '_shared') || stores.find((x) => x.key === '_sandbox');

      if (!s || s.mood === null || s.mood === undefined) {
        return e(
          'div',
          { id: 'herm-bar-scope' },
          e('i', { className: 'herm-dot herm-d-1' }),
          e('span', { className: 'herm-quiet' }, '记忆与心情'),
          e('span', { className: 'herm-spacer' }),
          e('span', { className: 'herm-quiet' }, '还没有数据 · 聊几句就有了'),
        );
      }

      const counts = s.counts || { core: 0, inbox: 0, topics: 0, logs: 0 };
      const memoryTotal = (counts.core || 0) + (counts.inbox || 0) + (counts.topics || 0);
      // 收件箱攒到 5 条才提醒整理
      const inboxFull = (counts.inbox || 0) >= 5;

      // 状态条只放「我此刻的状态」，且必须一行放下：文案尽量短。
      /**
       * 双击某个指标：冒对应颜色的泡泡 + 调对应端点 + 本地立刻显示新值。
       *   endpoint='energy-boost' & field=''         → 精力，+1~50
       *   endpoint='stat-boost'   & field='mood'     → 心情，+0~3
       *   endpoint='stat-boost'   & field='intimacy' → 关系，+0~3
       */
      const onBoostDbl = (endpoint, field, tone, count) => (ev) => {
        const el = ev && ev.currentTarget ? ev.currentTarget : null;
        burstBubbles(el, tone, count);
        const key = s && typeof s.key === 'string' && s.key !== '' ? s.key : '_shared';
        const query =
          field === ''
            ? `key=${encodeURIComponent(key)}`
            : `key=${encodeURIComponent(key)}&field=${encodeURIComponent(field)}`;
        try {
          fetch(`/her-memory/${endpoint}?${query}`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
          })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((j) => {
              if (j && j.ok === true) {
                const name = field === '' ? 'energy' : field;
                const val = field === '' ? j.energy : j.value;
                setBoost((prev) => ({ ...(prev || {}), [name]: val, at: Date.now() }));
                if (Number(j.delta) > 0) floatGain(el, tone, `+${j.delta}`);
              }
            })
            .catch(() => { /* 端点不通就只放泡泡，不打扰用户 */ });
        } catch { /* ignore */ }
      };
      const onEnergyDbl = onBoostDbl('energy-boost', '', 3, 10);
      const onMoodDbl = onBoostDbl('stat-boost', 'mood', 1, 9);
      const onIntimacyDbl = onBoostDbl('stat-boost', 'intimacy', 2, 9);

      /**
       * 双击「该整理」：不传任何自由文本，只让宿主把我叫醒一轮，整理由我自己做。
       * 三种回应都只飘一个字，不弹窗：来了 / 刚叫过 / 先说话。
       */
      const onTidyDbl = (ev) => {
        const el = ev && ev.currentTarget ? ev.currentTarget : null;
        const key = s && typeof s.key === 'string' && s.key !== '' ? s.key : '_shared';
        burstBubbles(el, 2, 9);
        try {
          fetch(`/her-memory/tidy?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
          })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((j) => {
              if (j && j.ok === true && j.skipped !== true) floatGain(el, 3, '来了');
              else if (j && j.skipped === true) floatGain(el, 1, '刚叫过');
              else floatGain(el, 1, '先说话');
            })
            .catch(() => { floatGain(el, 1, '没通'); });
        } catch { /* ignore */ }
      };

      /* 本地覆盖只在「比快照大」时生效 —— 这三个值只会升（心情另有自然回落），
         快照一刷新就自动收敛回真值。 */
      const shown = (field) => {
        const cur = s[field];
        const ov = boost !== null ? Number(boost[field]) : Number.NaN;
        return Number.isFinite(ov) && ov > Number(cur ?? -1) ? ov : cur;
      };
      const moodShown = shown('mood');
      const intimacyShown = shown('intimacy');
      const energyShown = shown('energy');

      const kids = [
        e(Metric, {
          key: 'm',
          tone: 1,
          name: '心情',
          value: moodShown,
          word: moodWord(moodShown),
          onDbl: onMoodDbl,
          hint: '双击逗她开心（随机 +0~3）',
        }),
        e('span', { key: 'v1', className: 'herm-vline' }),
        e(Metric, {
          key: 'i',
          tone: 2,
          name: '关系',
          value: intimacyShown,
          word: intimacyWord(intimacyShown),
          onDbl: onIntimacyDbl,
          hint: '双击拉近一点（随机 +0~3）',
        }),
        e('span', { key: 'v2', className: 'herm-vline' }),
        e(Metric, {
          key: 'e',
          tone: 3,
          name: '精力',
          value: energyShown,
          word: energyWord(energyShown),
          onDbl: onEnergyDbl,
          hint: '双击给精力加一点（随机 +1~50，小数值常见）',
        }),
        e('span', { key: 'sp', className: 'herm-spacer' }),
        e('span', { key: 't', className: 'herm-quiet' }, `${s.turns} 轮`),
        e('span', { key: 'mm', className: 'herm-chip' }, `记 ${memoryTotal}`),
      ];
      if (inboxFull) {
        kids.push(
          e(
            'span',
            {
              key: 'ib',
              className: 'herm-chip herm-chip-gold',
              onDoubleClick: onTidyDbl,
              title: '双击叫她整理收件箱（会唤醒她跑一轮）',
            },
            '该整理',
          ),
        );
      }

      return e('div', { id: 'herm-bar-scope' }, kids);
    }

    /* ================================================================== *
     * B. 设置页面板
     * ================================================================== */
    function StoreCard({ store, title, hint, badge, badgeOff }) {
      if (!store) return null;
      const counts = store.counts || { core: 0, inbox: 0, topics: 0, logs: 0 };
      const kids = [
        e(
          'div',
          { key: 'h', className: 'herm-card-title' },
          e('b', null, title),
          e('em', null, hint || ''),
          badge ? e('span', { className: `herm-badge${badgeOff ? ' herm-badge-off' : ''}` }, badge) : null,
        ),
      ];

      if (store.exists === false) {
        kids.push(e('div', { key: 'x', className: 'herm-empty' }, '这一份还没建立 —— 在这个工作区聊过之后才会出现。'));
        return e('div', { className: 'herm-card' }, kids);
      }

      kids.push(e(Row, { key: 'r1', name: '心情', value: store.mood, tone: 1, word: moodWord(store.mood) }));
      kids.push(e(Row, { key: 'r2', name: '关系', value: store.intimacy, tone: 2, word: intimacyWord(store.intimacy) }));
      kids.push(e(Row, { key: 'r3', name: '精力', value: store.energy, tone: 3, word: energyWord(store.energy) }));

      const stat = (k, u, v) => e('div', { className: 'herm-stat', key: k }, e('u', null, u), e('b', null, String(v)));
      kids.push(
        e(
          'div',
          { key: 'st', className: 'herm-stats' },
          stat('turns', '回合', store.turns ?? 0),
          stat('core', '核心记忆', counts.core ?? 0),
          stat('inbox', '收件箱', counts.inbox ?? 0),
          stat('topics', '专题', counts.topics ?? 0),
          stat('logs', '日记', counts.logs ?? 0),
        ),
      );

      if (Array.isArray(store.topicNames) && store.topicNames.length > 0) {
        kids.push(e('div', { key: 'ts', className: 'herm-sub' }, '专题'));
        kids.push(
          e(
            'div',
            { key: 'tg', className: 'herm-tags' },
            store.topicNames.map((n) => e('span', { key: n, className: 'herm-tag' }, n)),
          ),
        );
      }

      if (Array.isArray(store.recent) && store.recent.length > 0) {
        kids.push(e('div', { key: 'rs', className: 'herm-sub' }, '最近记下的'));
        kids.push(
          e(
            'div',
            { key: 'rl' },
            store.recent.map((l, i) => e('div', { key: i, className: 'herm-note' }, e('i'), e('span', null, l))),
          ),
        );
      }

      if (Array.isArray(store.notes) && store.notes.length > 0) {
        kids.push(e('div', { key: 'ns', className: 'herm-sub' }, '她的心情便签'));
        kids.push(
          e(
            'div',
            { key: 'nl' },
            store.notes.map((l, i) => e('div', { key: i, className: 'herm-note herm-note-gold' }, e('i'), e('span', null, l))),
          ),
        );
      }

      return e('div', { className: 'herm-card' }, kids);
    }

    function MemoryPanel() {
      const { data, err } = useSnapshot(10000);

      if (err !== '') {
        return e('div', { id: 'herm-scope' }, e('div', { className: 'herm-err' }, `读取失败：${err}`));
      }
      if (!data) return e('div', { id: 'herm-scope' }, e('div', { className: 'herm-empty' }, '读取中…'));

      const stores = Array.isArray(data.stores) ? data.stores : [];
      const shared = stores.find((s) => s.key === '_shared');
      const sandbox = stores.find((s) => s.key === '_sandbox');
      const extras = stores.filter((s) => s.key !== '_shared' && s.key !== '_sandbox');
      const diag = data.diag || { registered: [], errors: [] };

      const kids = [
        e(
          'div',
          { key: 'hd', className: 'herm-head' },
          e('h3', null, '记忆与心情'),
          e('span', null, '跨会话长期记忆与情感状态 · 全部为磁盘明文，可随时查看编辑'),
        ),
      ];

      if (data.single) {
        // 注入态：只带当前工作区那一份（隔离硬规则），所以这里说明一句
        const scopeName = data.single === '_sandbox' ? '测试区' : '工作区';
        kids.push(
          e(
            'div',
            { key: 'sc', className: 'herm-card' },
            e(
              'div',
              { className: 'herm-card-title' },
              e('b', null, `当前：${scopeName}`),
              e('em', null, '本页只显示你正所处的这一个记忆库'),
              e('span', { className: 'herm-badge' }, scopeName === '测试区' ? '隔离' : '共用'),
            ),
            e(
              'div',
              { className: 'herm-empty' },
              scopeName === '测试区'
                ? '测试区的对话单独记账，不会写进工作区的长期记忆。'
                : '普通工作区共用这一份记忆；测试区是独立的一份。',
            ),
          ),
        );
      }

      kids.push(
        e(StoreCard, {
          key: 'shared',
          store: shared,
          title: '工作区记忆',
          hint: '所有普通工作区共用这一份',
          badge: shared && shared.exists !== false ? '共用' : null,
        }),
        e(StoreCard, {
          key: 'sandbox',
          store: sandbox,
          title: '测试区记忆',
          hint: '独立隔离，互不影响',
          badge: sandbox && sandbox.exists !== false ? '隔离' : '未启用',
          badgeOff: !sandbox || sandbox.exists === false,
        }),
      );
      for (const s of extras) kids.push(e(StoreCard, { key: s.key, store: s, title: `其他库 · ${s.key}` }));

      const paths = [];
      if (shared) paths.push(shared.root);
      if (sandbox) paths.push(sandbox.root);
      kids.push(
        e(
          'div',
          { key: 'ft', className: 'herm-card' },
          e('div', { className: 'herm-card-title' }, e('b', null, '数据位置'), e('em', null, '纯 Markdown / JSON')),
          paths.length > 0
            ? paths.map((p, i) => e('div', { key: i, className: 'herm-path' }, p))
            : e('div', { className: 'herm-empty' }, '还没有建立任何记忆库'),
          e(
            'div',
            { key: 'dg', className: 'herm-sub' },
            diag.errors && diag.errors.length > 0
              ? e('span', { className: 'herm-err' }, `工具注册异常：${diag.errors.join('; ')}`)
              : `六个工具注册状态：${(diag.registered || []).length} / 6`,
          ),
        ),
      );

      return e('div', { id: 'herm-scope' }, kids);
    }

    /* ================================================================== *
     * 挂载
     * ================================================================== */
    function apply(ctx) {
      if (typeof document === 'undefined' || document.body === null) return;

      /* 探针：确认「客户端代码跑到哪一步」。
         #herm-probe 存在 = apply 进来了；data-slots 显示 slots 服务拿没拿到。 */
      try {
        if (!document.getElementById('herm-probe')) {
          const p = document.createElement('div');
          p.id = 'herm-probe';
          p.style.display = 'none';
          document.body.appendChild(p);
        }
      } catch { /* 探针失败不影响功能 */ }

      const styleTag = document.createElement('style');
      styleTag.setAttribute('data-plugin', PLUGIN_ID);
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);

      if (React === null) {
        try {
          const p = document.getElementById('herm-probe');
          if (p) p.setAttribute('data-react', 'missing');
        } catch { /* ignore */ }
        console.error(`[${PLUGIN_ID}] React 不可用，可视化未启用`);
        return;
      }
      try {
        const p = document.getElementById('herm-probe');
        if (p) p.setAttribute('data-react', 'ok');
      } catch { /* ignore */ }

      const slots = ctx.get('slots');
      try {
        const p = document.getElementById('herm-probe');
        if (p) {
          p.setAttribute('data-slots', slots === undefined || slots === null ? 'missing' : typeof slots);
          p.setAttribute('data-can-inject', slots && typeof slots.inject === 'function' ? 'yes' : 'no');
        }
      } catch { /* ignore */ }

      const reg = (seat, id, order, Comp, label) => {
        const attempt = (svc) => {
          if (svc === undefined || svc === null
              || typeof svc.inject !== 'function' || typeof svc.register !== 'function') {
            return false;
          }
          try {
            svc.inject(seat, () => svc.register({
              name: seat,
              id,
              order,
              registrant: PLUGIN_ID,
              // label 是设置页左侧那份清单里显示的条目名（不传就退化成 id）
              ...(typeof label === 'string' && label !== '' ? { label } : {}),
            }, Comp));
            return true;
          } catch (err) {
            console.error(`[${PLUGIN_ID}] 注册 ${seat} 失败`, err);
            return false;
          }
        };
        const stamp = (txt) => {
          try {
            const p = document.getElementById('herm-probe');
            if (p) p.setAttribute(`data-reg-${id}`, txt);
          } catch { /* ignore */ }
        };

        if (attempt(slots)) {
          stamp('ok');
          return;
        }

        // 服务没就绪就轮询重试：有些宿主在 apply 之后才把服务挂上来。
        let tries = 0;
        const timer = setInterval(() => {
          tries += 1;
          const svc = ctx.get ? ctx.get('slots') : undefined;
          if (attempt(svc)) {
            clearInterval(timer);
            stamp('ok-late');
          } else if (tries >= 40) {
            clearInterval(timer);
            stamp(`fail(${tries})`);
          }
        }, 250);
      };

      /**
       * 设置页新条目：放 her-memory 的开关，目前只有一个 —— 新对话随机刷新。
       */
      function SwitchPanel() {
        const { data } = useSnapshot(6000);
        const stores = data && Array.isArray(data.stores) ? data.stores : [];
        const s = stores.find((x) => x.key === '_shared') || stores[0] || null;
        const serverOff = s !== null && s.jitterOff === true;
        const [localOff, setLocalOff] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [openMsg, setOpenMsg] = React.useState('');
        const [opening, setOpening] = React.useState(false);
        const off = localOff === null ? serverOff : localOff;
        const personaPath = data && typeof data.personaPath === 'string' ? data.personaPath : '';

        const toggle = () => {
          if (busy) return;
          const wantOn = off; // 现在显示「已关闭」→ 点一下就是要开
          const key = s && typeof s.key === 'string' && s.key !== '' ? s.key : '_shared';
          setBusy(true);
          try {
            fetch(`/her-memory/jitter?key=${encodeURIComponent(key)}&on=${wantOn ? '1' : '0'}`, {
              method: 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
            })
              .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
              .then((j) => { if (j && j.ok === true) setLocalOff(j.jitterOff === true); })
              .catch(() => { /* 端点不通就不改；开关自己会退回服务端状态 */ })
              .finally(() => { try { setBusy(false); } catch { /* ignore */ } });
          } catch { setBusy(false); }
        };

        /**
         * 打开人设文件（2026-10-13 新增：别让用户自己去找路径）。
         * 路径由宿主自己算，客户端一个参数都不传；打不开也要把路径告诉用户。
         */
        const openPersona = () => {
          if (opening) return;
          setOpening(true);
          setOpenMsg('');
          try {
            fetch('/her-memory/open-persona', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
              .then((r) => r.json().then((j) => ({ ok: r.ok, j }), () => ({ ok: false, j: null })))
              .then(({ ok, j }) => {
                if (ok && j && j.ok === true) setOpenMsg('已用系统默认程序打开 —— 改完保存，重启 DSH 生效。');
                else if (j && typeof j.path === 'string' && j.path !== '') setOpenMsg('没能自动打开，请手动打开上面这个路径。');
                else setOpenMsg('没能自动打开，请手动打开上面这个路径。');
              })
              .catch(() => { setOpenMsg('请求失败，请手动打开上面这个路径。'); })
              .finally(() => { try { setOpening(false); } catch { /* ignore */ } });
          } catch { setOpening(false); }
        };

        return e(
          'div',
          { id: 'herm-sw-scope' },
          e(
            'div',
            { className: 'herm-sw-card' },
            e(
              'div',
              { className: 'herm-sw-row' },
              e(
                'div',
                { className: 'herm-sw-text' },
                e('b', null, '新对话随机刷新'),
                e('span', null, '每 30 分钟算一次：离开多久就结算多少次，隔得越久回来时越「全新」（同一场对话里不会反复跳）。'),
              ),
              e(
                'button',
                {
                  type: 'button',
                  className: `herm-sw-btn${off ? '' : ' herm-sw-on'}`,
                  onClick: toggle,
                  disabled: busy,
                  'aria-pressed': off ? 'false' : 'true',
                  title: off ? '点击开启' : '点击关闭',
                },
                e('span', { className: 'herm-sw-knob' }),
              ),
            ),
            e(
              'div',
              { className: 'herm-sw-note' },
              off
                ? '当前：已关闭 —— 三个数值保持原样，不随新对话浮动。'
                : '当前：已开启 —— 每 30 分钟结算一次；离开越久，回来时变化越大（数值有下限 20，不会归零）。',
            ),
            e(
              'div',
              { className: 'herm-sw-row herm-sw-sep' },
              e(
                'div',
                { className: 'herm-sw-text' },
                e('b', null, '人设文件'),
                e(
                  'span',
                  { className: 'herm-sw-path' },
                  personaPath || '（没启用文件机制：人设写在 cordis.patch.yml 的 persona 里）',
                ),
              ),
              e(
                'button',
                { type: 'button', className: 'herm-sw-open', onClick: openPersona, disabled: opening },
                opening ? '打开中…' : '打开文件',
              ),
            ),
            e(
              'div',
              { className: 'herm-sw-note' },
              openMsg || '改完保存后重启 DSH 生效；人设文件不存在时点一下会自动补一份默认的。',
            ),
          ),
        );
      }

      reg('conversation.input.dock', 'her-memory-bar', 60, StatusBar, '记忆与心情');
      reg('settings.section', 'her-memory', 55, MemoryPanel, '记忆与心情');
      reg('settings.section', 'her-memory-switches', 57, SwitchPanel, 'her-memory 开关');

      /**
       * 动态测宽同步：把状态条宽度对齐到输入区的实际宽度。
       *
       * 为什么要它：光靠 CSS 做不到 ——
       *   撑满会挤坏 token-saver，按内容又太窄（你反馈过两次）。
       * 参考物取 token-saver 的状态条（.st-strip）：它就在输入区同一列，
       * 宽度等于输入框那一列的宽度，而且它自己不依赖我们，是个稳的基准。
       * 量不到就啥也不做，保持 CSS 兜底，绝不影响任何东西。
       */
      let widthTimer = null;
      const syncWidth = () => {
        try {
          const bar = document.getElementById('herm-bar-scope');
          if (bar === null) return;
          const ref = document.querySelector('.st-strip');
          if (ref === null || typeof ref.getBoundingClientRect !== 'function') return;
          const r = ref.getBoundingClientRect();
          const w = Math.round(r.width);
          // 合理区间保护：太窄或太宽都不采纳，避免把布局搞坏
          if (!Number.isFinite(w) || w < 320 || w > 2000) return;
          const px = `${w}px`;
          // 只写 min-width（当「不低于输入区宽度」的保底），宽度本身交给 max-content：
          //   内容比输入区窄 → 底板保持输入区那个宽度（不显得单薄）
          //   内容比输入区宽 → 底板跟着内容一起变长（内容永远不露在底板外）
          // ⛔ 别再改回「把 width 与 maxWidth 都钉成 px」的写法：
          //   那是 2026-10-13「记 N 露在底板外面」的直接原因（用户截图抓到）。
          if (bar.style.minWidth !== px) {
            bar.style.minWidth = px;
            bar.style.width = 'max-content';
            bar.style.maxWidth = 'none';
          }
        } catch { /* 量不到就算了，CSS 兜底 */ }
      };
      syncWidth();
      /**
       * ⛔ 2026-10-13 回滚记录（**别再改成事件驱动**）：
       *   试过把这里换成 `ResizeObserver`（想消掉「参考条一变宽、这边最多 1.5 秒才追上」的瞬时滞后），
       *   结果**把 token-saver 搞坏了**（它的状态条显示异常），本条状态条自己也被拉歪。
       *   **原因**：两者的状态条在输入区**同一列、宽度互相影响** —— 1.5 秒轮询慢速且能收敛，
       *   换成"变化即同步"就变成互相推着放大的反馈环。
       *   ⇒ 保持轮询。真要动，先换一个**不受本条影响**的参考物，并做双向影响验证。
       */
      widthTimer = setInterval(syncWidth, 1500);
      try {
        if (typeof window.addEventListener === 'function') window.addEventListener('resize', syncWidth);
      } catch { /* 没有事件系统也不影响（靠定时器兜底） */ }

      ctx.effect(() => () => {
        if (widthTimer !== null) clearInterval(widthTimer);
        try {
          if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', syncWidth);
        } catch { /* ignore */ }
        if (styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag);
      }, `${PLUGIN_ID} client cleanup`);

      console.log(`[${PLUGIN_ID}] client ready · 状态条 + 设置面板`);
    }

    const inject = [];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
