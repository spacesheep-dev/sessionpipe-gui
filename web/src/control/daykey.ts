// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The day grant (CONTROL.md §3.2): once a day the passkey vouches
// for a non-extractable P-256 key this browser makes, and every command until the grant's
// `exp` is signed by that key with no prompt. The key pair and the grant live in
// IndexedDB (CryptoKey objects clone into it; the private key never leaves the browser).
import type { GrantBundle } from "./api";
import { b64url, sha256, utf8 } from "./bytes";
import { assertPasskey } from "./ceremony";
import { storedPasskeys } from "./webauthn";

export const GRANT_TYPE = "sessionpipe.grant";
/** A grant lasts at most 24 h (§3.2); we stop a minute short so clock slack never trips it. */
export const GRANT_MS = 24 * 3600_000 - 60_000;

const DB = "sessionpipe-control";
const STORE = "daykeys";

interface DayKeyRecord {
  rp: string;
  privateKey: CryptoKey;
  pub: string;
  grant: GrantBundle;
  /** Mirrors the grant's exp, for a cheap "is it still good" without parsing. */
  exp: number;
  /** Which passkey signed the grant. */
  cred: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "rp" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

const read = (rp: string) => withStore<DayKeyRecord | undefined>("readonly", (s) => s.get(rp));
const write = (rec: DayKeyRecord) => withStore("readwrite", (s) => s.put(rec));
const remove = (rp: string) => withStore("readwrite", (s) => s.delete(rp));

/** Slack so a grant about to end is renewed before a command lands outside it. */
const RENEW_BEFORE_MS = 2 * 60_000;

export const grantGood = (rec: DayKeyRecord | undefined, now = Date.now()): rec is DayKeyRecord =>
  !!rec && rec.exp - RENEW_BEFORE_MS > now && !!rec.privateKey;

/** When the cached grant for `rp` ends (epoch ms), or null when a passkey tap is due. */
export async function grantExpiry(rp: string): Promise<number | null> {
  try {
    const rec = await read(rp);
    return grantGood(rec) ? rec.exp : null;
  } catch {
    return null;
  }
}

export async function dropGrant(rp: string): Promise<void> {
  try {
    await remove(rp);
  } catch {
    // nothing to drop
  }
}

/** The grant for `rp`: the cached one while it is good, else a new day key vouched for
 *  by one passkey tap (an assertion over sha256(str)). `onTap` fires just before the
 *  prompt so the page can say why it appears. */
export async function obtainGrant(rp: string, onTap?: () => void): Promise<DayKeyRecord> {
  const cached = await read(rp).catch(() => undefined);
  if (grantGood(cached)) return cached;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const pub = b64url(await crypto.subtle.exportKey("spki", pair.publicKey));
  const iat = Date.now();
  const exp = iat + GRANT_MS;
  const str = JSON.stringify({ v: 1, t: GRANT_TYPE, pub, iat, exp, rp });
  onTap?.();
  const a = await assertPasskey(
    rp,
    await sha256(str),
    storedPasskeys(rp).map((k) => k.id),
  );
  const rec: DayKeyRecord = { rp, privateKey: pair.privateKey, pub, grant: { ...a, str }, exp, cred: a.cred };
  await write(rec).catch(() => {
    // no IndexedDB (private mode): the grant still serves this page load
  });
  return rec;
}

/** The day key's ECDSA P-256 / SHA-256 signature over the exact command bytes: raw r‖s,
 *  64 bytes, base64url (§3.2). WebCrypto's ECDSA output is already the raw form. */
export async function signWithDayKey(rec: DayKeyRecord, cmd: string): Promise<string> {
  return b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, rec.privateKey, utf8(cmd)));
}
