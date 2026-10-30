// SPDX-License-Identifier: Apache-2.0
// Settings: /settings, a fixed-size window over the page (the sliders in the sidebar's
// foot, a row in the phone's More sheet, "Settings…" at the foot of Display). The section
// list on the chrome ground at the left; the pane under a 44 px title bar with the
// section's name and the close button, as macOS System Settings draws it: inset groups,
// each row a label (one caption under it) and its control on one trailing edge. On a
// phone it is a full-screen sheet with the iOS Settings stack: the list, and a section
// pushed over it ("‹ Settings", Done), and a choice is a row ("Mode   Advanced ›") that
// pushes its picker. The appearance and the skins are live miniatures drawn from each
// skin's own tokens. Everything here is per device (lib/settings.ts, lib/theme.ts). Esc
// and the scrim close it, with its exit (zoom-out, sheet-down on a phone); Tab stays
// inside.
import { type Info, ROUTES, type SessionSummary } from "@shared/api";
import { skinTokensFor } from "@shared/skin-api";
import {
  type CSSProperties,
  createContext,
  lazy,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAppState, useStore } from "../data/hooks";
import { tablistKey } from "../lib/focus";
import { bytes } from "../lib/format";
import { reducedMotion, tokenMs } from "../lib/motion";
import { apiUrl } from "../lib/net";
import { back, hasInAppHistory, Link, navigate, useSearchParam } from "../lib/router";
import {
  DEFAULT_PAGES,
  type DefaultPage,
  type Mode,
  type OpenSessions,
  setSettings,
  useAppSettings,
} from "../lib/settings";
import { allActions, applyPreset, getPreset, PRESETS, useShortcutMap } from "../lib/shortcuts";
import { DEFAULT_SKIN, type InstalledSkin } from "../lib/skins";
import { resolvedScheme, setSkin, setTextSize, setTheme, type Theme, useSettings } from "../lib/theme";
import { TIER_HINT, TIER_LABEL } from "../lib/tier";
import { ago } from "../lib/time";
import { SearchDataGroup } from "../search/SettingsRows";
import { useThemes } from "../themes/host/registry";
import { AppIcon } from "./AppIcon";
import { ActionButton, CommandWell, CopyIconButton, Segmented, Toggle } from "./bits";
import { LensPicker } from "./LensChip";
import { NotificationsSettings } from "./NotificationsSettings";
import { APPEARANCE, noContextMenu, SKIN_ADD_LINE, TextSizeSlider, useListedSkins } from "./QuickSettings";
import { Select } from "./Select";
import { Keys } from "./ShortcutHelp";

export type Section = "general" | "app" | "lens" | "notifications" | "keyboard" | "views" | "data" | "about";

/** The section list's 16 px line glyphs, one per section. */
const GLYPH: Record<Section, ReactNode> = {
  general: (
    <>
      <path d="M4 6h7M15 6h1M4 14h1M9 14h7" />
      <circle cx="13" cy="6" r="2" />
      <circle cx="7" cy="14" r="2" />
    </>
  ),
  app: (
    <>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
      <path d="M2.5 7.5h15M5.2 5.5h.01M7.2 5.5h.01M9.2 5.5h.01" />
    </>
  ),
  lens: (
    <>
      <path d="m10 3 7 3.5-7 3.5-7-3.5Z" />
      <path d="m3 10 7 3.5 7-3.5M3 13.5 10 17l7-3.5" />
    </>
  ),
  notifications: (
    <>
      <path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5H4Z" />
      <path d="M8.5 17h3" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="5" width="15" height="10" rx="2" />
      <path d="M6 8.5h.01M9 8.5h.01M12 8.5h.01M15 8.5h.01M6.5 11.8h7" />
    </>
  ),
  views: (
    <>
      <rect x="3" y="3.5" width="14" height="13" rx="2" />
      <path d="M3 7.5h14M8 7.5v9" />
    </>
  ),
  data: (
    <>
      <ellipse cx="10" cy="5.5" rx="6" ry="2.5" />
      <path d="M4 5.5v9c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-9M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" />
    </>
  ),
  about: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v4.5M10 6.5h.01" />
    </>
  ),
};

