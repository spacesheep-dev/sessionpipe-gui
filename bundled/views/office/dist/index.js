// shims/react-dom-client.js
var createRoot = (...a) => globalThis.__sessionpipeThemeReact.createRoot(...a);

// shims/react.js
var R = () => globalThis.__sessionpipeThemeReact.React;
var useState = (...a) => R().useState(...a);
var useEffect = (...a) => R().useEffect(...a);
var useLayoutEffect = (...a) => R().useLayoutEffect(...a);
var useMemo = (...a) => R().useMemo(...a);
var useRef = (...a) => R().useRef(...a);
var useCallback = (...a) => R().useCallback(...a);
var useId = (...a) => R().useId(...a);
var useContext = (...a) => R().useContext(...a);
var useSyncExternalStore = (...a) => R().useSyncExternalStore(...a);
var createContext = (...a) => R().createContext(...a);
var createElement = (...a) => R().createElement(...a);
var Fragment = Symbol.for("react.fragment");

// shims/jsx-runtime.js
var jsx = (type, props, key) => createElement(type, key === void 0 ? props : { ...props, key });
var jsxs = jsx;

// src/api.tsx
var ctx = null;
var context = () => ctx ??= createContext(null);
function ApiProvider({ api, children }) {
  const C = context();
  return /* @__PURE__ */ jsx(C.Provider, { value: api, children });
}
function useApi() {
  const api = useContext(context());
  if (!api) throw new Error("ThemeApi missing: render inside <ApiProvider>");
  return api;
}
var sessionHref = (harness, id) => `/s/${encodeURIComponent(harness)}/${encodeURIComponent(id)}`;

// src/bits.tsx
var plainClick = (e) => !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
function SessionLink({ to, href, children, ...rest }) {
  const api = useApi();
  const onClick = (e) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    api.openSession(to);
  };
  return /* @__PURE__ */ jsx("a", { href, onClick, ...rest, children });
}
function NavLink({ to, children, ...rest }) {
  const api = useApi();
  const onClick = (e) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    api.navigate(to);
  };
  return /* @__PURE__ */ jsx("a", { href: to, onClick, ...rest, children });
}
function Segmented({
  value,
  options,
  onChange,
  label
}) {
  const name = useId();
  return /* @__PURE__ */ jsxs("fieldset", { className: "seg", children: [
    /* @__PURE__ */ jsx("legend", { className: "sr-only", children: label }),
    options.map((o) => /* @__PURE__ */ jsxs("label", { className: `seg-opt ${o.value === value ? "seg-on" : ""}`, title: o.title, children: [
      /* @__PURE__ */ jsx(
        "input",
        {
          type: "radio",
          name,
          value: String(o.value),
          checked: o.value === value,
          onChange: () => onChange(o.value),
          className: "sr-only"
        }
      ),
      o.label
    ] }, String(o.value)))
  ] });
}
var REDACTED = /(\[redacted\])/gi;
function Redacted({ text }) {
  if (!REDACTED.test(text)) return /* @__PURE__ */ jsx(Fragment, { children: text });
  REDACTED.lastIndex = 0;
  const parts = text.split(REDACTED);
  return /* @__PURE__ */ jsx(Fragment, { children: parts.map(
    (p, i) => REDACTED.test(p) ? /* @__PURE__ */ jsx("mark", { title: "Removed on the sending machine by the secrets ruleset", children: p }, i) : /* @__PURE__ */ jsx("span", { children: p }, i)
  ) });
}

// ../shared-types/api.ts
var STALE_AFTER_MS = 10 * 6e4;
var DONE_AFTER_MS = 24 * 36e5;
var SESSION_STATES = ["needs_you", "working", "stale", "idle", "done"];
var SLOW_TOOL_MS = 3 * 6e4;
var COMPACTING_WINDOW_MS = 30 * 6e4;
var EMPTY_LABELS = Object.freeze({ rev: 0, names: {}, sessions: {} });
var ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

