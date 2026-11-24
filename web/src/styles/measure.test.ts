// SPDX-License-Identifier: Apache-2.0
// A reply's measure on a touch screen (session.css, chat.css): its prose stops at about 70
// characters a line in a column of 640 pt and more, and takes the column's whole width in a
// narrower one, where the measure would only stop it short of the messages and the message
// field. The column is the transcript's own (.timeline), measured where it is drawn
// (lib/column.ts data-column), never the window: the sidebar and the bands at the sides are
// not the reply's. Whatever the measure holds is let go in the narrow column, the person's
// bubble with it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NARROW = '.timeline[data-column="narrow"]';

/** A stylesheet without its comments. */
const sheet = (name: string) => readFileSync(path.join(HERE, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** What is inside the braces of every block that opens with `head`. */
function blocks(text: string, head: string): string[] {
  const out: string[] = [];
  for (let at = text.indexOf(head); at >= 0; at = text.indexOf(head, at + 1)) {
    const open = text.indexOf("{", at + head.length);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        out.push(text.slice(open + 1, i));
        break;
      }
    }
  }
  return out;
}

/** A block's rules, as [selectors (one each, in one line), declarations]. */
function rules(body: string): [string[], string][] {
  return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, decl]) => [
    sel!
      .replace(/\s+/g, " ")
      .split(/,(?![^(]*\))/)
      .map((s) => s.trim()),
    decl!.replace(/\s+/g, " ").trim(),
  ]);
}

/** The selectors a block gives `max-width: <value>`. */
const given = (body: string, value: string) =>
  rules(body)
    .filter(([, decl]) => decl === `max-width: ${value};`)
    .flatMap(([sel]) => sel);

describe("a reply's measure on a touch screen", () => {
  const touch = blocks(sheet("session.css"), "@media (pointer: coarse)").find((b) => b.includes("33em"));
  const bubble = blocks(sheet("chat.css"), "@media (pointer: coarse)").find((b) => b.includes("33em"));

  it("is a touch screen's alone", () => {
    expect(touch, "session.css: the measure is in the touch app's query").toBeDefined();
    expect(bubble, "chat.css: the bubble's measure is in the touch app's query").toBeDefined();
  });

  it("stops prose at 33em, and lets go of all of it in a narrow column, and of nothing else", () => {
    const cap = given(touch!, "33em");
    expect(cap.length).toBeGreaterThan(0);
    expect(given(touch!, "none")).toEqual(cap.map((s) => `${NARROW} ${s}`));
  });

  it("has the person's bubble keep a phone's 85% in a narrow column", () => {
    expect(given(bubble!, "min(85%, 33em)")).toEqual([".chat-bubble"]);
    expect(given(bubble!, "85%")).toEqual([`${NARROW} .chat-bubble`]);
  });
});