/** Inside the native app (NATIVE-SPEC §2.5): Settings › App, its own lazy section. */
const inShell = "sessionpipeShell" in window;
const AppSection = inShell ? lazy(() => import("../native/AppSettings")) : null;

const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  ...(inShell ? [{ id: "app" as const, label: "App" }] : []),
  { id: "lens", label: "Tier lens" },
  { id: "notifications", label: "Notifications" },
  { id: "keyboard", label: "Keyboard" },
  { id: "views", label: "Views & skins" },
  { id: "data", label: "Data" },
  { id: "about", label: "About" },
];
const isSection = (v: string | null): v is Section => SECTIONS.some((s) => s.id === v);

export const settingsPath = (section?: Section) => (section ? `/settings?section=${section}` : "/settings");

const FOCUSABLE =
  "a[href], button:not(:disabled), input:not(:disabled), select, textarea, [tabindex]:not([tabindex='-1'])";

/** The section the URL asks for: `?section=data`, or `#notifications` (a link from
 *  elsewhere); null when it names none. */
function useAskedSection(): Section | null {
  const param = useSearchParam("section");
  const hash = location.hash.replace(/^#/, "");
  if (isSection(param)) return param;
  if (isSection(hash)) return hash;
  return null;
}

const PHONE = "(max-width: 839px)";
const subscribePhone = (l: () => void) => {
  const mq = matchMedia(PHONE);
  mq.addEventListener("change", l);
  return () => mq.removeEventListener("change", l);
};
const isPhone = () => typeof matchMedia === "function" && matchMedia(PHONE).matches;
const usePhone = () => useSyncExternalStore(subscribePhone, isPhone, () => false);

/** A choice pushed as its own page on a phone (iOS Settings): the options as rows with
 *  the current one checked; the bar's back goes to the section. */
interface Picker {
  label: string;
  note?: ReactNode;
  value: string | number;
  options: { value: string | number; label: string }[];
  onChange: (v: string | number) => void;
}
const PickerCtx = createContext<(p: Picker | null) => void>(() => {});

/** A choice among a few: the segmented control on a desktop; on a phone the row's value
 *  and a ›, and the row pushes the picker. */
export function Choice<T extends string | number>({
  value,
  options,
  onChange,
  label,
  note,
  disabled,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  note?: ReactNode;
  disabled?: boolean;
}) {
  const phone = usePhone();
  const push = useContext(PickerCtx);
  if (!phone)
    return <Segmented<T> value={value} options={options} onChange={onChange} label={label} disabled={disabled} />;
  return (
    <button
      type="button"
      className="settings-choice"
      disabled={disabled}
      aria-label={`${label}: ${options.find((o) => o.value === value)?.label ?? ""}`}
      onClick={() => push({ label, note, value, options, onChange: onChange as (v: string | number) => void })}
    >
      <span className="settings-value">{options.find((o) => o.value === value)?.label}</span>
      <span className="settings-tab-chev" aria-hidden="true" />
    </button>
  );
}

export function Settings() {
  const asked = useAskedSection();
  const section = asked ?? "general";
  const phone = usePhone();
  // The phone's stack: no section asked for is the list; a section is pushed over it.
  const view = phone && !asked ? "list" : "pane";
  const ref = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  // A picker belongs to its section.
  useEffect(() => setPicker(null), [section, view]);
  // Back to the page under the dialog (opened by its URL, to the board; the split panel
  // stays), after the window's exit has played.
  const [closing, setClosing] = useState(false);
  const leave = () => (hasInAppHistory() ? back("/") : navigate("/"));
  // The exit takes no click, so a click on the page under it lands at once; when that
  // click navigates, the dialog is gone before its exit ends and must not go Back then
  // (that would undo the click and bring the dialog back).
  const leaving = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(leaving.current), []);
  const close = () => {
    if (closing) return;
    if (reducedMotion()) return leave();
    setClosing(true);
    leaving.current = window.setTimeout(leave, tokenMs("--dur-exit", 140));
  };

  // The window takes focus on open (no ring on a section until the keyboard moves);
  // Tab and shift+Tab cycle inside it.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  const pick = (id: Section) => navigate(settingsPath(id), { replace: !phone });
  const index = SECTIONS.findIndex((s) => s.id === section);
  const label = SECTIONS[index]?.label ?? "Settings";

  return (
    <PickerCtx.Provider value={setPicker}>
      <div className="settings-wrap" data-closing={closing ? "" : undefined}>
        <button type="button" className="settings-scrim" aria-label="Close settings" onClick={close} data-dismiss />
        <div
          className="settings"
          role="dialog"
          aria-label="Settings"
          aria-modal="true"
          ref={ref}
          tabIndex={-1}
          onKeyDown={onKey}
          onContextMenu={noContextMenu}
          data-view={view}
        >
          <nav className="settings-nav" aria-label="Settings sections">
            <div className="settings-nav-bar">
              <button type="button" className="settings-done" onClick={close}>
                Done
              </button>
            </div>
            <div className="settings-nav-large" aria-hidden="true">
              Settings
            </div>
            <div
              className="settings-tabs"
              role="tablist"
              aria-orientation="vertical"
              ref={strip}
              onKeyDown={(e) =>
                tablistKey(e, SECTIONS.length, index, {
                  vertical: true,
                  activate: (i) => {
                    const next = SECTIONS[i];
                    if (!next) return;
                    pick(next.id);
                    requestAnimationFrame(() =>
                      strip.current?.querySelector<HTMLElement>(`[data-section="${next.id}"]`)?.focus(),
                    );
                  },
                })
              }
            >
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  className="settings-tab"
                  aria-selected={s.id === section && view === "pane"}
                  tabIndex={s.id === section ? 0 : -1}
                  onClick={() => pick(s.id)}
                  data-section={s.id}
                >
                  <span className="settings-tab-glyph" aria-hidden="true">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 20 20"
                      width="16"
                      height="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {GLYPH[s.id]}
                    </svg>
                  </span>
                  <span className="settings-tab-name">{s.label}</span>
                  <span className="settings-tab-chev" aria-hidden="true" />
                </button>
              ))}
            </div>
          </nav>
          <div className="settings-main">
            <div className="settings-bar">
              <button
                type="button"
                className="settings-back"
                onClick={() => (picker ? setPicker(null) : back(settingsPath()))}
              >
                <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
                  <path
                    d="M12.5 4.5 7 10l5.5 5.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {picker ? label : "Settings"}
              </button>
              <h2 className="settings-bar-title">{picker ? picker.label : label}</h2>
              <button
                type="button"
                className="icon-btn settings-x"
                onClick={close}
                aria-label="Close"
                data-tip-keys="Esc"
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    fill="none"
                  />
                </svg>
              </button>
              <button type="button" className="settings-done" onClick={close}>
                Done
              </button>
            </div>
            <div className="settings-pane" role="tabpanel" aria-label={picker ? picker.label : label}>
              {picker ? (
                <PickerPage picker={picker} onPick={(v) => setPicker({ ...picker, value: v })} />
              ) : (
                <>
                  {section === "general" && <General />}
                  {section === "app" && AppSection && (
                    <Suspense fallback={null}>
                      <AppSection />
                    </Suspense>
                  )}
                  {section === "lens" && <Lens />}
                  {section === "notifications" && <Notifications />}
                  {section === "keyboard" && <Keyboard />}
                  {section === "views" && <Views />}
                  {section === "data" && <SearchDataGroup Group={Group} Row={Row} />}
                  {section === "data" && <Data />}
                  {section === "about" && <About />}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </PickerCtx.Provider>
  );
}