// src/hooks.ts
function useSnapshot(api) {
  return useSyncExternalStore(api.state.subscribe, api.state.get, api.state.get);
}
var STATE_RANK = Object.fromEntries(SESSION_STATES.map((s, i) => [s, i]));
var byStateThenRecent = (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastAt.localeCompare(a.lastAt);
function useSessionTree(sessions) {
  return useMemo(() => {
    const all = [...sessions.values()];
    const childrenOf = /* @__PURE__ */ new Map();
    const roots = [];
    for (const s of all) {
      if (s.parentId) {
        const pk = `${s.harness}:${s.parentId}`;
        if (sessions.has(pk)) {
          const list = childrenOf.get(pk) ?? [];
          list.push(s);
          childrenOf.set(pk, list);
          continue;
        }
      }
      roots.push(s);
    }
    roots.sort(byStateThenRecent);
    for (const list of childrenOf.values()) list.sort(byStateThenRecent);
    return { all, roots, childrenOf };
  }, [sessions]);
}
var now = Date.now();
var listeners = /* @__PURE__ */ new Set();
var timer = null;
var subscribeNow = (l) => {
  listeners.add(l);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      for (const fn of listeners) fn();
    }, 1e3);
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
};
function useNow() {
  return useSyncExternalStore(
    subscribeNow,
    () => now,
    () => now
  );
}
function useContainerWidth(ref) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      setWidth(Math.max(0, el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
function usePageHidden() {
  return useSyncExternalStore(
    (l) => {
      document.addEventListener("visibilitychange", l);
      return () => document.removeEventListener("visibilitychange", l);
    },
    () => document.hidden,
    () => false
  );
}

// src/format.ts
var STATE_LABEL = {
  needs_you: "needs you",
  working: "working",
  stale: "stale",
  idle: "idle",
  done: "done"
};
var STATE_HINT = {
  needs_you: "A permission, a question or an error is waiting for an answer.",
  working: "A turn is running and events are still arriving.",
  stale: "A turn started but nothing has arrived for over ten minutes.",
  idle: "The last turn ended; the session is open and waiting for a prompt.",
  done: "Ended, or silent for six hours, or only known from backfill."
};
var ATTENTION_LABEL = {
  permission: "permission",
  question: "question",
  elicitation: "input wanted",
  idle: "idle prompt",
  error: "error"
};
var HARNESSES = {
  "claude-code": { glyph: "Cl", label: "Claude Code", hue: 40 },
  codex: { glyph: "Cx", label: "Codex", hue: 150 },
  "gemini-cli": { glyph: "Ge", label: "Gemini CLI", hue: 265 },
  antigravity: { glyph: "Ag", label: "Antigravity", hue: 300 },
  cursor: { glyph: "Cu", label: "Cursor", hue: 200 },
  "copilot-cli": { glyph: "Cp", label: "Copilot CLI", hue: 230 },
  droid: { glyph: "Dr", label: "Droid", hue: 120 },
  kiro: { glyph: "Ki", label: "Kiro", hue: 330 },
  opencode: { glyph: "Oc", label: "OpenCode", hue: 180 },
  conformance: { glyph: "Cf", label: "conformance", hue: 0 }
};
function harnessMark(name) {
  const known = HARNESSES[name];
  if (known) return known;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const letters = name.split(/[-_.]/).map((p) => p[0] ?? "").join("").slice(0, 2);
  return { glyph: letters ? letters[0].toUpperCase() + (letters[1] ?? "") : "?", label: name, hue: h };
}
function modelShort(model) {
  if (!model) return "";
  let m = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  m = m.replace(/(\d)-(\d)/g, "$1.$2");
  return m.replace(/-/g, " ");
}
var durShort = (api, ms) => api.format.duration(ms).replace(/ /g, "");
function since(api, iso, at) {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? "" : api.format.duration(at - t);
}

// src/iso.ts
var K = 20;
var COL = 8;
var ROW = 3;
var WALL_H = 6;
var PLATE_H = 6;
var LABEL = { x: -K, y: 1.5 * K + 8 };
var HIT = { x: -30, y: -34, w: 160, h: 96 };
var HIT_POLY = "0,38 28,0 72,24 72,60 58,72 160,72 160,96 10,96";
var pt = (u, v, h = 0) => ({ x: (u - v) * K, y: (u + v) * K / 2 - h });
var fmt = (n) => Number.isInteger(n) ? String(n) : n.toFixed(2);
var pts = (list) => list.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
var top = (u0, v0, u1, v1, h) => pts([pt(u0, v0, h), pt(u1, v0, h), pt(u1, v1, h), pt(u0, v1, h)]);
var faceV = (u0, u1, v, h0, h1) => pts([pt(u0, v, h0), pt(u1, v, h0), pt(u1, v, h1), pt(u0, v, h1)]);
var faceU = (u, v0, v1, h0, h1) => pts([pt(u, v0, h0), pt(u, v1, h0), pt(u, v1, h1), pt(u, v0, h1)]);
var slotCell = (slot, cols) => ({ col: slot % cols, row: Math.floor(slot / cols) });
var slotOrigin = (slot, cols) => {
  const { col, row } = slotCell(slot, cols);
  return { u: 1 + col * COL, v: 1 + row * ROW };
};
function layout(cols, rows) {
  const U = cols * COL;
  const V = rows * ROW + 1.5;
  const origin = { x: V * K, y: WALL_H + 6 };
  return {
    cols,
    rows,
    U,
    V,
    w: (U + V) * K,
    h: origin.y + (U + V) * K / 2 + PLATE_H,
    origin,
    door: U - 2
  };
}
var cellOrigin = (l, slot) => {
  const { u, v } = slotOrigin(slot, l.cols);
  const p = pt(u, v);
  return { x: l.origin.x + p.x, y: l.origin.y + p.y };
};
function walkPath(l, slot) {
  const { u, v } = slotOrigin(slot, l.cols);
  const seat = pt(u + 1, v + 1.62);
  const door = pt(l.door + 0.5, 0.6);
  const corner = pt(u + 1, 0.6);
  return {
    door: { x: door.x - seat.x, y: door.y - seat.y },
    corner: { x: corner.x - seat.x, y: corner.y - seat.y }
  };
}

// src/posture.ts
var SCREEN_BY_STATE = {
  working: "lit",
  needs_you: "dim",
  stale: "off",
  idle: "off",
  done: "off"
};
var MAX_HELPERS = 2;
var TYPING_WINDOW_MS = 3e3;
var LONG_RUNNING_MS = 6e4;
var growth = /* @__PURE__ */ new Map();
function sheets(errors) {
  if (errors <= 0) return 0;
  if (errors <= 2) return 1;
  if (errors <= 5) return 2;
  return 3;
}
function derivePosture(s, children, now2, phase = "seated") {
  const len = s.progress?.assistant?.length ?? 0;
  const prev = growth.get(s.key);
  let grewAt = prev?.grewAt ?? 0;
  if (!prev) grewAt = len > 0 ? now2 : 0;
  else if (len > prev.len) grewAt = now2;
  growth.set(s.key, { len, grewAt });
  const live = (children ?? []).filter((c) => c.state !== "done");
  const helpers = live.slice(0, MAX_HELPERS);
  const hidden = live.length > MAX_HELPERS ? live.length - MAX_HELPERS : live.length === 0 ? s.children : 0;
  const toolMs = s.currentTool ? now2 - Date.parse(s.currentTool.since) : 0;
  return {
    state: s.state,
    typing: s.state === "working" && !s.currentTool && now2 - grewAt < TYPING_WINDOW_MS,
    screen: phase === "seated" ? SCREEN_BY_STATE[s.state] : "off",
    tool: s.state === "working" ? s.currentTool?.tool : void 0,
    elapsedMs: s.state === "working" && toolMs > LONG_RUNNING_MS ? toolMs : s.state === "stale" ? Math.max(0, now2 - Date.parse(s.stateSince)) : void 0,
    errors: sheets(s.counts.toolErrors),
    attention: s.state === "needs_you" ? s.openAttentions[0] : void 0,
    helpers,
    hiddenHelpers: hidden,
    phase,
    look: lookOf(s.id)
  };
}
function fnv1a(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function lookOf(id) {
  const h = fnv1a(id);
  return {
    shirt: h % 6,
    hair: h >>> 3 & 3,
    hairColour: h >>> 5 & 1,
    skin: h >>> 6 & 1,
    glasses: (h >>> 7 & 3) === 0
  };
}
function screenText(tool, max = 5) {
  if (!tool) return "";
  return tool.length > max ? `${tool.slice(0, max - 1)}\u2026` : tool;
}
function cutLeft(text, max) {
  return text.length > max ? `\u2026${text.slice(-(max - 1))}` : text;
}
var SLOTS_KEY = "slots";
function readSlots(api) {
  const v = api.local.get(SLOTS_KEY);
  return v && typeof v === "object" ? v : {};
}
function useSeating(api, occupied) {
  const slots = useRef(null);
  if (slots.current === null) slots.current = readSlots(api);
  return useMemo(() => {
    const all = slots.current;
    const out = /* @__PURE__ */ new Map();
    let changed = false;
    const rooms = new Set(occupied.map((o) => o.room));
    for (const room of Object.keys(all)) {
      if (!rooms.has(room)) {
        delete all[room];
        changed = true;
      }
    }
    for (const { room, keys } of occupied) {
      const seated = all[room] ?? {};
      const keep = new Set(keys);
      for (const k of Object.keys(seated)) {
        if (!keep.has(k)) {
          delete seated[k];
          changed = true;
        }
      }
      const taken = new Set(Object.values(seated));
      for (const k of keys) {
        if (seated[k] === void 0) {
          let i = 0;
          while (taken.has(i)) i++;
          seated[k] = i;
          taken.add(i);
          changed = true;
        }
        out.set(k, seated[k]);
      }
      all[room] = seated;
    }
    if (changed) api.local.set(SLOTS_KEY, all);
    return out;
  }, [api, occupied]);
}
var MAX_WALKS = 6;
var MAX_TYPING = 12;
var WALK_MS = 800;
var walks = [];
function reserveWalk(now2) {
  while (walks.length && walks[0] < now2 - WALK_MS) walks.shift();
  if (walks.length >= MAX_WALKS) return false;
  walks.push(now2);
  return true;
}
function hourBand(at) {
  const h = new Date(at).getHours();
  if (h >= 6 && h < 11) return "morning";
  if (h >= 11 && h < 17) return "day";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

// shims/react-dom.js
var createPortal = (...a) => globalThis.__sessionpipeThemeReact.ReactDOM.createPortal(...a);

// src/parts.tsx
var CELL_W = 150;
var CELL_H = 120;
var HEAD = { x: 48, y: 44 };
var FEET = { x: 48, y: 70 };
var arm = (x1, y1, x2, y2, key, w = 2.2) => /* @__PURE__ */ jsxs("g", { children: [
  /* @__PURE__ */ jsx("line", { x1, y1, x2, y2, stroke: "var(--look-shirt)", strokeWidth: w, strokeLinecap: "round" }),
  /* @__PURE__ */ jsx("circle", { cx: x2, cy: y2 - 0.3, r: "1.5", fill: "var(--look-skin)" })
] }, key);
function OfficeDefs() {
  return /* @__PURE__ */ jsx("svg", { className: "office-defs", width: "0", height: "0", "aria-hidden": "true", focusable: "false", children: /* @__PURE__ */ jsxs("defs", { children: [
    /* @__PURE__ */ jsxs("symbol", { id: "o-desk", overflow: "visible", children: [
      /* @__PURE__ */ jsx("rect", { x: "0", y: "30", width: "96", height: "14", rx: "1", fill: "var(--o-top)" }),
      /* @__PURE__ */ jsx("rect", { x: "0", y: "42", width: "96", height: "2", fill: "var(--o-edge)" }),
      /* @__PURE__ */ jsx("rect", { x: "38", y: "36.5", width: "20", height: "3", rx: "1", fill: "var(--o-wood)" })
    ] }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-monitor", overflow: "visible", children: [
      /* @__PURE__ */ jsx("rect", { x: "35", y: "14", width: "26", height: "18", rx: "1", fill: "var(--o-wood)" }),
      /* @__PURE__ */ jsx("rect", { x: "47", y: "32", width: "2", height: "2", fill: "var(--o-wood)" }),
      /* @__PURE__ */ jsx("rect", { x: "43", y: "34", width: "10", height: "1.5", rx: "0.5", fill: "var(--o-wood)" })
    ] }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-lamp", overflow: "visible", children: [
      /* @__PURE__ */ jsx("rect", { x: "66", y: "33", width: "8", height: "1.5", rx: "0.5", fill: "var(--o-wood)" }),
      /* @__PURE__ */ jsx("rect", { x: "69.25", y: "12", width: "1.5", height: "21", fill: "var(--o-wood)" }),
      /* @__PURE__ */ jsx("line", { x1: "70", y1: "13", x2: "66", y2: "9", stroke: "var(--o-wood)", strokeWidth: "1.5", strokeLinecap: "round" }),
      /* @__PURE__ */ jsx(
        "path",
        {
          d: "M60 4 h10 l1.5 5 h-13 z",
          fill: "var(--o-needs)",
          stroke: "var(--o-needs)",
          strokeWidth: "1",
          strokeLinejoin: "round"
        }
      )
    ] }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-mug", overflow: "visible", children: [
      /* @__PURE__ */ jsx("rect", { x: "0", y: "0", width: "5", height: "6", rx: "0.8", fill: "var(--o-wood)" }),
      /* @__PURE__ */ jsx("path", { d: "M5 1.5 h1.2 a1.5 1.5 0 0 1 0 3 h-1.2", fill: "none", stroke: "var(--o-wood)", strokeWidth: "0.9" })
    ] }),
    /* @__PURE__ */ jsx("symbol", { id: "o-chair", overflow: "visible", children: /* @__PURE__ */ jsx("rect", { x: "42", y: "56", width: "12", height: "10", rx: "3", fill: "var(--o-chair)" }) }),
    /* @__PURE__ */ jsx("symbol", { id: "o-chair-in", overflow: "visible", children: /* @__PURE__ */ jsx("rect", { x: "42", y: "44", width: "12", height: "9", rx: "3", fill: "var(--o-chair)" }) }),
    /* @__PURE__ */ jsx("symbol", { id: "o-sheet", overflow: "visible", children: /* @__PURE__ */ jsx(
      "rect",
      {
        x: "0",
        y: "0",
        width: "6",
        height: "4",
        rx: "0.5",
        fill: "var(--o-sheet)",
        stroke: "var(--o-wood)",
        strokeWidth: "0.6"
      }
    ) }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-side", overflow: "visible", children: [
      /* @__PURE__ */ jsx("rect", { x: "118", y: "38", width: "36", height: "10", rx: "1", fill: "var(--o-top)" }),
      /* @__PURE__ */ jsx("rect", { x: "118", y: "46", width: "36", height: "2", fill: "var(--o-edge)" }),
      /* @__PURE__ */ jsx("rect", { x: "124", y: "30", width: "12", height: "8.5", rx: "1", fill: "var(--o-wood)" })
    ] }),
    /* @__PURE__ */ jsx("symbol", { id: "o-stool", overflow: "visible", children: /* @__PURE__ */ jsx("rect", { x: "0", y: "0", width: "10", height: "3", rx: "1.5", fill: "var(--o-chair)" }) }),
    /* @__PURE__ */ jsx("symbol", { id: "o-plant", overflow: "visible", children: /* @__PURE__ */ jsx("circle", { cx: "5", cy: "5", r: "5", fill: "var(--o-leaf)" }) }),
    /* @__PURE__ */ jsx("symbol", { id: "o-clock", overflow: "visible", children: /* @__PURE__ */ jsx("circle", { cx: "6", cy: "6", r: "5.3", fill: "none", stroke: "var(--o-wood)", strokeWidth: "1" }) }),
    /* @__PURE__ */ jsx("symbol", { id: "o-head", overflow: "visible", children: /* @__PURE__ */ jsx("circle", { cx: "0", cy: "0", r: "3.5", fill: "var(--look-skin)" }) }),
    /* @__PURE__ */ jsx("symbol", { id: "o-hair-0", overflow: "visible", children: /* @__PURE__ */ jsx("path", { d: "M-3.5 0 a3.5 3.5 0 1 1 7 0 v1.6 h-7 z", fill: "var(--look-hair)" }) }),
    /* @__PURE__ */ jsx("symbol", { id: "o-hair-1", overflow: "visible", children: /* @__PURE__ */ jsx("path", { d: "M-3.5 0 a3.5 3.5 0 1 1 7 0 l2 1.6 h-9 z", fill: "var(--look-hair)" }) }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-hair-2", overflow: "visible", children: [
      /* @__PURE__ */ jsx("path", { d: "M-3.5 0 a3.5 3.5 0 1 1 7 0 v1 h-7 z", fill: "var(--look-hair)" }),
      /* @__PURE__ */ jsx("circle", { cx: "0", cy: "1.8", r: "2", fill: "var(--look-hair)" })
    ] }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-hair-3", overflow: "visible", children: [
      /* @__PURE__ */ jsx("circle", { cx: "0", cy: "-0.3", r: "4.4", fill: "var(--look-hair)" }),
      /* @__PURE__ */ jsx("circle", { cx: "-3.6", cy: "-2.6", r: "1.4", fill: "var(--look-hair)" }),
      /* @__PURE__ */ jsx("circle", { cx: "3.6", cy: "-2.6", r: "1.4", fill: "var(--look-hair)" }),
      /* @__PURE__ */ jsx("circle", { cx: "0", cy: "-4.6", r: "1.4", fill: "var(--look-hair)" }),
      /* @__PURE__ */ jsx("circle", { cx: "-4.4", cy: "0.8", r: "1.3", fill: "var(--look-hair)" }),
      /* @__PURE__ */ jsx("circle", { cx: "4.4", cy: "0.8", r: "1.3", fill: "var(--look-hair)" })
    ] }),
    /* @__PURE__ */ jsx("symbol", { id: "o-glasses", overflow: "visible", children: /* @__PURE__ */ jsx("line", { x1: "3.2", y1: "-0.4", x2: "5.2", y2: "-1", stroke: "var(--fg)", strokeWidth: "1", strokeLinecap: "round" }) }),
    /* @__PURE__ */ jsx("symbol", { id: "o-neck", overflow: "visible", children: /* @__PURE__ */ jsx("rect", { x: "-1", y: "2.6", width: "2", height: "1.4", fill: "var(--look-skin)" }) }),
    /* @__PURE__ */ jsx("symbol", { id: "o-torso", overflow: "visible", children: /* @__PURE__ */ jsx("path", { d: "M-6 7 a3 3 0 0 1 3 -4 h6 a3 3 0 0 1 3 4 v0.5 l-1 7.5 h-10 l-1 -7.5 z", fill: "var(--look-shirt)" }) }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-arm-key", overflow: "visible", children: [
      /* @__PURE__ */ jsx("line", { x1: "-4.5", y1: "6", x2: "-3", y2: "1", stroke: "var(--look-shirt)", strokeWidth: "1", strokeLinecap: "round" }),
      arm(4.5, 6, 1, -6.5, "r")
    ] }),
    /* @__PURE__ */ jsx("symbol", { id: "o-arm-mug", overflow: "visible", children: arm(4.5, 6, 8, 0, "r") }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-arms-desk", overflow: "visible", children: [
      arm(-4.5, 5, -7, -6, "l"),
      arm(4.5, 5, 7, -6, "r")
    ] }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-stand", overflow: "visible", children: [
      /* @__PURE__ */ jsx("rect", { x: "-1", y: "-19.4", width: "2", height: "1.4", fill: "var(--look-skin)" }),
      /* @__PURE__ */ jsx("path", { d: "M-6 -15 a3 3 0 0 1 3 -4 h6 a3 3 0 0 1 3 4 v0.5 l-1 8.5 h-10 l-1 -8.5 z", fill: "var(--look-shirt)" })
    ] }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-legs", overflow: "visible", children: [
      /* @__PURE__ */ jsx(
        "line",
        {
          x1: "-2.5",
          y1: "-6",
          x2: "-2.5",
          y2: "0",
          stroke: "var(--look-trouser)",
          strokeWidth: "2.4",
          strokeLinecap: "round"
        }
      ),
      /* @__PURE__ */ jsx("line", { x1: "2.5", y1: "-6", x2: "2.5", y2: "0", stroke: "var(--look-trouser)", strokeWidth: "2.4", strokeLinecap: "round" })
    ] }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-legs-a", overflow: "visible", children: [
      /* @__PURE__ */ jsx(
        "line",
        {
          x1: "-2.5",
          y1: "-6",
          x2: "-4.5",
          y2: "0",
          stroke: "var(--look-trouser)",
          strokeWidth: "2.4",
          strokeLinecap: "round"
        }
      ),
      /* @__PURE__ */ jsx("line", { x1: "2.5", y1: "-6", x2: "4.5", y2: "0", stroke: "var(--look-trouser)", strokeWidth: "2.4", strokeLinecap: "round" })
    ] }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-legs-b", overflow: "visible", children: [
      /* @__PURE__ */ jsx(
        "line",
        {
          x1: "-2.5",
          y1: "-6",
          x2: "-0.5",
          y2: "0",
          stroke: "var(--look-trouser)",
          strokeWidth: "2.4",
          strokeLinecap: "round"
        }
      ),
      /* @__PURE__ */ jsx("line", { x1: "2.5", y1: "-6", x2: "0.5", y2: "0", stroke: "var(--look-trouser)", strokeWidth: "2.4", strokeLinecap: "round" })
    ] }),
    /* @__PURE__ */ jsx("symbol", { id: "o-arm-up", overflow: "visible", children: arm(5, -16, 9, -23, "r") }),
    /* @__PURE__ */ jsx("symbol", { id: "o-arm-down", overflow: "visible", children: arm(-5, -16, -5.5, -8, "l", 1.6) }),
    /* @__PURE__ */ jsxs("symbol", { id: "o-arms-stand", overflow: "visible", children: [
      arm(-5, -16, -5.5, -8, "l", 1.6),
      arm(5, -16, 5.5, -8, "r", 1.6)
    ] })
  ] }) });
}

