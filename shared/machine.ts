// SPDX-License-Identifier: Apache-2.0
// One machine, two spellings. The sessionpipe CLI names the machine in its events by the
// hostname with a trailing `.local`, `.lan` or `.home` dropped (`session.machine` says
// `Build-Box`), while `sessionpipe control pair` in 0.7 sent the raw `os.hostname()`
// (`Build-Box.local`) as the daemon's name. Hostnames are case-insensitive. Everything
// that joins a session or a machine row to a paired daemon by name goes through here, so
// both spellings are one machine; nothing is renamed on the wire.

/** The reading of a machine name under which both spellings are equal. */
export function machineKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.(local|lan|home)\.?$/, "");
}

/** The entry of a map keyed by machine name that `name` means: the exact name first, else
 *  the first whose key is the same. Undefined when neither exists. */
export function machineEntry<T>(byName: ReadonlyMap<string, T>, name: string): [string, T] | undefined {
  const exact = byName.get(name);
  if (exact !== undefined) return [name, exact];
  const key = machineKey(name);
  for (const entry of byName) if (machineKey(entry[0]) === key) return entry;
  return undefined;
}