/** A pushed choice: one inset group of rows, a check on the current one (real radios,
 *  visually hidden, so the arrows move between them). */
function PickerPage({ picker, onPick }: { picker: Picker; onPick: (v: string | number) => void }) {
  const name = useId();
  return (
    <Group note={picker.note}>
      <fieldset className="settings-picks">
        <legend className="sr-only">{picker.label}</legend>
        {picker.options.map((o) => (
          <label
            key={String(o.value)}
            className="settings-row settings-pick"
            data-on={o.value === picker.value || undefined}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              checked={o.value === picker.value}
              onChange={() => {
                picker.onChange(o.value);
                onPick(o.value);
              }}
            />
            <span className="settings-label">{o.label}</span>
            <span className="settings-pick-check" aria-hidden="true" />
          </label>
        ))}
      </fieldset>
    </Group>
  );
}

/** An inset group of rows, with an optional label above and one note under it. */
export function Group({ label, note, children }: { label?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-group" aria-label={label}>
      {label && <h3 className="settings-group-label">{label}</h3>}
      <div className="settings-cells">{children}</div>
      {note && <p className="settings-group-note">{note}</p>}
    </section>
  );
}

/** One setting: a label, one caption line under it, the control on the trailing edge. */
export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-label">{label}</span>
        {hint && <span className="settings-hint">{hint}</span>}
      </div>
      {children !== undefined && <div className="settings-row-ctl">{children}</div>}
    </div>
  );
}