// src/Worker.tsx
var DOOR_X = 16 + 9;
var TITLE_LINE = 26;
var TIP_DELAY_MS = 150;
var DESK_X = 8;
var SIDE_SHIFT = 112 - 118 - DESK_X;
var plural = (n, word) => n ? `${n} ${word}${n === 1 ? "" : "s"}` : "";
var lookClass = (l) => `look-s${l.shirt % 3} look-k${l.skin}`;
var cellLabel = (title, p) => [title, STATE_LABEL[p.state], p.tool ?? (p.attention ? ATTENTION_LABEL[p.attention.kind] : "")].filter(Boolean).join(", ");
function Cell({ s, p, slot, pos, now: now2, walk, cursor, helperCursor }) {
  const api = useApi();
  const title = api.format.title(s);
  const mark = harnessMark(s.harness);
  const dxDesk = DESK_X;
  const sideShift = SIDE_SHIFT;
  const feetX = pos.left + dxDesk + FEET.x;
  const style = {
    "--left": `${pos.left}px`,
    "--bottom": `${pos.bottom}px`,
    "--slot4": slot % 4,
    "--slot3": slot % 3,
    "--dx": `${pos.doorX - feetX}px`,
    "--dx2": `${pos.aisleX - feetX}px`,
    "--dy": `${pos.aisleY - FEET.y}px`,
    "--bx": `${dxDesk + FEET.x + 10}px`,
    "--by": "30px",
    "--hx": `${dxDesk + sideShift + 112}px`
  };
  const classes = [
    "cell",
    "cell--figures",
    `cell--${p.state}`,
    `cell--${p.phase}`,
    walk ? "" : "cell--nowalk",
    p.typing ? "cell--typing" : "",
    lookClass(p.look)
  ].filter(Boolean).join(" ");
  const lead = p.helpers[0];
  return /* @__PURE__ */ jsxs("div", { className: classes, style, "data-cursor": cursor !== void 0 ? String(cursor) : void 0, children: [
    /* @__PURE__ */ jsxs(
      SessionLink,
      {
        to: s.key,
        href: sessionHref(s.harness, s.id),
        className: "cell-link",
        "aria-label": cellLabel(title, p),
        children: [
          /* @__PURE__ */ jsx("svg", { className: "cell-art", viewBox: `0 0 ${CELL_W} ${CELL_H}`, width: CELL_W, height: CELL_H, "aria-hidden": "true", children: /* @__PURE__ */ jsxs("g", { transform: `translate(${dxDesk} 0)`, children: [
            /* @__PURE__ */ jsx("use", { href: "#o-desk" }),
            p.phase === "gone" && /* @__PURE__ */ jsx("use", { href: "#o-chair-in", className: "cell-chair-in" }),
            /* @__PURE__ */ jsx("use", { href: "#o-monitor" }),
            /* @__PURE__ */ jsx("rect", { className: `cell-screen cell-screen--${p.screen}`, x: "36", y: "15", width: "24", height: "16" }),
            p.screen === "lit" && /* @__PURE__ */ jsxs("g", { className: "cell-lines", clipPath: "url(#o-screen-clip)", children: [
              /* @__PURE__ */ jsx("rect", { x: "38", y: "18", width: "14", height: "1" }),
              /* @__PURE__ */ jsx("rect", { x: "38", y: "22", width: "9", height: "1" }),
              /* @__PURE__ */ jsx("rect", { x: "38", y: "26", width: "11", height: "1" }),
              /* @__PURE__ */ jsx("rect", { x: "38", y: "30", width: "13", height: "1" })
            ] }),
            p.tool && p.screen === "lit" && /* @__PURE__ */ jsx("text", { className: "cell-tool", x: "48", y: "25.5", textAnchor: "middle", children: screenText(p.tool) }, p.tool),
            /* @__PURE__ */ jsx("text", { className: "cell-mono", x: "78", y: "41", textAnchor: "middle", children: mark.glyph }),
            p.state === "needs_you" && /* @__PURE__ */ jsx("use", { href: "#o-lamp", className: "cell-lamp cell-lamp--on" }),
            Array.from({ length: p.errors }, (_, i) => /* @__PURE__ */ jsx(
              "use",
              {
                href: "#o-sheet",
                className: `cell-sheet ${i === p.errors - 1 ? "cell-sheet--top" : ""}`,
                x: 2 + i,
                y: 38 - i
              },
              i === p.errors - 1 ? `top-${s.counts.toolErrors}` : i
            )),
            (p.helpers.length > 0 || p.hiddenHelpers > 0) && p.phase !== "gone" && /* @__PURE__ */ jsxs("g", { transform: `translate(${sideShift} 0)`, children: [
              p.helpers.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [
                /* @__PURE__ */ jsx("use", { href: "#o-side" }),
                /* @__PURE__ */ jsx(
                  "rect",
                  {
                    className: `cell-lid ${lead?.state === "working" ? "cell-lid--lit" : ""}`,
                    x: "125",
                    y: "31",
                    width: "10",
                    height: "6.5"
                  }
                )
              ] }),
              p.hiddenHelpers > 0 && /* @__PURE__ */ jsxs(
                "text",
                {
                  className: "cell-more",
                  x: p.helpers.length ? 151 : 94 - sideShift,
                  y: p.helpers.length ? 45 : 28,
                  textAnchor: "end",
                  children: [
                    "+",
                    p.hiddenHelpers
                  ]
                }
              )
            ] }),
            p.phase !== "gone" && /* @__PURE__ */ jsx("g", { className: "seated", children: /* @__PURE__ */ jsx(Seated, { p }) }),
            (p.phase === "arriving" || p.phase === "leaving") && /* @__PURE__ */ jsx("g", { transform: `translate(${FEET.x} ${FEET.y})`, children: /* @__PURE__ */ jsx("g", { className: "walker", children: /* @__PURE__ */ jsx(Standing, { look: p.look, walking: true }) }) })
          ] }) }),
          p.attention && /* @__PURE__ */ jsx("span", { className: "cell-bubble", children: ATTENTION_LABEL[p.attention.kind] ?? p.attention.kind }, p.attention.attentionId),
          /* @__PURE__ */ jsx(Nameplate, { s, p }),
          /* @__PURE__ */ jsx(Tooltip, { s, p, now: now2 })
        ]
      }
    ),
    p.phase !== "gone" && p.helpers.map((c, i) => /* @__PURE__ */ jsx(Helper, { c, i, now: now2, cursor: helperCursor?.(i) }, c.key)).reverse()
  ] });
}
function Nameplate({ s, p }) {
  const api = useApi();
  const title = api.format.title(s);
  const repo = api.format.repoBranch(s);
  const fits = title.length <= TITLE_LINE;
  return /* @__PURE__ */ jsxs("span", { className: "cell-plate", children: [
    /* @__PURE__ */ jsxs("span", { className: "plate-row", children: [
      /* @__PURE__ */ jsx("span", { className: `plate-title ${fits ? "" : "plate-title--two"}`, children: title }),
      p.elapsedMs !== void 0 && p.phase === "seated" && /* @__PURE__ */ jsx("span", { className: "plate-elapsed num", children: durShort(api, p.elapsedMs) })
    ] }),
    fits && repo && /* @__PURE__ */ jsx("span", { className: "plate-repo", children: cutLeft(repo, 24) })
  ] });
}
function Tooltip({ s, p, now: now2, helper }) {
  const api = useApi();
  const mark = harnessMark(s.harness);
  const repo = api.format.repoBranch(s);
  const anchor = useRef(null);
  const card = useRef(null);
  const [at, setAt] = useState(null);
  useEffect(() => {
    const host = anchor.current?.parentElement;
    if (!host) return;
    let timer2 = null;
    const show = () => {
      if (timer2) clearTimeout(timer2);
      timer2 = setTimeout(() => {
        const r = host.getBoundingClientRect();
        setAt({ x: r.left, y: r.bottom + 2, above: r.top - 2 });
      }, TIP_DELAY_MS);
    };
    const hide = () => {
      if (timer2) clearTimeout(timer2);
      timer2 = null;
      setAt(null);
    };
    host.addEventListener("mouseenter", show);
    host.addEventListener("mouseleave", hide);
    host.addEventListener("focusin", show);
    host.addEventListener("focusout", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      if (timer2) clearTimeout(timer2);
      host.removeEventListener("mouseenter", show);
      host.removeEventListener("mouseleave", hide);
      host.removeEventListener("focusin", show);
      host.removeEventListener("focusout", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || !at) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(at.x, window.innerWidth - 8 - r.width));
    const y = at.y + r.height > window.innerHeight - 8 ? Math.max(8, at.above - r.height) : at.y;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.style.visibility = "visible";
  }, [at]);
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("span", { ref: anchor, className: "tip-anchor", "aria-hidden": "true" }),
    at && createPortal(
      /* @__PURE__ */ jsxs("div", { ref: card, className: "sp-office-tip", role: "tooltip", style: { visibility: "hidden" }, children: [
        /* @__PURE__ */ jsx("b", { children: api.format.title(s) }),
        /* @__PURE__ */ jsxs("span", { children: [
          helper ? "subagent \xB7 " : "",
          mark.label,
          s.model ? ` \xB7 ${modelShort(s.model)}` : ""
        ] }),
        /* @__PURE__ */ jsxs("span", { children: [
          STATE_LABEL[p.state],
          " \xB7 ",
          since(api, s.stateSince, now2)
        ] }),
        s.currentTool && /* @__PURE__ */ jsxs("span", { children: [
          /* @__PURE__ */ jsx("code", { children: s.currentTool.tool }),
          " \xB7 ",
          since(api, s.currentTool.since, now2)
        ] }),
        p.attention && /* @__PURE__ */ jsxs("span", { className: "tip-attn", children: [
          ATTENTION_LABEL[p.attention.kind] ?? p.attention.kind,
          p.attention.message ? /* @__PURE__ */ jsxs(Fragment, { children: [
            " \xB7 ",
            /* @__PURE__ */ jsx(Redacted, { text: p.attention.message })
          ] }) : null
        ] }),
        repo && /* @__PURE__ */ jsx("span", { className: "mono", children: repo }),
        /* @__PURE__ */ jsx("span", { className: "num", children: [
          plural(s.counts.turns, "turn"),
          plural(s.counts.tools, "tool"),
          plural(s.counts.toolErrors, "error"),
          plural(s.counts.filesChanged, "file"),
          plural(s.children, "subagent")
        ].filter(Boolean).join(" \xB7 ") })
      ] }),
      document.body
    )
  ] });
}
function Head({ look }) {
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("use", { href: "#o-head" }),
    /* @__PURE__ */ jsx("use", { href: `#o-hair-${look.hair}` }),
    look.glasses && /* @__PURE__ */ jsx("use", { href: "#o-glasses" })
  ] });
}
function Seated({ p }) {
  const { look } = p;
  switch (p.state) {
    case "working":
      return /* @__PURE__ */ jsxs("g", { className: "fig fig--in", children: [
        /* @__PURE__ */ jsx("use", { href: "#o-chair" }),
        /* @__PURE__ */ jsxs("g", { transform: `translate(${HEAD.x} ${HEAD.y + 2})`, children: [
          /* @__PURE__ */ jsx("use", { href: "#o-torso" }),
          /* @__PURE__ */ jsx("use", { href: "#o-neck" }),
          /* @__PURE__ */ jsx(Head, { look }),
          /* @__PURE__ */ jsx("g", { className: "hands", children: /* @__PURE__ */ jsx("use", { href: "#o-arm-key" }) })
        ] })
      ] });
    case "needs_you":
      return /* @__PURE__ */ jsxs("g", { className: "fig fig--up", children: [
        /* @__PURE__ */ jsx("use", { href: "#o-chair" }),
        /* @__PURE__ */ jsx("g", { className: "stander", transform: `translate(${FEET.x + 24} ${FEET.y})`, children: /* @__PURE__ */ jsx(Standing, { look, raised: true }) })
      ] });
    case "stale":
      return /* @__PURE__ */ jsxs("g", { className: "fig fig--down", children: [
        /* @__PURE__ */ jsx("use", { href: "#o-chair" }),
        /* @__PURE__ */ jsxs("g", { transform: `translate(${HEAD.x} ${HEAD.y - 3})`, children: [
          /* @__PURE__ */ jsx("use", { href: "#o-torso", transform: "translate(0 -2) scale(1 1.4)" }),
          /* @__PURE__ */ jsx("use", { href: "#o-arms-desk" }),
          /* @__PURE__ */ jsxs("g", { className: "head-down", children: [
            /* @__PURE__ */ jsx("use", { href: "#o-neck", transform: "translate(0 -1)" }),
            /* @__PURE__ */ jsx(Head, { look })
          ] }),
          /* @__PURE__ */ jsx("text", { className: "cell-z", x: "7", y: "-8", children: "z" })
        ] })
      ] });
    default:
      return /* @__PURE__ */ jsxs("g", { className: "fig fig--back", children: [
        /* @__PURE__ */ jsx("use", { href: "#o-chair" }),
        /* @__PURE__ */ jsxs("g", { transform: `translate(${HEAD.x} ${HEAD.y - 2})`, children: [
          /* @__PURE__ */ jsx("use", { href: "#o-torso", transform: "scale(1 1.08)" }),
          /* @__PURE__ */ jsx("use", { href: "#o-neck" }),
          /* @__PURE__ */ jsx(Head, { look }),
          /* @__PURE__ */ jsx("use", { href: "#o-arm-mug" }),
          /* @__PURE__ */ jsx("use", { href: "#o-mug", className: "cell-mug-hand", x: "7", y: "-6" })
        ] })
      ] });
  }
}
function Standing({ look, walking, raised }) {
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    walking ? /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("use", { href: "#o-legs-a", className: "legs-a" }),
      /* @__PURE__ */ jsx("use", { href: "#o-legs-b", className: "legs-b" })
    ] }) : /* @__PURE__ */ jsx("use", { href: "#o-legs" }),
    /* @__PURE__ */ jsx("use", { href: "#o-stand" }),
    raised ? /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("use", { href: "#o-arm-down" }),
      /* @__PURE__ */ jsx("g", { className: "arm-raise", children: /* @__PURE__ */ jsx("use", { href: "#o-arm-up" }) })
    ] }) : /* @__PURE__ */ jsx("use", { href: "#o-arms-stand" }),
    /* @__PURE__ */ jsx("g", { transform: "translate(0 -22.5)", children: /* @__PURE__ */ jsx(Head, { look }) })
  ] });
}
function Helper({ c, i, now: now2, cursor }) {
  const api = useApi();
  const title = api.format.title(c);
  const p = derivePosture(c, void 0, now2);
  const tool = c.state === "working" ? c.currentTool?.tool : void 0;
  const x = i === 0 ? 134 : 146;
  const y = i === 0 ? 54 : 49;
  return /* @__PURE__ */ jsxs(
    SessionLink,
    {
      to: c.key,
      href: sessionHref(c.harness, c.id),
      className: `cell-helper cell-helper--${c.state} ${p.typing ? "cell--typing" : ""} ${lookClass(p.look)}`,
      "aria-label": [`subagent ${title}`, STATE_LABEL[c.state], tool ?? ""].filter(Boolean).join(", "),
      "data-cursor": cursor !== void 0 ? String(cursor) : void 0,
      style: { "--i": i },
      children: [
        /* @__PURE__ */ jsx("svg", { className: "helper-art", viewBox: "112 24 48 56", width: "48", height: "56", "aria-hidden": "true", children: c.state === "needs_you" ? /* @__PURE__ */ jsxs("g", { transform: `translate(${x + 14} ${y + 22}) scale(0.72)`, children: [
          /* @__PURE__ */ jsx("circle", { cx: "14", cy: "-30", r: "1.6", className: "helper-lamp" }),
          /* @__PURE__ */ jsx(Standing, { look: p.look, raised: true })
        ] }) : /* @__PURE__ */ jsxs("g", { transform: `translate(${x} ${y}) scale(0.72)`, children: [
          /* @__PURE__ */ jsx("use", { href: "#o-stool", x: "-5", y: "16" }),
          /* @__PURE__ */ jsx(SeatedSmall, { p })
        ] }) }),
        /* @__PURE__ */ jsx(Tooltip, { s: c, p, now: now2, helper: true })
      ]
    }
  );
}
function SeatedSmall({ p }) {
  const { look } = p;
  if (p.state === "working")
    return /* @__PURE__ */ jsxs("g", { transform: "translate(0 2)", children: [
      /* @__PURE__ */ jsx("use", { href: "#o-torso" }),
      /* @__PURE__ */ jsx("use", { href: "#o-neck" }),
      /* @__PURE__ */ jsx(Head, { look }),
      /* @__PURE__ */ jsx("g", { className: "hands", children: /* @__PURE__ */ jsx("use", { href: "#o-arm-key" }) })
    ] });
  if (p.state === "stale")
    return /* @__PURE__ */ jsxs("g", { transform: "translate(0 -3)", children: [
      /* @__PURE__ */ jsx("use", { href: "#o-torso", transform: "translate(0 -2) scale(1 1.4)" }),
      /* @__PURE__ */ jsx("use", { href: "#o-arms-desk" }),
      /* @__PURE__ */ jsx("use", { href: "#o-neck", transform: "translate(0 -1)" }),
      /* @__PURE__ */ jsx(Head, { look })
    ] });
  return /* @__PURE__ */ jsxs("g", { transform: "translate(0 -2)", children: [
    /* @__PURE__ */ jsx("use", { href: "#o-torso", transform: "scale(1 1.08)" }),
    /* @__PURE__ */ jsx("use", { href: "#o-neck" }),
    /* @__PURE__ */ jsx(Head, { look })
  ] });
}
function EmptyDesk({ pos }) {
  const style = { "--left": `${pos.left}px`, "--bottom": `${pos.bottom}px` };
  return /* @__PURE__ */ jsx("div", { className: "cell cell--figures cell--empty", style, "aria-hidden": "true", children: /* @__PURE__ */ jsx("svg", { className: "cell-art", viewBox: `0 0 ${CELL_W} ${CELL_H}`, width: CELL_W, height: CELL_H, "aria-hidden": "true", children: /* @__PURE__ */ jsxs("g", { transform: `translate(${DESK_X} 0)`, children: [
    /* @__PURE__ */ jsx("use", { href: "#o-desk" }),
    /* @__PURE__ */ jsx("use", { href: "#o-monitor" }),
    /* @__PURE__ */ jsx("rect", { className: "cell-screen cell-screen--off", x: "36", y: "15", width: "24", height: "16" }),
    /* @__PURE__ */ jsx("use", { href: "#o-chair" })
  ] }) }) });
}

