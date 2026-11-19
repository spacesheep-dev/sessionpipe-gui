// SPDX-License-Identifier: Apache-2.0
/** Library entry: embed the GUI receiver in your own process. */

export * from "../shared/api.js";
export { type App, type AppOptions, createApp } from "./app.js";
export { ConfigError, defaultStateDir, type GuiConfig, readGuiConfig } from "./config.js";
export { MAX_BYTES, MAX_EVENTS, registerReceiver, wellKnown } from "./receiver/index.js";
export { eventProblem, MAX_TIER } from "./receiver/validate.js";
export { type OutboxSource, startOutboxSource } from "./sources/outbox.js";
export { type IngestResult, Store, type StoreListener } from "./store/store.js";