const MODES: { value: Mode; label: string; title: string }[] = [
  { value: "simple", label: "Simple", title: "The board, the inbox, your sessions as a chat; nothing else in the way" },
  { value: "advanced", label: "Advanced", title: "Every page, every count, the tier lens, the dense timeline" },
];

/** The one-line Simple / Advanced switch: the row says which mode is on and what the
 *  other one adds. Simple is the default until a device chooses. */
export function ModeRow({ hint = true }: { hint?: boolean }) {
  const s = useAppSettings();
  const words =
    s.mode === "simple"
      ? "Simple mode. Switch to Advanced for every page, the counts and the tier lens."
      : "Advanced mode. Switch to Simple for the board, the inbox and chats only.";
  return (
    <Row label="Mode" hint={hint ? words : undefined}>
      <Choice<Mode>
        value={s.mode}
        onChange={(mode) => setSettings({ mode })}
        label="Mode"
        note={words}
        options={MODES}
      />
    </Row>
  );
}

function General() {
  const s = useAppSettings();
  return (
    <>
      <Group>
        <ModeRow />
        <Row label="Open on" hint="Where this device lands at the app's root.">
          <Select<DefaultPage>
            className="settings-select"
            size="sm"
            align="end"
            value={s.defaultPage}
            onChange={(defaultPage) => setSettings({ defaultPage })}
            aria-label="Default page"
            options={DEFAULT_PAGES}
          />
        </Row>
        <Row label="Open sessions" hint="A plain click. Shift-click always opens beside.">
          <Choice<OpenSessions>
            value={s.openSessions}
            onChange={(openSessions) => setSettings({ openSessions })}
            label="Open sessions"
            note="A plain click. Shift-click always opens beside."
            options={[
              { value: "page", label: "As page" },
              { value: "beside", label: "Beside" },
            ]}
          />
        </Row>
        <Row label="Confirm before Forget" hint="Forget deletes what is held for a session here.">
          <Toggle
            on={s.confirmForget}
            onChange={(confirmForget) => setSettings({ confirmForget })}
            label="Confirm before Forget"
          />
        </Row>
        <Row label="Usage in the sidebar" hint="This device only.">
          <Toggle
            on={s.usageInSidebar}
            onChange={(usageInSidebar) => setSettings({ usageInSidebar })}
            label="Usage in the sidebar"
          />
        </Row>
      </Group>
      <Display />
    </>
  );
}

/** The skins a person can pick (never Plain, never a broken one). */
function usePickableSkins(): InstalledSkin[] {
  const { builtins, installed } = useListedSkins();
  return [...builtins, ...installed].filter((x) => !x.error);
}

/** Appearance, skin and text size, as tiles you can see before you pick (Settings ›
 *  General, and Views & skins for the skin). */
