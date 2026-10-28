// SPDX-License-Identifier: Apache-2.0
// The App Store Connect API, for "iOS → TestFlight" and by hand. Node only, no packages.
//
//   node asc.mjs app                     the app's Apple ID (numeric) for $BUNDLE_ID
//   node asc.mjs wait <version> <build>  waits until App Store Connect has processed that build
//   node asc.mjs get <path>              any GET, as JSON (`get /v1/apps`)
//
// Credentials from the environment: APPLE_API_ISSUER, APPLE_API_KEY (the key id) and the
// key itself as APPLE_API_PRIVATE_KEY (the .p8's text) or APPLE_API_KEY_PATH (the .p8).
// BUNDLE_ID defaults to dev.spacesheep.sessionpipe. Nothing is written anywhere.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://api.appstoreconnect.apple.com";
const BUNDLE_ID = process.env.BUNDLE_ID || "dev.spacesheep.sessionpipe";

function fail(message, code = 1) {
  console.error(`asc: ${message}`);
  process.exit(code);
}

// The .p8 as pasted: newlines may come back as spaces or as "\n", so rebuild the PEM.
function privateKey() {
  const text =
    process.env.APPLE_API_PRIVATE_KEY ||
    (process.env.APPLE_API_KEY_PATH && readFileSync(process.env.APPLE_API_KEY_PATH, "utf8"));
  if (!text) fail("set APPLE_API_PRIVATE_KEY (the .p8's text) or APPLE_API_KEY_PATH", 2);
  const body = text
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const pem = `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  return createPrivateKey(pem);
}

function token() {
  const { APPLE_API_ISSUER: iss, APPLE_API_KEY: kid } = process.env;
  if (!iss || !kid) fail("set APPLE_API_ISSUER and APPLE_API_KEY", 2);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: "ES256", kid, typ: "JWT" })}.${b64({ iss, iat: now, exp: now + 900, aud: "appstoreconnect-v1" })}`;
  const sig = sign("sha256", Buffer.from(head), { key: privateKey(), dsaEncoding: "ieee-p1363" });
  return `${head}.${sig.toString("base64url")}`;
}

async function get(path) {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token()}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = (body.errors ?? []).map((e) => `${e.title}: ${e.detail}`).join("; ") || res.statusText;
    fail(`GET ${path.split("?")[0]}: ${res.status} ${why}`);
  }
  return body;
}

async function appId() {
  const { data } = await get(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&fields[apps]=bundleId,name`);
  // filter[bundleId] also matches longer ids that share the prefix; take the exact one.
  const app = data.find((a) => a.attributes.bundleId === BUNDLE_ID);
  if (!app) fail(`no app for ${BUNDLE_ID} in App Store Connect: make it once (Apps → New App, RELEASING.md)`);
  return app.id;
}

// PROCESSING until App Store Connect is done with it; then VALID, or INVALID / FAILED. A
// build that isn't listed at all 20 minutes after the upload never arrived.
async function wait(version, build, minutes) {
  const id = await appId();
  const q = `/v1/builds?filter[app]=${id}&filter[version]=${encodeURIComponent(build)}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&fields[builds]=version,processingState&limit=1`;
  const start = Date.now();
  const until = start + minutes * 60_000;
  let last = "";
  for (;;) {
    const [b] = (await get(q)).data;
    const state = b ? b.attributes.processingState : "not there yet";
    if (state !== last) console.log(`${version} (${build}): ${state}`);
    last = state;
    if (b && state !== "PROCESSING") {
      if (state !== "VALID") fail(`App Store Connect says ${state} for ${version} (${build}); its email says why`);
      const detail = await get(`/v1/builds/${b.id}/buildBetaDetail`);
      console.log(`TestFlight: ${detail.data.attributes.internalBuildState} (internal testers)`);
      console.log(`https://appstoreconnect.apple.com/apps/${id}/testflight/ios`);
      return;
    }
    if (!b && Date.now() - start > 20 * 60_000) fail(`${version} (${build}) never arrived: the upload failed`);
    if (Date.now() > until) fail(`${version} (${build}) is still ${state} after ${minutes} minutes`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "app") console.log(await appId());
else if (cmd === "wait" && args.length >= 2) await wait(args[0], args[1], Number(args[2] ?? 45));
else if (cmd === "get" && args[0]?.startsWith("/")) console.log(JSON.stringify(await get(args[0]), null, 2));
else fail("usage: asc.mjs app | wait <version> <build> [minutes] | get </v1/path>", 2);