// src/IsoCell.tsx
var SEAT = pt(1, 1.62);
var STAND = pt(1.75, 1.45);
var TABLE = pt(-0.75, 0.55);
var HELPER = [pt(-0.75, 1.15), pt(-1.35, 0.55)];
var POOL = pt(1, 0.2, 14);
var face = (points, tone, edge = true) => /* @__PURE__ */ jsx(
  "polygon",
  {
    points,
    fill: `var(--o-${tone})`,
    stroke: edge ? "var(--o-edge)" : "none",
    strokeWidth: "1",
    strokeLinejoin: "round",
    vectorEffect: "non-scaling-stroke"
  }
);
function IsoDefs() {
  return /* @__PURE__ */ jsx("svg", { className: "office-defs", width: "0", height: "0", "aria-hidden": "true", focusable: "false", children: /* @__PURE__ */ jsxs("defs", { children: [
    /* @__PURE__ */ jsxs("symbol", { id: "i-desk", overflow: "visible", children: [
      face(faceU(2, 0, 1, 0, 14), "side2"),
      face(faceV(0, 2, 1, 0, 14), "side"),
      face(top(0, 0, 2, 1, 14), "top"),
      face(top(0.74, 0.52, 1.26, 0.7, 14), "key", false)
    ] }),
    /* @__PURE__ */ jsxs("symbol", { id: "i-monitor", overflow: "visible", children: [
      face(top(0.9, 0.08, 1.1, 0.24, 14), "side", false),
      face(faceV(0.95, 1.05, 0.2, 14, 16.5), "side", false),
      face(faceU(1.7, 0.06, 0.2, 16, 28), "side2"),
      face(top(0.3, 0.06, 1.7, 0.2, 28), "top")
    ] }),
    /* @__PURE__ */ jsxs("symbol", { id: "i-chair-seat", overflow: "visible", children: [
      /* @__PURE__ */ jsx("ellipse", { cx: "0", cy: "0", rx: "4.5", ry: "2.25", fill: "var(--o-chair-side)" }),
      face(faceV(-0.05, 0.05, 0.05, 0, 5.5), "chair-side", false),
      face(faceU(0.17, -0.15, 0.17, 5.5, 7.5), "chair-side", false),
      face(faceV(-0.17, 0.17, 0.17, 5.5, 7.5), "chair-side", false),
      face(top(-0.17, -0.15, 0.17, 0.17, 7.5), "chair-top", false)
    ] }),
    /* @__PURE__ */ jsxs("symbol", { id: "i-chair-back", overflow: "visible", children: [
      face(faceU(0.17, 0.12, 0.2, 7.5, 12.5), "chair-side", false),
      face(faceV(-0.17, 0.17, 0.2, 7.5, 12.5), "chair-side", false),
      face(top(-0.17, 0.12, 0.17, 0.2, 12.5), "chair-top", false)
    ] }),
    /* @__PURE__ */ jsx("symbol", { id: "i-torso", overflow: "visible", children: /* @__PURE__ */ jsx("rect", { x: "-3.5", y: "-17.5", width: "7", height: "12", rx: "3.5", fill: "var(--o-body)" }) }),
    /* @__PURE__ */ jsx("symbol", { id: "i-head", overflow: "visible", children: /* @__PURE__ */ jsx("circle", { cx: "0", cy: "-21", r: "3.5", fill: "var(--o-head)" }) }),
    /* @__PURE__ */ jsxs("symbol", { id: "i-stand", overflow: "visible", children: [
      /* @__PURE__ */ jsx("line", { x1: "-1.8", y1: "-10", x2: "-1.8", y2: "-0.5", stroke: "var(--o-body)", strokeWidth: "2.4", strokeLinecap: "round" }),
      /* @__PURE__ */ jsx("line", { x1: "1.8", y1: "-10", x2: "1.8", y2: "-0.5", stroke: "var(--o-body)", strokeWidth: "2.4", strokeLinecap: "round" }),
      /* @__PURE__ */ jsx("rect", { x: "-3.5", y: "-22", width: "7", height: "13", rx: "3.5", fill: "var(--o-body)" }),
      /* @__PURE__ */ jsx("circle", { cx: "0", cy: "-25.5", r: "3.5", fill: "var(--o-head)" })
    ] }),
    /* @__PURE__ */ jsx("symbol", { id: "i-arm-up", overflow: "visible", children: /* @__PURE__ */ jsx("line", { x1: "3", y1: "-19", x2: "7.5", y2: "-27.5", stroke: "var(--o-body)", strokeWidth: "2.4", strokeLinecap: "round" }) }),
    /* @__PURE__ */ jsx("symbol", { id: "i-shadow", overflow: "visible", children: /* @__PURE__ */ jsx("ellipse", { cx: "0", cy: "0", rx: "8", ry: "4", fill: "var(--o-shadow)" }) }),
    /* @__PURE__ */ jsxs("symbol", { id: "i-table", overflow: "visible", children: [
      /* @__PURE__ */ jsx(
        "path",
        {
          d: "M-11.3 -10 V0 A11.3 5.66 0 0 0 11.3 0 V-10",
          fill: "var(--o-side)",
          stroke: "var(--o-edge)",
          vectorEffect: "non-scaling-stroke"
        }
      ),
      /* @__PURE__ */ jsx(
        "ellipse",
        {
          cx: "0",
          cy: "-10",
          rx: "11.3",
          ry: "5.66",
          fill: "var(--o-top)",
          stroke: "var(--o-edge)",
          vectorEffect: "non-scaling-stroke"
        }
      )
    ] })
  ] }) });
}
var SCREEN_FACE = faceV(0.3, 1.7, 0.2, 16, 28);
var SCREEN_ORIGIN = pt(0.3, 0.2, 16);
var FRONT_FACE_ORIGIN = pt(1.42, 1, 0);
var seatClass = (p) => {
  if (p.phase === "gone") return "i-seat i-seat--gone";
  switch (p.state) {
    case "working":
      return "i-seat i-seat--in";
    case "stale":
      return "i-seat i-seat--back i-seat--stale";
    case "idle":
      return "i-seat i-seat--back";
    default:
      return "i-seat";
  }
};
function IsoDesk({
  s,
  p,
  glyph,
  slot = 0,
  walk
}) {
  const seated = p && p.phase !== "gone" && p.state !== "needs_you";
  const standing = p?.phase === "seated" && p.state === "needs_you";
  const lit = p?.screen === "lit";
  const walking = p && (p.phase === "arriving" || p.phase === "leaving");
  const style = walk ? {
    "--wx": `${walk.door.x}px`,
    "--wy": `${walk.door.y}px`,
    "--ax": `${walk.corner.x}px`,
    "--ay": `${walk.corner.y}px`,
    "--slot4": slot % 4
  } : { "--slot4": slot % 4 };
  return /* @__PURE__ */ jsxs(
    "g",
    {
      className: `i-desk ${p ? `i-desk--${p.state} i-desk--${p.phase}` : "i-desk--empty"} ${walking && !walk ? "i-desk--nowalk" : ""}`,
      style,
      children: [
        /* @__PURE__ */ jsx("use", { href: "#i-desk" }),
        p && glyph && /* @__PURE__ */ jsx(
          "text",
          {
            className: "i-mono",
            transform: `matrix(1 0.5 0 1 ${FRONT_FACE_ORIGIN.x} ${FRONT_FACE_ORIGIN.y})`,
            x: "0",
            y: "-4",
            children: glyph
          }
        ),
        /* @__PURE__ */ jsx("use", { href: "#i-monitor" }),
        /* @__PURE__ */ jsx("polygon", { points: SCREEN_FACE, className: `i-screen ${lit ? "i-screen--lit" : ""}` }),
        lit && p?.tool && /* @__PURE__ */ jsx(
          "text",
          {
            className: "i-tool",
            transform: `matrix(1 0.5 0 1 ${SCREEN_ORIGIN.x} ${SCREEN_ORIGIN.y})`,
            x: "2.5",
            y: "-3.5",
            children: screenText(p.tool, 5)
          },
          p.tool
        ),
        standing && /* @__PURE__ */ jsx("ellipse", { className: "i-pool", cx: POOL.x, cy: POOL.y, rx: "38", ry: "19" }),
        /* @__PURE__ */ jsx("g", { transform: `translate(${SEAT.x} ${SEAT.y})`, children: /* @__PURE__ */ jsxs("g", { className: p ? seatClass(p) : "i-seat", children: [
          /* @__PURE__ */ jsx("use", { href: "#i-shadow" }),
          /* @__PURE__ */ jsx("use", { href: "#i-chair-seat" }),
          seated && /* @__PURE__ */ jsxs("g", { className: `i-person ${p.typing ? "i-person--typing" : ""}`, children: [
            /* @__PURE__ */ jsx("use", { href: "#i-torso" }),
            /* @__PURE__ */ jsx("g", { className: "i-headg", children: /* @__PURE__ */ jsx("use", { href: "#i-head" }) })
          ] }),
          seated && p.state === "stale" && /* @__PURE__ */ jsx("text", { className: "i-z", x: "5", y: "-24", children: "z" }),
          /* @__PURE__ */ jsx("use", { href: "#i-chair-back" })
        ] }) }),
        standing && /* @__PURE__ */ jsx("g", { transform: `translate(${STAND.x} ${STAND.y})`, children: /* @__PURE__ */ jsxs("g", { className: "i-stander", children: [
          /* @__PURE__ */ jsx("use", { href: "#i-shadow" }),
          /* @__PURE__ */ jsx("use", { href: "#i-stand" }),
          /* @__PURE__ */ jsx("use", { href: "#i-arm-up", className: "i-arm" })
        ] }) }),
        walking && /* @__PURE__ */ jsx("g", { transform: `translate(${SEAT.x} ${SEAT.y})`, children: /* @__PURE__ */ jsx("g", { className: "i-walker", children: /* @__PURE__ */ jsx("use", { href: "#i-stand" }) }) }),
        s && p && p.phase !== "gone" && (p.helpers.length > 0 || p.hiddenHelpers > 0) && /* @__PURE__ */ jsxs("g", { transform: `translate(${TABLE.x} ${TABLE.y})`, children: [
          /* @__PURE__ */ jsx("use", { href: "#i-table" }),
          p.helpers.map((c, i) => /* @__PURE__ */ jsx(IsoHelperArt, { c, at: HELPER[i], origin: TABLE }, c.key)),
          p.hiddenHelpers > 0 && /* @__PURE__ */ jsxs("text", { className: "i-more", x: "0", y: p.helpers.length ? -3 : 2, textAnchor: "middle", children: [
            "+",
            p.hiddenHelpers
          ] })
        ] })
      ]
    }
  );
}
function IsoHelperArt({ c, at, origin }) {
  const typing = c.state === "working" && !c.currentTool;
  const cls = ["i-helper", `i-helper--${c.state}`, typing ? "i-person--typing" : ""].filter(Boolean).join(" ");
  return /* @__PURE__ */ jsx("g", { transform: `translate(${at.x - origin.x} ${at.y - origin.y}) scale(0.6)`, children: /* @__PURE__ */ jsxs("g", { className: cls, children: [
    /* @__PURE__ */ jsx("use", { href: "#i-shadow" }),
    c.state === "needs_you" ? /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("use", { href: "#i-stand" }),
      /* @__PURE__ */ jsx("use", { href: "#i-arm-up", className: "i-arm" })
    ] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("use", { href: "#i-torso" }),
      /* @__PURE__ */ jsx("g", { className: "i-headg", children: /* @__PURE__ */ jsx("use", { href: "#i-head" }) })
    ] })
  ] }) });
}
function IsoOverlay({ s, p, at, now: now2, cursor, helperCursor }) {
  const api = useApi();
  const title = api.format.title(s);
  const style = {
    "--x": `${at.x + HIT.x}px`,
    "--y": `${at.y + HIT.y}px`
  };
  const classes = ["icell", `cell--${p.state}`, `cell--${p.phase}`].join(" ");
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsxs("div", { className: classes, style, "data-cursor": cursor !== void 0 ? String(cursor) : void 0, children: [
      /* @__PURE__ */ jsx(
        SessionLink,
        {
          to: s.key,
          href: sessionHref(s.harness, s.id),
          className: "icell-link",
          "aria-label": cellLabel(title, p),
          children: /* @__PURE__ */ jsx(Nameplate, { s, p })
        }
      ),
      /* @__PURE__ */ jsx("svg", { className: "icell-ring", viewBox: `0 0 ${HIT.w} ${HIT.h}`, "aria-hidden": "true", children: /* @__PURE__ */ jsx("polygon", { points: HIT_POLY }) }),
      p.attention && /* @__PURE__ */ jsx("span", { className: "cell-bubble", children: ATTENTION_LABEL[p.attention.kind] ?? p.attention.kind }, p.attention.attentionId),
      /* @__PURE__ */ jsx(Tooltip, { s, p, now: now2 })
    ] }),
    p.phase !== "gone" && p.helpers.map((c, i) => /* @__PURE__ */ jsx(IsoHelperLink, { c, at, i, now: now2, cursor: helperCursor?.(i) }, c.key))
  ] });
}
var HELPER_HIT = { w: 30, h: 36 };
function IsoHelperLink({
  c,
  at,
  i,
  now: now2,
  cursor
}) {
  const api = useApi();
  const title = api.format.title(c);
  const p = derivePosture(c, void 0, now2);
  const tool = c.state === "working" ? c.currentTool?.tool : void 0;
  const h = HELPER[i];
  const style = {
    "--x": `${at.x + h.x - HELPER_HIT.w / 2}px`,
    "--y": `${at.y + h.y - 28}px`
  };
  return /* @__PURE__ */ jsx(
    SessionLink,
    {
      to: c.key,
      href: sessionHref(c.harness, c.id),
      className: `icell-helper cell-helper--${c.state}`,
      "aria-label": [`subagent ${title}`, STATE_LABEL[c.state], tool ?? ""].filter(Boolean).join(", "),
      "data-cursor": cursor !== void 0 ? String(cursor) : void 0,
      style,
      children: /* @__PURE__ */ jsx(Tooltip, { s: c, p, now: now2, helper: true })
    }
  );
}
var isoGlyph = (s) => harnessMark(s.harness).glyph;