function Display({ only }: { only?: "skin" }) {
  const d = useSettings();
  const skins = usePickableSkins();
  const forced = d.skin.scheme !== "both";
  const scheme = resolvedScheme(d);
  const skinTiles = (
    <Row label="Skin" hint={forced ? `${d.skin.name} is light only, so the appearance follows it.` : undefined}>
      <TileGroup label="Skin">
        {skins.map((k) => (
          <Tile key={k.id} label={k.name} on={d.skin.id === k.id} onPick={() => setSkin(k)} data-skin={k.id}>
            <SkinMini skin={k} scheme={k.scheme === "both" ? scheme : (k.scheme as "dark" | "light")} />
          </Tile>
        ))}
      </TileGroup>
    </Row>
  );
  if (only === "skin") return skinTiles;
  return (
    <Group label="Display">
      <Row label="Appearance">
        <TileGroup label="Appearance" disabled={forced}>
          {APPEARANCE.map((a) => (
            <Tile
              key={a.value}
              label={a.label}
              on={(forced ? d.skin.scheme : d.appearance) === a.value}
              onPick={() => setTheme(a.value as Theme)}
            >
              {a.value === "auto" ? (
                <span className="skin-mini-split">
                  <SkinMini skin={d.skin} scheme="light" />
                  <SkinMini skin={d.skin} scheme="dark" />
                </span>
              ) : (
                <SkinMini skin={d.skin} scheme={a.value as "dark" | "light"} />
              )}
            </Tile>
          ))}
        </TileGroup>
      </Row>
      {skinTiles}
      <Row label="Text size">
        <span className="settings-size">
          <TextSizeSlider value={d.textSize} onChange={setTextSize} />
        </span>
      </Row>
    </Group>
  );
}

/** A row of picture choices, one checked: real radios, visually hidden, in a fieldset,
 *  so Tab lands on the group and the arrows pick. */
function TileGroup({ label, disabled, children }: { label: string; disabled?: boolean; children: ReactNode }) {
  const name = useId();
  return (
    <fieldset className="tiles" disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      <TileName.Provider value={name}>{children}</TileName.Provider>
    </fieldset>
  );
}

function Tile({
  label,
  on,
  onPick,
  children,
  ...rest
}: {
  label: string;
  on: boolean;
  onPick: () => void;
  children: ReactNode;
  "data-skin"?: string;
}) {
  const group = useContext(TileName);
  return (
    <label className={`tile ${on ? "tile--on" : ""}`} {...rest}>
      <input type="radio" className="sr-only" name={group} checked={on} onChange={onPick} />
      <span className="tile-pic">{children}</span>
      <span className="tile-name">{label}</span>
    </label>
  );
}
/** The radio group's name, from the TileGroup around a Tile. */
const TileName = createContext<string | undefined>(undefined);

/** A skin in one scheme, live and tiny: its sidebar ground, the page, three rows of ink
 *  (the first with the needs-you dot), drawn from the skin's own tokens for that scheme,
 *  sessionpipe's where it sets none. */
function SkinMini({ skin, scheme }: { skin: InstalledSkin; scheme: "dark" | "light" }) {
  const base: Record<string, string | undefined> = skinTokensFor(DEFAULT_SKIN, scheme);
  const own: Record<string, string | undefined> = skinTokensFor(skin, scheme);
  const t = (k: string) => own[k] ?? base[k] ?? `var(${k})`;
  const style = {
    "--m-bg": t("--bg"),
    "--m-side": `color-mix(in oklch, ${t("--bg")} 95.5%, ${t("--fg")})`,
    "--m-line": t("--line"),
    "--m-fg": t("--fg"),
    "--m-fg3": t("--fg-4"),
    "--m-needs": t("--needs"),
    "--m-sel": `color-mix(in oklch, ${t("--fg")} 9%, transparent)`,
  } as CSSProperties;
  return (
    <span className="skin-mini" style={style} aria-hidden="true">
      <span className="skin-mini-side">
        <i className="skin-mini-nav skin-mini-nav--on" />
        <i className="skin-mini-nav" />
        <i className="skin-mini-nav" />
      </span>
      <span className="skin-mini-page">
        <i className="skin-mini-row">
          <b className="skin-mini-dot skin-mini-dot--needs" />
          <b className="skin-mini-text" style={{ width: "62%" }} />
        </i>
        <i className="skin-mini-row">
          <b className="skin-mini-dot" />
          <b className="skin-mini-text" style={{ width: "48%" }} />
        </i>
        <i className="skin-mini-row">
          <b className="skin-mini-dot" />
          <b className="skin-mini-text" style={{ width: "70%" }} />
        </i>
      </span>
    </span>
  );
}

