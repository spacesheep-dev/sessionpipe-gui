// SPDX-License-Identifier: Apache-2.0
// Owned by: tls. The two plain-http routes a phone needs before it can open the https
// origin: GET /trust, a small server-rendered page with the steps for iOS, Android, a
// Mac and Linux and the CA's fingerprint to compare; GET /ca.crt, the CA certificate as
// a download. Both need the UI key like the rest of the UI (loopback is free). The QR
// code points here when TLS is on, so a fresh phone never meets a raw certificate warning.
import type { TLSSocket } from "node:tls";
import { type Info, ROUTES, UI_KEY_COOKIE, UI_KEY_PARAM } from "../../shared/api.js";
import type { Ctx, Reply, Router } from "../http/router.js";
import { WORDMARK_CSS, wordmarkHtml } from "../ui/brand.js";
import { caDownloadName, type TlsMaterial } from "./certs.js";

export interface TrustDeps {
  uiAuth: (ctx: Ctx) => boolean;
  uiKey: () => string;
  /** The current material, or null when TLS mode is off. */
  tls: () => TlsMaterial | null;
  info: () => Info;
}

export const CA_CONTENT_TYPE = "application/x-x509-ca-cert";

export function registerTrust(router: Router, deps: TrustDeps): void {
  router.get(ROUTES.caCert, (ctx): Reply => {
    if (!deps.uiAuth(ctx)) return { status: 401, json: { reason: "unauthorized" } };
    const m = deps.tls();
    if (!m) return { status: 404, json: { reason: "tls_off", hint: "start sessionpipe-gui with --tls" } };
    return {
      status: 200,
      text: m.caCert,
      headers: {
        "content-type": CA_CONTENT_TYPE,
        "content-disposition": `attachment; filename="${caDownloadName(m.hostname)}"`,
        "cache-control": "no-store",
      },
    };
  });

  router.get(ROUTES.trust, (ctx): Reply => {
    if (!deps.uiAuth(ctx)) return { status: 401, json: { reason: "unauthorized" } };
    const headers: Record<string, string> = { "cache-control": "no-store" };
    const k = ctx.url.searchParams.get(UI_KEY_PARAM);
    if (k !== null && k === deps.uiKey()) {
      headers["set-cookie"] = `${UI_KEY_COOKIE}=${encodeURIComponent(k)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    }
    const secureHere = (ctx.req.socket as TLSSocket).encrypted === true;
    return {
      status: 200,
      headers,
      html: trustPage({
        tls: deps.tls(),
        info: deps.info(),
        key: ctx.remote.loopback ? null : deps.uiKey(),
        secureHere,
      }),
    };
  });
}

export interface TrustPageInput {
  tls: TlsMaterial | null;
  info: Info;
  /** The UI key to carry in links (null from loopback, where none is needed). */
  key: string | null;
  /** The request itself came over TLS: this very page is the secure origin. */
  secureHere: boolean;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const withKey = (url: string, key: string | null): string =>
  key ? `${url}${url.includes("?") ? "&" : "?"}${UI_KEY_PARAM}=${encodeURIComponent(key)}` : url;

/** The whole page as a string: system font, hairlines, light and dark from the OS. */
export function trustPage(input: TrustPageInput): string {
  const { tls, info, key, secureHere } = input;
  const port = info.port;
  const httpsUrl = info.tls?.httpsUrl ?? (tls ? `https://${tls.hostname}:${port}` : null);
  const httpsHome = httpsUrl ? withKey(`${httpsUrl}/`, key) : null;
  const caHref = withKey(ROUTES.caCert, key);
  const caName = tls ? caDownloadName(tls.hostname) : "sessionpipe-gui.crt";
  const fp = tls?.caFingerprint ?? "";
  const expires = tls ? tls.serverExpiresAt.slice(0, 10) : "";
  const localUrl = `http://localhost:${port}`;

  const body = !tls
    ? `
<h1>TLS mode is off</h1>
<p class="lead">Passkeys need a secure context: <code>https://</code> on a DNS name, or <code>localhost</code>. Over plain http on the network a phone cannot make or use one.</p>
<p>Turn it on where the receiver runs, then come back to this page from the new QR code:</p>
<pre><code>sessionpipe-gui --tls</code></pre>
<p class="note">The choice is remembered; <code>--no-tls</code> turns it off again. Nothing else changes: <code>${esc(localUrl)}</code> and the sink line for other machines stay plain http on the same port.</p>
`
    : secureHere
      ? `
<h1>Passkeys are available here</h1>
<p class="lead">This page came over https from <code>${esc(tls.hostname)}</code>, and the browser trusts it. Control works on this device now.</p>
<p class="actions"><a class="btn" href="${esc(withKey("/machines", key))}">Machines and pairing</a> <a class="btn btn--ghost" href="${esc(withKey("/", key))}">The board</a></p>
<p class="note">The passkeys this browser makes are for the rp id <code>${esc(info.control.rpId)}</code>; they only answer on this origin.</p>
`
      : `
<h1>Passkeys from this phone</h1>
<p class="lead">Passkeys only work over https, so this receiver has made its own certificate authority. Trust it once on this device, then open the secure address. Nothing leaves your network.</p>

<section>
<h2>The certificate to trust</h2>
<p><b>sessionpipe-gui local CA · ${esc(tls.hostname)}</b></p>
<p class="fp" aria-label="SHA-256 fingerprint"><span>SHA-256</span><code id="fp">${esc(fp)}</code></p>
<p class="note">Compare these characters with what the device shows before trusting. Anyone who can reach this page can download the file; only the fingerprint tells you it is the right one. Server certificate valid to ${esc(expires)}.</p>
</section>

<section>
<h2>iPhone or iPad</h2>
<ol>
<li><a href="${esc(caHref)}" download="${esc(caName)}">Download the certificate</a> (<code>${esc(caName)}</code>) and choose <b>Allow</b> when Safari asks to download a configuration profile.</li>
<li>Open <b>Settings</b> → <b>Profile Downloaded</b> (near the top) → <b>Install</b>, and confirm with your passcode.</li>
<li><b>Settings</b> → <b>General</b> → <b>About</b> → <b>Certificate Trust Settings</b>: turn on full trust for <b>sessionpipe-gui local CA</b>.</li>
<li>Open the secure address: <a class="btn" href="${esc(httpsHome ?? "#")}">${esc(httpsUrl ?? "")}</a></li>
</ol>
</section>

<section>
<h2>Android</h2>
<ol>
<li><a href="${esc(caHref)}" download="${esc(caName)}">Download the certificate</a>.</li>
<li><b>Settings</b> → <b>Security</b> (or <b>Security &amp; privacy</b>) → <b>More security settings</b> → <b>Install a certificate</b> → <b>CA certificate</b> → <b>Install anyway</b>, and pick the downloaded file.</li>
<li>Open the secure address: <a class="btn" href="${esc(httpsHome ?? "#")}">${esc(httpsUrl ?? "")}</a>. If the name does not resolve, your Android build has no mDNS for <code>.local</code> names; Chrome on recent Android does, and a hosts entry or your router's DNS can map <code>${esc(tls.hostname)}</code> to this machine's address.</li>
</ol>
</section>

<section>
<h2>This Mac, or another one</h2>
<p>Where the receiver runs:</p>
<pre><code>sessionpipe-gui tls trust</code></pre>
<p class="note">It adds the CA to the login keychain (<code>security add-trusted-cert</code>; macOS asks for your password). By hand: open <code>${esc(tls.caCertPath)}</code> in Keychain Access and set <b>Always Trust</b> for SSL. Then open <a href="${esc(httpsHome ?? "#")}">${esc(httpsUrl ?? "")}</a>; <code>${esc(localUrl)}</code> keeps working for everything except passkeys.</p>
</section>

<section>
<h2>Linux</h2>
<p class="note">Debian and Ubuntu: copy <code>ca.crt</code> to <code>/usr/local/share/ca-certificates/sessionpipe-gui.crt</code> and run <code>sudo update-ca-certificates</code>. Fedora and friends: <code>sudo trust anchor ca.crt</code>. Firefox and Chrome keep their own stores: import the file under Settings → Certificates → Authorities. Resolving <code>${esc(tls.hostname)}</code> needs avahi-daemon (or nss-mdns) on the machine that opens the page.</p>
</section>
`;

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>sessionpipe-gui · trust this receiver</title>
<style>
:root{color-scheme:light dark;--bg:#ffffff;--bg-3:#f5f5f3;--line:#e4e4e1;--line-2:#dcdcd8;--fg:#141414;--fg-2:#454545;--fg-3:#5c5c5a;--ok:oklch(0.6 0.1 150)}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--bg-3:#222222;--line:#2a2a2a;--line-2:#3a3a39;--fg:#f5f5f3;--fg-2:#c4c4c0;--fg-3:#9a9a96;--ok:oklch(0.7 0.1 150)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:40em;margin:0 auto;padding:28px 20px 64px}
header{display:flex;align-items:center;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--line);color:var(--fg-3);font-size:13px}
${WORDMARK_CSS}
h1{font-size:22px;line-height:1.25;margin:24px 0 8px;font-weight:600}
h2{font-size:15px;margin:0 0 8px;font-weight:600}
section{padding:18px 0;border-top:1px solid var(--line)}
p{margin:0 0 10px}
.lead{color:var(--fg-2)}
.note{color:var(--fg-3);font-size:14px}
ol{margin:0;padding-left:1.4em}
li{margin:0 0 8px}
code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:0.92em;background:var(--bg-3);padding:.08em .32em;border-radius:4px;overflow-wrap:anywhere}
pre{margin:0 0 10px;padding:10px 12px;border-radius:6px;background:var(--bg-3);overflow:auto}
pre code{background:none;padding:0}
a{color:inherit}
.fp{display:flex;flex-direction:column;gap:2px;margin:6px 0 8px}
.fp span{font-size:12px;color:var(--fg-3);text-transform:uppercase;letter-spacing:.04em}
.fp code{font-size:14px;line-height:1.6;padding:8px 10px}
.btn{display:inline-block;margin:4px 0;padding:10px 16px;border:1px solid var(--fg);border-radius:6px;background:var(--fg);color:var(--bg);text-decoration:none;font-weight:600;overflow-wrap:anywhere}
.btn--ghost{background:none;color:var(--fg);border-color:var(--line-2)}
.actions{display:flex;flex-wrap:wrap;gap:8px}
.here{display:none;color:var(--ok);font-weight:600}
html.secure .here{display:block}
</style>
<main>
<header>${wordmarkHtml()} <span>${esc(info.version)}</span> <span>·</span> <span>trust this receiver</span></header>
<p class="here">This page is already on a secure origin: passkeys work here.</p>
${body}
</main>
<script>
if (location.protocol === "https:" && window.isSecureContext) document.documentElement.classList.add("secure");
</script>
</html>
`;
}
