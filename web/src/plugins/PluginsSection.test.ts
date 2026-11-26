// SPDX-License-Identifier: Apache-2.0
import type { InstalledPlugin } from "@shared/plugin-api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  hasUnconfiguredSettings,
  PLUGIN_ADD_LINE,
  PluginRow,
  pluginSettingsPatch,
  pluginStatusPill,
  SettingsForm,
} from "./PluginsSection";

const makePlugin = (patch: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: "ping-a-human",
  name: "ping-a-human",
  version: "0.3.0",
  kind: "plugin",
  api: 1,
  entry: "dist/index.js",
  description: "A Telegram message when a session needs you.",
  status: "active",
  settings: [
    { key: "configPath", label: "Config path", type: "string", default: "~/.config/ping.json" },
    { key: "botToken", label: "Bot token", type: "secret", help: "Optional override." },
    { key: "retries", label: "Retries", type: "number", default: 2 },
    { key: "mode", label: "Mode", type: "select", options: ["fast", "quiet"], default: "fast" },
    { key: "events", label: "Events", type: "multiselect", options: ["needs_you", "question"] },
    { key: "askOnPermission", label: "Ask Allow / Deny", type: "boolean", default: true },
  ],
  values: {
    configPath: "~/.config/ping.json",
    botToken: "••••1234",
    retries: 2,
    mode: "fast",
    events: ["needs_you"],
    askOnPermission: true,
  },
  ...patch,
});

describe("PluginsSection helpers", () => {
  it("maps plugin states to calm status pills", () => {
    expect(pluginStatusPill({ status: "active", disabled: false })).toEqual({ label: "Active", tone: "active" });
    expect(pluginStatusPill({ status: "inactive", disabled: true })).toEqual({ label: "Off", tone: "off" });
    expect(pluginStatusPill({ status: "inactive", disabled: false })).toEqual({ label: "Inactive", tone: "off" });
    expect(pluginStatusPill({ status: "error", disabled: false })).toEqual({ label: "Error", tone: "err" });
  });

  it("detects unconfigured plugin settings for auto-expand on enable", () => {
    expect(hasUnconfiguredSettings(makePlugin({ settings: [] }))).toBe(false);
    expect(hasUnconfiguredSettings(makePlugin({ values: {} }))).toBe(true);
    expect(hasUnconfiguredSettings(makePlugin({ values: { botToken: "" } }))).toBe(true);
    expect(hasUnconfiguredSettings(makePlugin())).toBe(false);
  });

  it("uses the concise CLI plugin install line", () => {
    expect(PLUGIN_ADD_LINE).toBe("sessionpipe-gui plugin add <source>");
  });

  it("computes normalized per-field patch so clearing an unset optional number is not dirty", () => {
    const fields = makePlugin().settings!;
    // Unset optional number (undefined) cleared to null -> empty patch (not dirty).
    expect(pluginSettingsPatch(fields, { retries: null }, {})).toEqual({});
    // Set optional number (2) cleared to null -> dirty with explicit null patch.
    expect(pluginSettingsPatch(fields, { retries: null }, { retries: 2 })).toEqual({ retries: null });
    // Secret cleared from masked value -> explicit null patch.
    expect(pluginSettingsPatch(fields, { botToken: null }, { botToken: "••••1234" })).toEqual({ botToken: null });
    // Unchanged masked secret -> omitted from patch.
    expect(pluginSettingsPatch(fields, { botToken: "••••1234" }, { botToken: "••••1234" })).toEqual({});
  });
});

describe("PluginRow and SettingsForm", () => {
  it("renders status pill, Settings disclosure, native switch, and full-width drawer when active", () => {
    const html = renderToStaticMarkup(
      createElement(PluginRow, {
        plugin: makePlugin({ bundled: true }),
        loopback: true,
        busy: false,
        onNote: () => {},
      }),
    );
    expect(html).toContain('data-plugin-row="ping-a-human"');
    expect(html).toContain('data-plugin-pill="active"');
    expect(html).toContain(">Active<");
    expect(html).not.toContain(">bundled<");
    expect(html).toContain('data-plugin-settings-toggle="ping-a-human"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-plugin-toggle="ping-a-human"');
    expect(html).toContain('data-plugin-drawer="ping-a-human"');
    // Drawer sits outside .form-row-text as a dedicated sibling under .plug-item.
    const rowEnd = html.indexOf('data-plugin-drawer="ping-a-human"');
    const togglePos = html.indexOf('data-plugin-toggle="ping-a-human"');
    expect(rowEnd).toBeGreaterThan(togglePos);
  });

  it("collapses the settings drawer and dims the icon when disabled", () => {
    const html = renderToStaticMarkup(
      createElement(PluginRow, {
        plugin: makePlugin({ status: "inactive", disabled: true }),
        loopback: true,
        busy: false,
        onNote: () => {},
      }),
    );
    expect(html).toContain("ext-icon--dim");
    expect(html).toContain('data-plugin-pill="off"');
    expect(html).toContain(">Off<");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain('data-plugin-drawer="ping-a-human"');
  });

  it("renders all field types natively: switch for boolean, custom Select, masked secret with Clear, pill chips", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsForm, {
        plugin: makePlugin(),
        loopback: true,
      }),
    );
    // Never a native <select>.
    expect(html).not.toContain("<select");
    // Shared custom Select combobox for select field.
    expect(html).toContain('role="combobox"');
    // Boolean field uses native switch, not raw checkbox.
    expect(html).toContain('id="plug-ping-a-human-askOnPermission"');
    expect(html).toContain('role="switch"');
    // Secret preserves masked placeholder and offers Clear button.
    expect(html).toContain('placeholder="••••1234"');
    expect(html).toContain(">Clear<");
    // Multiselect keeps fieldset.plug-field--multi for fieldsets.spec.ts and pill chips.
    expect(html).toContain('class="plug-field plug-field--multi"');
    expect(html).toContain("plug-chip is-on");
    // Footer has Save button (disabled while pristine) and hides Reset when clean.
    expect(html).toContain(">Save<");
    expect(html).not.toContain(">Reset<");
  });
});