function Lens() {
  const s = useAppSettings();
  return (
    <>
      <Group
        note={
          s.mode === "simple"
            ? "Simple mode shows everything; the lens applies in Advanced."
            : "Pick it from the lens menu in the board's bar, or press L to step through the tiers."
        }
      >
        <Row label="Tier lens" hint="What a receiver at this tier would have got, on every page.">
          <LensPicker />
        </Row>
      </Group>
      <Group label="The tiers" note="Each tier carries everything the one above it does, and more.">
        {([0, 1, 2, 3] as const).map((t) => (
          <div className="settings-row settings-tier" key={t}>
            <TierSteps tier={t} />
            <div className="settings-row-text">
              <span className="settings-label">
                <span className="settings-tier-n num">{t}</span>
                {TIER_LABEL[t].charAt(0).toUpperCase() + TIER_LABEL[t].slice(1)}
              </span>
              <span className="settings-hint">{TIER_HINT[t]}</span>
            </div>
          </div>
        ))}
        <Row label="All" hint="Everything that arrived, at whatever tier each machine sends." />
      </Group>
    </>
  );
}

/** Four steps, filled up to the tier: 0 is one step (presence), 3 all four. */
function TierSteps({ tier }: { tier: 0 | 1 | 2 | 3 }) {
  return (
    <svg className="settings-steps" viewBox="0 0 20 16" width="20" height="16" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={i * 5}
          y={12 - i * 4}
          width="4"
          height={4 + i * 4}
          rx="1"
          className={i <= tier ? "settings-step settings-step--on" : "settings-step"}
        />
      ))}
    </svg>
  );
}

/** The inbox engineer's panel: notify me, sounds, per-event alerts (components/NotificationsSettings.tsx). */
function Notifications() {
  return <NotificationsSettings />;
}

/** The keys most people want, the two presets, and the way on to the editor. */
const COMMON = ["palette.toggle", "search.focus", "help.toggle", "nav.board", "nav.inbox", "list.down", "list.open"];

function Keyboard() {
  const map = useShortcutMap();
  const preset = getPreset();
  return (
    <>
      <Group label="Presets">
        {Object.values(PRESETS).map((p) => (
          <Row key={p.id} label={p.name} hint={`${p.hint.charAt(0).toUpperCase()}${p.hint.slice(1)}.`}>
            <Toggle
              on={preset === p.id}
              onChange={(on) => void applyPreset(on ? p.id : null)}
              label={`${p.name} preset`}
            />
          </Row>
        ))}
      </Group>
      <Group label="Common keys">
        {COMMON.map((id) => {
          const a = allActions().find((x) => x.id === id);
          if (!a) return null;
          const k = map[id]?.[0];
          return (
            <Row key={id} label={a.label}>
              {k ? <Keys caps binding={k} /> : <span className="settings-value">None</span>}
            </Row>
          );
        })}
      </Group>
      <Group>
        <LinkRow to="/shortcuts">Customize shortcuts…</LinkRow>
      </Group>
    </>
  );
}