// src/keys.ts
var isTyping = (t) => {
  const el = t;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
};
function useListNav(items, open, enabled = true, shortcuts) {
  const [cursor, setCursor] = useState(-1);
  useEffect(() => {
    if (cursor >= items.length) setCursor(items.length - 1);
  }, [items.length, cursor]);
  useEffect(() => {
    if (!enabled) return;
    if (shortcuts) {
      return shortcuts.register([
        {
          id: "list.down",
          label: "Next desk",
          keys: ["j", "down"],
          run: () => setCursor((c) => Math.min(items.length - 1, c + 1))
        },
        { id: "list.up", label: "Previous desk", keys: ["k", "up"], run: () => setCursor((c) => Math.max(0, c - 1)) },
        {
          id: "list.open",
          label: "Open the session at the cursor",
          keys: ["enter"],
          run: () => {
            const item = items[cursor];
            if (item !== void 0) open(item);
          }
        }
      ]);
    }
    const onKey = (e) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(items.length - 1, c + 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter") {
        const item = items[cursor];
        if (item !== void 0) {
          e.preventDefault();
          open(item);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, cursor, enabled, open, shortcuts]);
  useEffect(() => {
    if (cursor < 0) return;
    const el = document.querySelector(`.sp-office [data-cursor="${CSS.escape(String(cursor))}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const reset = useCallback(() => setCursor(-1), []);
  return { cursor, reset };
}

// src/Legend.tsx
var LOOK = { shirt: 0, hair: 0, hairColour: 0, skin: 0, glasses: false };
var POSTURES = ["working", "needs_you", "idle", "stale"];
var posture = (state, gone = false) => ({
  state,
  typing: false,
  screen: state === "working" ? "lit" : state === "needs_you" ? "dim" : "off",
  tool: state === "working" ? "Edit" : void 0,
  errors: 0,
  helpers: [],
  hiddenHelpers: 0,
  phase: gone ? "gone" : "seated",
  look: LOOK
});
function FigureMini({ state }) {
  const p = posture(state === "gone" ? "idle" : state);
  return /* @__PURE__ */ jsxs(
    "svg",
    {
      className: `legend-art look-s0 look-k0 cell--${state}`,
      viewBox: "0 2 96 70",
      width: "33",
      height: "24",
      "aria-hidden": "true",
      children: [
        /* @__PURE__ */ jsx("use", { href: "#o-desk" }),
        /* @__PURE__ */ jsx("use", { href: "#o-monitor" }),
        /* @__PURE__ */ jsx("rect", { className: `cell-screen cell-screen--${p.screen}`, x: "36", y: "15", width: "24", height: "16" }),
        state === "needs_you" && /* @__PURE__ */ jsx("use", { href: "#o-lamp" }),
        state === "gone" ? /* @__PURE__ */ jsx("use", { href: "#o-chair-in" }) : /* @__PURE__ */ jsx(Seated, { p })
      ]
    }
  );
}
function IsoMini({ state }) {
  const p = posture(state === "gone" ? "idle" : state, state === "gone");
  return /* @__PURE__ */ jsx("svg", { className: "legend-art legend-art--iso", viewBox: "-44 -34 96 70", width: "72", height: "52", "aria-hidden": "true", children: /* @__PURE__ */ jsx(IsoDesk, { p, glyph: "Cl" }) });
}
function Legend({ open, onToggle, style }) {
  const iso = style === "iso";
  const Mini = iso ? IsoMini : FigureMini;
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        className: "legend-btn",
        onClick: onToggle,
        "aria-expanded": open,
        "aria-controls": "office-legend",
        title: "Legend (?)",
        children: "?"
      }
    ),
    open && /* @__PURE__ */ jsxs("div", { className: "legend", id: "office-legend", role: "dialog", "aria-label": "Legend", children: [
      /* @__PURE__ */ jsxs("div", { className: "legend-head", children: [
        /* @__PURE__ */ jsx("span", { children: "How to read the office" }),
        /* @__PURE__ */ jsx("button", { type: "button", className: "legend-close", onClick: onToggle, "data-dismiss": true, "aria-label": "Close legend", children: "\xD7" })
      ] }),
      /* @__PURE__ */ jsxs("ul", { className: "legend-list", children: [
        POSTURES.map((st) => /* @__PURE__ */ jsxs("li", { children: [
          /* @__PURE__ */ jsx(Mini, { state: st }),
          /* @__PURE__ */ jsxs("span", { children: [
            /* @__PURE__ */ jsx("b", { children: STATE_LABEL[st] }),
            " ",
            STATE_HINT[st]
          ] })
        ] }, st)),
        /* @__PURE__ */ jsxs("li", { children: [
          /* @__PURE__ */ jsx(Mini, { state: "gone" }),
          /* @__PURE__ */ jsxs("span", { children: [
            /* @__PURE__ */ jsx("b", { children: "gone home" }),
            " the chair stays pushed in for a while after a session ends; the tally by the door counts the day."
          ] })
        ] }),
        /* @__PURE__ */ jsxs("li", { children: [
          /* @__PURE__ */ jsx("span", { className: "legend-bubble", children: "permission" }),
          /* @__PURE__ */ jsxs("span", { children: [
            /* @__PURE__ */ jsx("b", { children: "bubble" }),
            " over someone standing: the kind of attention; the full message is in the tooltip."
          ] })
        ] }),
        iso ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsxs("svg", { className: "legend-art", viewBox: "-16 -22 32 26", width: "32", height: "26", "aria-hidden": "true", children: [
              /* @__PURE__ */ jsx("use", { href: "#i-table" }),
              /* @__PURE__ */ jsxs("g", { transform: "translate(-10 4) scale(0.6)", children: [
                /* @__PURE__ */ jsx("use", { href: "#i-torso" }),
                /* @__PURE__ */ jsx("use", { href: "#i-head" })
              ] })
            ] }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("b", { children: "round table" }),
              " a subagent sits here, half size, left of its parent's desk; two seats, then +n."
            ] })
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("span", { className: "legend-mono", children: "Cl" }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("b", { children: "monogram" }),
              " the harness, on the desk's front; the tool runs on a lit screen."
            ] })
          ] })
        ] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("svg", { className: "legend-art", viewBox: "58 2 18 10", width: "27", height: "15", "aria-hidden": "true", children: /* @__PURE__ */ jsx("use", { href: "#o-lamp" }) }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("b", { children: "lamp" }),
              " amber only while someone needs you."
            ] })
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsxs("svg", { className: "legend-art", viewBox: "116 28 40 24", width: "30", height: "18", "aria-hidden": "true", children: [
              /* @__PURE__ */ jsx("use", { href: "#o-side" }),
              /* @__PURE__ */ jsx("rect", { className: "cell-lid cell-lid--lit", x: "125", y: "31", width: "10", height: "6.5" })
            ] }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("b", { children: "side table" }),
              " a subagent works here on a laptop; two at most, then +n."
            ] })
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("svg", { className: "legend-art", viewBox: "-1 -1 9 8", width: "14", height: "13", "aria-hidden": "true", children: /* @__PURE__ */ jsx("use", { href: "#o-mug" }) }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("b", { children: "mug" }),
              " in the hand of someone idle."
            ] })
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsxs("svg", { className: "legend-art", viewBox: "0 33 10 10", width: "16", height: "16", "aria-hidden": "true", children: [
              /* @__PURE__ */ jsx("use", { href: "#o-sheet", x: "2", y: "38" }),
              /* @__PURE__ */ jsx("use", { href: "#o-sheet", x: "3", y: "37" })
            ] }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("b", { children: "sheets" }),
              " tool errors on the desk corner: one for 1\u20132, two for 3\u20135, three for more."
            ] })
          ] }),
          /* @__PURE__ */ jsxs("li", { children: [
            /* @__PURE__ */ jsx("span", { className: "legend-mono", children: "Cl" }),
            /* @__PURE__ */ jsxs("span", { children: [
              /* @__PURE__ */ jsx("b", { children: "monogram" }),
              " the harness, under the monitor."
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxs("li", { children: [
          /* @__PURE__ */ jsx("span", { className: "legend-num num", children: "2m10s" }),
          /* @__PURE__ */ jsxs("span", { children: [
            /* @__PURE__ */ jsx("b", { children: "elapsed" }),
            " beside the title: a tool past a minute, or how long a desk has been stale."
          ] })
        ] })
      ] })
    ] })
  ] });
}

// src/layout.ts
var FIG = { cell: 150, h: 120, gap: 16, pad: 12, rowGap: 24, top: 14, aisle: 12 };
var FIG_SCALES = [1.4, 1.25, 1];
function figuresFit(width, desks) {
  const n = Math.max(2, desks);
  const want = Math.min(n, 3);
  let last = { scale: 1, cols: 1 };
  for (const scale of FIG_SCALES) {
    const cols = Math.floor((width - 2 * FIG.pad + FIG.gap) / (FIG.cell * scale + FIG.gap));
    last = { scale, cols: Math.max(1, Math.min(cols, n)) };
    if (cols >= want) return last;
  }
  return last;
}
var figuresRoomWidth = (f, cols) => 2 * FIG.pad + cols * FIG.cell * f.scale + (cols - 1) * FIG.gap;
var figuresCellLeft = (f, col) => FIG.pad + col * (FIG.cell * f.scale + FIG.gap);
function isoFit(width, desks) {
  if (width < 700) return { mode: "list" };
  const n = Math.max(2, desks);
  const maxCols = Math.max(2, Math.ceil(n / 2));
  for (const scale of [1.25, 1]) {
    for (const cols of [4, 3, 2]) {
      if (cols > maxCols) continue;
      const rows = Math.ceil(n / cols);
      const w = (cols * COL + rows * ROW + 1.5) * K * scale;
      if (w <= width) return { mode: "plate", scale, cols };
    }
  }
  return { mode: "list" };
}

// src/IsoRoom.tsx
var face2 = (points, cls) => /* @__PURE__ */ jsx("polygon", { points, className: cls });
var slotStyle = (x, y) => ({ "--sx": `${x}px`, "--sy": `${y}px` });
function IsoPlate({
  l,
  cells,
  empties,
  now: now2,
  cursor,
  tally
}) {
  const { U, V, door } = l;
  const byDepth = [...cells].sort((a, b) => {
    const oa = slotOrigin(a.slot, l.cols);
    const ob = slotOrigin(b.slot, l.cols);
    return oa.u + oa.v - (ob.u + ob.v) || oa.u - ob.u;
  });
  const doorAt = pt(door + 0.5, -0.9, WALL_H);
  const style = {
    "--room-w": `${l.w}px`,
    "--room-h": `${l.h}px`,
    "--door-x": `${l.origin.x + doorAt.x}px`,
    "--door-y": `${l.origin.y + doorAt.y}px`
  };
  return /* @__PURE__ */ jsxs("div", { className: "iso-box", style, children: [
    /* @__PURE__ */ jsx("svg", { className: "iso-art", viewBox: `0 0 ${l.w} ${l.h}`, "aria-hidden": "true", children: /* @__PURE__ */ jsxs("g", { transform: `translate(${l.origin.x} ${l.origin.y})`, children: [
      face2(faceU(U, 0, V, -PLATE_H, 0), "i-plate-side"),
      face2(faceV(0, U, V, -PLATE_H, 0), "i-plate-side"),
      face2(pts([pt(0, 0), pt(U, 0), pt(U, V), pt(0, V)]), "i-plate"),
      face2(faceU(0, 0, V, 0, WALL_H), "i-wall-u"),
      face2(top(-0.12, 0, 0, V, WALL_H), "i-wall-top"),
      face2(faceV(0, door, 0, 0, WALL_H), "i-wall-v"),
      face2(faceU(door, -0.12, 0, 0, WALL_H), "i-wall-u"),
      face2(top(0, -0.12, door, 0, WALL_H), "i-wall-top"),
      face2(faceV(door + 1, U, 0, 0, WALL_H), "i-wall-v"),
      face2(top(door + 1, -0.12, U, 0, WALL_H), "i-wall-top"),
      empties.map((slot) => {
        const o = slotOrigin(slot, l.cols);
        const p = pt(o.u, o.v);
        return /* @__PURE__ */ jsx("g", { className: "i-slot", style: slotStyle(p.x, p.y), children: /* @__PURE__ */ jsx(IsoDesk, {}) }, `empty-${slot}`);
      }),
      byDepth.map((c) => {
        const o = slotOrigin(c.slot, l.cols);
        const p = pt(o.u, o.v);
        return /* @__PURE__ */ jsx("g", { className: "i-slot", style: slotStyle(p.x, p.y), children: /* @__PURE__ */ jsx(
          IsoDesk,
          {
            s: c.s,
            p: c.p,
            glyph: isoGlyph(c.s),
            slot: c.slot,
            walk: c.walk && c.p.phase !== "seated" ? walkPath(l, c.slot) : void 0
          }
        ) }, c.s.key);
      })
    ] }) }),
    cells.map((c) => /* @__PURE__ */ jsx(
      IsoOverlay,
      {
        s: c.s,
        p: c.p,
        at: cellOrigin(l, c.slot),
        now: now2,
        cursor: c.index === cursor ? cursor : void 0,
        helperCursor: (i) => c.helperBase !== void 0 && c.helperBase + i === cursor ? cursor : void 0
      },
      c.s.key
    )),
    tally !== void 0 && tally > 0 && /* @__PURE__ */ jsxs("span", { className: "iso-home num", title: `${tally} session${tally === 1 ? "" : "s"} done today`, children: [
      tally,
      " home"
    ] })
  ] });
}
var TILE = { U: 4, V: 3.2, desk: pt(1, 0.6), view: "-66 -16 148 96", w: 148, h: 96 };
var TILE_DESK = { x: 66 + TILE.desk.x, y: 16 + TILE.desk.y };
function IsoTile({ cell }) {
  const { U, V, desk } = TILE;
  return /* @__PURE__ */ jsxs("svg", { className: "ilist-art", viewBox: TILE.view, width: TILE.w, height: TILE.h, "aria-hidden": "true", children: [
    face2(faceU(U, 0, V, -PLATE_H, 0), "i-plate-side"),
    face2(faceV(0, U, V, -PLATE_H, 0), "i-plate-side"),
    face2(pts([pt(0, 0), pt(U, 0), pt(U, V), pt(0, V)]), "i-plate"),
    /* @__PURE__ */ jsx("g", { transform: `translate(${desk.x} ${desk.y})`, children: cell ? /* @__PURE__ */ jsx(IsoDesk, { s: cell.s, p: cell.p, glyph: isoGlyph(cell.s), slot: cell.slot }) : /* @__PURE__ */ jsx(IsoDesk, {}) })
  ] });
}
function IsoList({
  cells,
  empties,
  now: now2,
  cursor,
  tally
}) {
  const rows = [...cells].sort((a, b) => a.slot - b.slot);
  return /* @__PURE__ */ jsxs("div", { className: "ilist", children: [
    rows.map((c) => /* @__PURE__ */ jsx(IsoListRow, { c, now: now2, cursor }, c.s.key)),
    empties.map((i) => /* @__PURE__ */ jsx("div", { className: "ilist-row", "aria-hidden": "true", children: /* @__PURE__ */ jsx(IsoTile, {}) }, `empty-${i}`)),
    tally !== void 0 && tally > 0 && /* @__PURE__ */ jsxs("span", { className: "ilist-home num", title: `${tally} session${tally === 1 ? "" : "s"} done today`, children: [
      tally,
      " home"
    ] })
  ] });
}
function IsoListRow({ c, now: now2, cursor }) {
  const api = useApi();
  const title = api.format.title(c.s);
  const mine = c.index === cursor;
  return /* @__PURE__ */ jsxs("div", { className: `ilist-row cell--${c.p.state} cell--${c.p.phase}`, "data-cursor": mine ? String(cursor) : void 0, children: [
    /* @__PURE__ */ jsxs(
      SessionLink,
      {
        to: c.s.key,
        href: sessionHref(c.s.harness, c.s.id),
        className: "ilist-link",
        "aria-label": cellLabel(title, c.p),
        children: [
          /* @__PURE__ */ jsx(IsoTile, { cell: c }),
          /* @__PURE__ */ jsx(Nameplate, { s: c.s, p: c.p })
        ]
      }
    ),
    c.p.attention && /* @__PURE__ */ jsx("span", { className: "cell-bubble", children: ATTENTION_LABEL[c.p.attention.kind] ?? c.p.attention.kind }, c.p.attention.attentionId),
    /* @__PURE__ */ jsx(Tooltip, { s: c.s, p: c.p, now: now2 }),
    c.p.phase !== "gone" && c.p.helpers.map((h, i) => /* @__PURE__ */ jsx(
      IsoHelperLink,
      {
        c: h,
        at: TILE_DESK,
        i,
        now: now2,
        cursor: c.helperBase !== void 0 && c.helperBase + i === cursor ? cursor : void 0
      },
      h.key
    ))
  ] });
}

// src/Room.tsx
function Room({
  name,
  machine,
  cells,
  perRow,
  rows,
  gone,
  band,
  now: now2,
  fit,
  cursor = -1
}) {
  const capacity = perRow * rows;
  const shown = cells.filter((c) => c.slot < capacity);
  const hidden = cells.length - shown.length;
  const taken = new Set(shown.map((c) => c.slot));
  const empties = [];
  for (let i = 0; i < 2 && shown.length + empties.length < 2; i++) if (!taken.has(i)) empties.push(i);
  const pairs = machine ? Object.entries(machine.harnesses) : [...new Map(cells.map((c) => [c.s.harness, c.s.harnessVersion])).entries()];
  const online = machine?.control?.online === true;
  const plate = /* @__PURE__ */ jsxs(NavLink, { to: "/machines", className: "room-plate", children: [
    /* @__PURE__ */ jsx("span", { className: "room-name", children: name }),
    pairs.map(([h, v]) => /* @__PURE__ */ jsxs("span", { className: "room-pair", children: [
      /* @__PURE__ */ jsx("b", { children: harnessMark(h).glyph }),
      " ",
      v ?? ""
    ] }, h)),
    /* @__PURE__ */ jsx(
      "span",
      {
        className: `room-dot ${online ? "room-dot--on" : ""}`,
        role: "img",
        "aria-label": machine?.control ? online ? "control online" : "control offline" : "no control daemon"
      }
    ),
    hidden > 0 && /* @__PURE__ */ jsxs("span", { className: "room-more", children: [
      "+",
      hidden,
      " more"
    ] })
  ] });
  const label = `${name}: ${cells.length} at desks`;
  if (fit.kind === "iso") {
    if (fit.fit.mode === "list")
      return /* @__PURE__ */ jsxs("section", { className: "room room--iso room--list", "aria-label": label, children: [
        plate,
        /* @__PURE__ */ jsx(IsoList, { cells: shown, empties, now: now2, cursor, tally: gone })
      ] });
    const l = layout(perRow, Math.max(rows, Math.ceil(2 / perRow)));
    return /* @__PURE__ */ jsxs("section", { className: "room room--iso", style: { "--o-scale": fit.fit.scale }, "aria-label": label, children: [
      plate,
      /* @__PURE__ */ jsx(IsoPlate, { l, cells: shown, empties, now: now2, cursor, tally: gone })
    ] });
  }
  const f = fit.fit;
  const posOf = (slot) => {
    const col = slot % perRow;
    const row = Math.floor(slot / perRow);
    const left = figuresCellLeft(f, col) / f.scale;
    const bottom = FIG.aisle + (rows - 1 - row) * (CELL_H + FIG.rowGap);
    return { left, bottom, doorX: DOOR_X, aisleX: left - 8, aisleY: CELL_H + bottom - FIG.aisle / 2 };
  };
  const colsUsed = Math.min(
    perRow,
    Math.max(2, Math.max(0, ...shown.map((c) => c.slot + 1), ...empties.map((e) => e + 1)))
  );
  const width = figuresRoomWidth(f, colsUsed);
  const floorH = FIG.top + rows * CELL_H + (rows - 1) * FIG.rowGap + FIG.aisle;
  return /* @__PURE__ */ jsxs(
    "section",
    {
      className: "room room--figures",
      style: { "--room-w": `${width}px`, "--floor-h": `${floorH}px`, "--o-scale": f.scale },
      "aria-label": label,
      children: [
        plate,
        /* @__PURE__ */ jsxs("div", { className: `room-box room-box--figures window--${band}`, children: [
          /* @__PURE__ */ jsx("span", { className: "room-window" }),
          /* @__PURE__ */ jsxs("div", { className: "room-floor", children: [
            shown.map((c) => /* @__PURE__ */ jsx(
              Cell,
              {
                s: c.s,
                p: c.p,
                slot: c.slot,
                pos: posOf(c.slot),
                now: now2,
                walk: c.walk,
                cursor: c.index === cursor ? cursor : void 0,
                helperCursor: (i) => c.helperBase !== void 0 && c.helperBase + i === cursor ? cursor : void 0
              },
              c.s.key
            )),
            empties.map((i) => /* @__PURE__ */ jsx(EmptyDesk, { pos: posOf(i) }, `empty-${i}`))
          ] }),
          /* @__PURE__ */ jsx("span", { className: "room-door", "aria-hidden": "true" }),
          gone > 0 && /* @__PURE__ */ jsxs("span", { className: "room-home num", title: `${gone} session${gone === 1 ? "" : "s"} done today`, children: [
            gone,
            " home"
          ] })
        ] })
      ]
    }
  );
}

// src/style.ts
var KEY = "style";
function useOfficeStyle(api) {
  const [style, setStyle] = useState(() => api.local.get(KEY) === "figures" ? "figures" : "iso");
  const set = useCallback(
    (s) => {
      setStyle(s);
      api.local.set(KEY, s);
    },
    [api]
  );
  return [style, set];
}

// src/Office.tsx
var UNNAMED = "unnamed";
var ARRIVE_MS = 1800;
var LEAVE_MS = 1300;
var MAX_ROWS = 40;
var CHAIR_MS = 30 * 6e4;
var roomOf = (s) => s.machine || UNNAMED;
var roomFit = (style, width, desks) => style === "iso" ? { kind: "iso", fit: isoFit(width, desks) } : { kind: "figures", fit: figuresFit(width, desks) };
var fitCols = (f) => f.kind === "iso" ? f.fit.mode === "plate" ? f.fit.cols : 1 : f.fit.cols;
var endedAt = (s) => Date.parse(s.endedAt ?? s.stateSince);
function useLeaving(live) {
  const [leaving, setLeaving] = useState(/* @__PURE__ */ new Map());
  const prev = useRef(/* @__PURE__ */ new Map());
  useEffect(() => {
    const gone = [...prev.current.values()].filter((s) => !live.has(s.key));
    prev.current = live;
    if (gone.length === 0) return;
    setLeaving((m) => new Map([...m, ...gone.map((s) => [s.key, s])]));
    const t = setTimeout(() => {
      setLeaving((m) => {
        const n = new Map(m);
        for (const s of gone) n.delete(s.key);
        return n;
      });
    }, LEAVE_MS);
    return () => clearTimeout(t);
  }, [live]);
  return leaving;
}
var midnight = (at) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
function Office({ api }) {
  const snap = useSnapshot(api);
  const { machines, connection, scheme } = snap;
  const { roots, childrenOf, all } = useSessionTree(snap.sessions);
  const now2 = useNow();
  const root = useRef(null);
  const measured = useContainerWidth(root);
  const width = measured || 1200;
  const hidden = usePageHidden();
  const [legend, setLegend] = useState(false);
  const [style, setStyle] = useOfficeStyle(api);
  const live = useMemo(() => roots.filter((s) => s.state !== "done" && !s.backfilled), [roots]);
  const liveMap = useMemo(() => new Map(live.map((s) => [s.key, s])), [live]);
  const leaving = useLeaving(liveMap);
  const roomNames = useMemo(() => {
    const names = /* @__PURE__ */ new Set([...machines.keys()]);
    for (const s of all) if (s.machine) names.add(s.machine);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    if (all.some((s) => !s.machine)) sorted.push(UNNAMED);
    return sorted;
  }, [machines, all]);
  const occupied = useMemo(
    () => roomNames.map((room) => ({
      room,
      keys: [
        ...live.filter((s) => roomOf(s) === room).map((s) => s.key),
        ...[...leaving.values()].filter((s) => roomOf(s) === room).map((s) => s.key)
      ]
    })),
    [roomNames, live, leaving]
  );
  const slots = useSeating(api, occupied);
  const lastSlot = useRef(/* @__PURE__ */ new Map());
  for (const [k, v] of slots) lastSlot.current.set(k, v);
  const booted = useRef(false);
  if (connection === "live") booted.current = true;
  const seen = useRef(/* @__PURE__ */ new Map());
  for (const s of live) {
    if (!seen.current.has(s.key)) {
      const t = Date.now();
      seen.current.set(s.key, booted.current ? { at: t, walk: reserveWalk(t) } : { at: 0, walk: false });
    }
  }
  for (const k of [...seen.current.keys()]) if (!liveMap.has(k) && !leaving.has(k)) seen.current.delete(k);
  const postures = useMemo(() => {
    const out = /* @__PURE__ */ new Map();
    for (const s of live) {
      const entry = seen.current.get(s.key);
      const phase = entry && entry.at > 0 && now2 - entry.at < ARRIVE_MS ? "arriving" : "seated";
      out.set(s.key, derivePosture(s, childrenOf.get(s.key), now2, phase));
    }
    for (const s of leaving.values()) out.set(s.key, derivePosture(s, void 0, now2, "leaving"));
    const typing = [...out.entries()].filter(([, p]) => p.typing);
    if (typing.length > MAX_TYPING) {
      typing.sort(
        (a, b) => (liveMap.get(b[0])?.progress?.at ?? "").localeCompare(liveMap.get(a[0])?.progress?.at ?? "")
      );
      for (const [k, p] of typing.slice(MAX_TYPING)) out.set(k, { ...p, typing: false });
    }
    return out;
  }, [live, leaving, childrenOf, now2, liveMap]);
  const rooms = useMemo(() => {
    const keys = [];
    const since2 = midnight(now2);
    const list = roomNames.map((name) => {
      const here = [...live, ...leaving.values()].filter((s) => roomOf(s) === name);
      const fit = roomFit(style, width, here.length);
      const perRow = fitCols(fit);
      const maxRows = MAX_ROWS;
      const held = new Set(here.map((s) => slots.get(s.key) ?? 0));
      let maxSlot = here.reduce((m, s) => Math.max(m, slots.get(s.key) ?? 0), 0);
      const recent = all.filter(
        (s) => s.state === "done" && !s.backfilled && !s.parentId && roomOf(s) === name && now2 - endedAt(s) < CHAIR_MS && lastSlot.current.has(s.key)
      ).sort((a, b) => endedAt(b) - endedAt(a));
      const chairs = [];
      const podsUsed = /* @__PURE__ */ new Set();
      for (const s of recent) {
        const slot = lastSlot.current.get(s.key);
        const pod = Math.floor(slot / 2);
        if (held.has(slot) || podsUsed.has(pod) || slot >= perRow * maxRows) continue;
        held.add(slot);
        podsUsed.add(pod);
        chairs.push(s);
        maxSlot = Math.max(maxSlot, slot);
      }
      const rows = Math.max(1, Math.min(maxRows, Math.ceil((maxSlot + 1) / perRow)));
      const cells = [
        ...here.map((s) => ({
          s,
          p: postures.get(s.key),
          slot: slots.get(s.key) ?? 0,
          walk: seen.current.get(s.key)?.walk ?? false
        })),
        ...chairs.map((s) => ({
          s,
          p: derivePosture(s, void 0, now2, "gone"),
          slot: lastSlot.current.get(s.key),
          walk: false
        }))
      ].sort((a, b) => a.slot - b.slot).map((c) => {
        if (c.slot >= perRow * rows) return c;
        const index = keys.length;
        keys.push(c.s.key);
        const helperBase = keys.length;
        for (const h of c.p.helpers) keys.push(h.key);
        return { ...c, index, helperBase };
      });
      const gone = all.filter(
        (s) => s.state === "done" && !s.backfilled && !s.parentId && roomOf(s) === name && endedAt(s) >= since2
      ).length;
      return { name, machine: machines.get(name), cells, perRow, rows, gone, fit };
    });
    return { list, keys };
  }, [roomNames, live, leaving, slots, postures, width, style, machines, all, now2]);
  const open = useCallback((key) => api.openSession(key), [api]);
  const { cursor } = useListNav(rooms.keys, open, true, api.shortcuts);
  const needs = live.filter((s) => s.state === "needs_you").length;
  const working = live.filter((s) => s.state === "working").length;
  useEffect(() => {
    const t = setTimeout(() => {
      document.title = `${needs > 0 ? `(${needs}) ` : ""}Office \xB7 sessionpipe`;
    }, 0);
    return () => clearTimeout(t);
  }, [needs]);
  useEffect(() => {
    const viaHost = api.shortcuts?.register([
      { id: "legend", label: "Legend", keys: ["?"], run: () => setLegend((v) => !v), hint: "what the postures mean" }
    ]);
    const onKey = (e) => {
      const el = e.target;
      if (e.metaKey || e.ctrlKey || el?.tagName === "INPUT" || el?.tagName === "TEXTAREA") return;
      if (e.key === "?" && !viaHost) {
        e.preventDefault();
        setLegend((v) => !v);
      } else if (e.key === "Escape") {
        setLegend(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      viaHost?.();
    };
  }, [api]);
  const band = hourBand(now2);
  const classes = ["sp-office", hidden ? "office--paused" : ""].filter(Boolean).join(" ");
  if (!booted.current)
    return /* @__PURE__ */ jsx("div", { className: classes, "data-scheme": scheme, children: /* @__PURE__ */ jsx("div", { className: "office", ref: root, children: /* @__PURE__ */ jsx("p", { className: "page-note", children: connection === "connecting" ? "Waiting for the first snapshot\u2026" : "No connection to the receiver yet." }) }) });
  const summary = [
    needs > 0 ? `${needs} need${needs === 1 ? "s" : ""} you` : "",
    working > 0 ? `${working} working` : "",
    live.length - needs - working > 0 ? `${live.length - needs - working} idle or stale` : ""
  ].filter(Boolean).join(" \xB7 ");
  return /* @__PURE__ */ jsx("div", { className: classes, "data-scheme": scheme, children: /* @__PURE__ */ jsxs("div", { className: "office", ref: root, children: [
    /* @__PURE__ */ jsx(OfficeDefs, {}),
    /* @__PURE__ */ jsx(IsoDefs, {}),
    /* @__PURE__ */ jsx("svg", { width: "0", height: "0", "aria-hidden": "true", style: { position: "absolute" }, children: /* @__PURE__ */ jsx("clipPath", { id: "o-screen-clip", children: /* @__PURE__ */ jsx("rect", { x: "36", y: "15", width: "24", height: "16" }) }) }),
    /* @__PURE__ */ jsxs("header", { className: "office-head", children: [
      /* @__PURE__ */ jsx("h1", { className: "office-title", children: "Office" }),
      /* @__PURE__ */ jsx("span", { className: "office-xp", children: "experimental" }),
      /* @__PURE__ */ jsx("span", { className: "office-sum", children: summary || (roomNames.length ? "nobody is in right now" : "") }),
      /* @__PURE__ */ jsxs("div", { className: "office-tools", children: [
        /* @__PURE__ */ jsx(
          Segmented,
          {
            value: style,
            options: [
              { value: "iso", label: "iso" },
              { value: "figures", label: "figures" }
            ],
            onChange: setStyle,
            label: "Drawing style"
          }
        ),
        /* @__PURE__ */ jsx(Legend, { open: legend, onToggle: () => setLegend((v) => !v), style })
      ] })
    ] }),
    roomNames.length === 0 ? /* @__PURE__ */ jsx(EmptyOffice, { band, now: now2, width, style }) : /* @__PURE__ */ jsx("div", { className: "rooms", children: rooms.list.map((r) => /* @__PURE__ */ jsx(
      Room,
      {
        name: r.name,
        machine: r.machine,
        cells: r.cells,
        perRow: r.perRow,
        rows: r.rows,
        gone: r.gone,
        band,
        now: now2,
        fit: r.fit,
        cursor
      },
      r.name
    )) })
  ] }) });
}
function EmptyOffice({
  band,
  now: now2,
  width,
  style
}) {
  const fit = roomFit(style, width, 2);
  const perRow = fitCols(fit);
  return /* @__PURE__ */ jsxs("div", { className: "office-empty", children: [
    /* @__PURE__ */ jsx(
      Room,
      {
        name: "no machines yet",
        cells: [],
        perRow,
        rows: Math.ceil(2 / perRow),
        gone: 0,
        band,
        now: now2,
        fit
      }
    ),
    /* @__PURE__ */ jsxs("ul", { className: "office-ways", children: [
      /* @__PURE__ */ jsxs("li", { children: [
        /* @__PURE__ */ jsx("strong", { children: "This machine." }),
        " Run ",
        /* @__PURE__ */ jsx("code", { children: "npx sessionpipe install" }),
        " once; the GUI tails the local outbox."
      ] }),
      /* @__PURE__ */ jsxs("li", { children: [
        /* @__PURE__ */ jsx("strong", { children: "Another machine." }),
        " Point its sink here with the one line on the Connect page."
      ] }),
      /* @__PURE__ */ jsxs("li", { children: [
        /* @__PURE__ */ jsx("strong", { children: "Demo mode." }),
        " Synthetic sessions to look around with, on and off from Connect."
      ] })
    ] }),
    /* @__PURE__ */ jsx(NavLink, { to: "/connect", className: "btn btn--primary", children: "Open Connect" })
  ] });
}

// src/index.tsx
var theme = {
  mount(container, api) {
    if (!api.react?.createRoot)
      throw new Error("this theme draws with the host's React, which the ThemeApi did not provide");
    globalThis.__sessionpipeThemeReact = api.react;
    const root = createRoot(container);
    root.render(
      /* @__PURE__ */ jsx(ApiProvider, { api, children: /* @__PURE__ */ jsx(Office, { api }) })
    );
    return () => root.unmount();
  }
};
var index_default = theme;
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