function Views() {
  const { themes } = useThemes();
  const { installed } = useListedSkins();
  const ok = themes.filter((t) => !t.error);
  const good = installed.filter((s) => !s.error);
  const broken = installed.filter((s) => s.error);
  return (
    <>
      <Group label="Views" note="A view is code that runs in this page. Install and remove them on the Views page.">
        <Row
          label={ok.length === 0 ? "No views installed" : `${ok.length} installed`}
          hint={ok.length === 0 ? undefined : ok.map((t) => t.name || t.id).join(", ")}
        >
          <Link to="/themes" className="btn btn--sm">
            Manage views…
          </Link>
        </Row>
      </Group>
      <Group
        label="Skins"
        note={
          good.length === 0
            ? "A skin is tokens, fonts and a stylesheet; it runs no code. sessionpipe and Paper ship with the app."
            : `A skin runs no code. Installed from outside: ${good.map((s) => s.name || s.id).join(", ")}${broken.length ? ` · ${broken.length} broken` : ""}.`
        }
      >
        <Display only="skin" />
        <div className="settings-row settings-row--stack">
          <div className="settings-row-text">
            <span className="settings-label">Install one on the receiver machine</span>
            <span className="settings-hint">From a folder, a .tgz or .zip, an npm package or a git URL.</span>
          </div>
          {/* The line names its arguments; Copy takes the part to type before one. */}
          <div className="settings-well cmdwell" data-skin-add>
            <code className="cmdwell-text">
              <span className="cmdwell-prompt" aria-hidden="true">
                ${" "}
              </span>
              {SKIN_ADD_LINE}
            </code>
            <CopyIconButton text="sessionpipe-gui skin add " label="Copy the install command" />
          </div>
        </div>
      </Group>
      <Group label="Plugins" note="Plugins run in the receiver process; their settings are on the Views page.">
        <Row label="Server plugins">
          <Link to="/themes" className="btn btn--sm">
            Open Views…
          </Link>
        </Row>
      </Group>
    </>
  );
}

const AGES: { days: number; label: string }[] = [
  { days: 1, label: "a day" },
  { days: 7, label: "a week" },
  { days: 30, label: "a month" },
  { days: 90, label: "three months" },
];

function Data() {
  const store = useStore();
  const { stats, sessions } = useAppState();
  const [info, setInfo] = useState<Info | null>(null);
  const [days, setDays] = useState(30);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    store.transport
      .info()
      .then(setInfo)
      .catch(() => {});
  }, [store]);

  const cutoff = Date.now() - days * 86_400_000;
  const old: SessionSummary[] = [...sessions.values()].filter(
    (s) => s.state === "done" && Date.parse(s.lastAt) < cutoff,
  );

  const forgetOld = async () => {
    setBusy("forget");
    setNote(null);
    let n = 0;
    try {
      for (const s of old) {
        await store.transport.forget(s.harness, s.id);
        store.apply({ kind: "forgotten", key: s.key });
        n++;
      }
      setNote(`Forgot ${n} ${n === 1 ? "session" : "sessions"}.`);
    } catch (e) {
      setNote(`${n} forgotten, then: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
      setConfirm(false);
    }
  };
  const exportSnapshot = async () => {
    setBusy("export");
    setNote(null);
    try {
      const res = await fetch(apiUrl(ROUTES.ui.snapshot), { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `sessionpipe-snapshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Group note={note ?? undefined}>
      <Row
        label="Storage"
        hint={
          info ? (
            <span className="settings-path">{info.storage.dir}</span>
          ) : (
            "The events this receiver holds, one file per session."
          )
        }
      >
        <span className="num settings-value" data-storage>
          {info ? bytes(info.storage.bytes) : stats ? bytes(stats.storageBytes) : "–"}
          {stats && <small> · {stats.events.toLocaleString()} events</small>}
        </span>
      </Row>
      <Row
        label="Forget done sessions older than"
        hint={`${old.length} ${old.length === 1 ? "session matches" : "sessions match"}; the machines keep their own.`}
      >
        <span className="settings-inline">
          <Select<number>
            className="settings-select"
            size="sm"
            align="end"
            value={days}
            onChange={setDays}
            aria-label="Older than"
            options={AGES.map((a) => ({ value: a.days, label: a.label }))}
          />
          {confirm ? (
            <span className="confirm" role="alertdialog" aria-label="Forget these sessions?">
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--sm btn--danger"
                onClick={() => void forgetOld()}
                disabled={busy === "forget"}
              >
                {busy === "forget" ? "Forgetting…" : `Forget ${old.length}`}
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setConfirm(true)}
              disabled={old.length === 0 || !!busy}
            >
              Forget…
            </button>
          )}
        </span>
      </Row>
      <Row label="Export" hint="Every session summary, as JSON.">
        <button type="button" className="btn btn--sm" onClick={() => void exportSnapshot()} disabled={!!busy}>
          {busy === "export" ? "Exporting…" : "Download JSON"}
        </button>
      </Row>
    </Group>
  );
}

function LinkRow({ href, to, children }: { href?: string; to?: string; children: ReactNode }) {
  const inner = (
    <>
      <span className="settings-label settings-link">{children}</span>
      <span className="settings-link-mark" aria-hidden="true">
        {href ? "↗" : "›"}
      </span>
    </>
  );
  return to ? (
    <Link to={to} className="settings-row">
      {inner}
    </Link>
  ) : (
    <a href={href} className="settings-row" target="_blank" rel="noreferrer noopener">
      {inner}
    </a>
  );
}

/** What `/api/ui/update` answers (the installer's release notice; absent before it). */
interface UpdateStatus {
  current: string;
  latest?: string;
  checkedAt?: string;
  available: boolean;
  command: string;
  notesUrl?: string;
  error?: string;
}
const UPDATE = "/api/ui/update";

function About() {
  const store = useStore();
  const [info, setInfo] = useState<Info | null>(null);
  /** undefined: not asked yet; null: this receiver has no updater. */
  const [update, setUpdate] = useState<UpdateStatus | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    store.transport
      .info()
      .then(setInfo)
      .catch(() => {});
    fetch(apiUrl(UPDATE), { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<UpdateStatus>) : null))
      .then(setUpdate)
      .catch(() => setUpdate(null));
  }, [store]);
  // Nothing asks github.com until this is pressed; the receiver does the asking.
  const check = async () => {
    setErr(null);
    try {
      const r = await fetch(apiUrl(`${UPDATE}/check`), { method: "POST", headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setUpdate((await r.json()) as UpdateStatus);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const version = info?.version ?? update?.current;
  const status = !update
    ? undefined
    : update.error
      ? `The last check failed: ${update.error}`
      : update.available && update.latest
        ? `${update.latest} is out.`
        : update.checkedAt
          ? `Up to date · checked ${ago(update.checkedAt, Date.now())}`
          : "Not checked yet.";
  return (
    <>
      <div className="about-head">
        <span className="about-icon" aria-hidden="true">
          <AppIcon size={64} />
        </span>
        <h3 className="about-name">sessionpipe gui</h3>
        <p className="about-version num">{version ? `Version ${version}` : "–"}</p>
        <p className="about-lede">A sessionpipe receiver with a face: one process, no database, no account.</p>
      </div>
      <Group>
        <Row
          label="Updates"
          hint={
            err
              ? `Couldn't check: ${err}`
              : update === null
                ? "This copy doesn't check for updates itself; update it the way it was installed."
                : status
          }
        >
          {update ? (
            <ActionButton className="btn btn--sm" pendingLabel="Checking…" onClick={check}>
              Check for updates
            </ActionButton>
          ) : null}
        </Row>
        {update?.available && update.command ? (
          <div className="settings-row settings-row--stack">
            <div className="settings-row-text">
              <span className="settings-label">Update on the receiver machine</span>
              {update.notesUrl ? (
                <a className="settings-hint" href={update.notesUrl} target="_blank" rel="noreferrer noopener">
                  What's new in {update.latest} ↗
                </a>
              ) : null}
            </div>
            <div className="settings-well">
              <CommandWell command={update.command} label="Copy the update command" />
            </div>
          </div>
        ) : null}
      </Group>
      <Group>
        <LinkRow href="https://github.com/spacesheep-dev/sessionpipe-gui">sessionpipe gui on GitHub</LinkRow>
        <LinkRow href="https://github.com/spacesheep-dev/sessionpipe-gui/releases">Release notes</LinkRow>
        <LinkRow href="https://github.com/spacesheep-dev/sessionpipe">sessionpipe, the core</LinkRow>
        <LinkRow href="https://github.com/spacesheep-dev/sessionpipe/blob/main/spec/PROTOCOL.md">
          The protocol and its tiers
        </LinkRow>
        <LinkRow href="https://github.com/spacesheep-dev/sessionpipe-gui/issues">Report an issue</LinkRow>
      </Group>
      <p className="about-foot">Apache-2.0 · nothing here calls anywhere but its own origin.</p>
    </>
  );
}
