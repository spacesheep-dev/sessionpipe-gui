// SPDX-License-Identifier: Apache-2.0
// A machine's name in a line is one piece the line can't break inside, and what touches the
// name goes with it: a line may break on either side of that piece, so a full stop outside it
// could start a line of its own. A chip cut in its middle is drawn whole until it is measured,
// its box laid out from the whole text and the whole text its tooltip.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { leadMidCut } from "../lib/format";
import { EndCut, MidCut, WithName } from "./bits";

describe("MidCut", () => {
  it("draws the whole text, lays its box out from it, and names it in its tooltip", () => {
    expect(renderToStaticMarkup(createElement(MidCut, { text: "studio-mac", className: "kid-where" }))).toBe(
      '<span class="chip midcut kid-where" title="studio-mac" data-text="studio-mac"><span class="midcut-text">studio-mac</span></span>',
    );
  });
  // What it draws once measured is the page's to see (e2e: mobile.spec's 40-character
  // rule); here, that a cut keeps the lead whole and cuts only the text after it.
  it("cuts only the text after its lead, in the middle, keeping both of its ends", () => {
    const name = "rot-0a1b2c-nightly-certs-staging-eu-west";
    for (let n = 3; n < name.length; n++) {
      const cut = leadMidCut("trigger ", name, n);
      expect(cut.startsWith("trigger "), cut).toBe(true);
      const [head, tail] = cut.slice("trigger ".length).split("…");
      expect(tail, cut).toBeDefined();
      expect(name.startsWith(head!), cut).toBe(true);
      expect(name.endsWith(tail!), cut).toBe(true);
      expect([...cut].length, cut).toBeLessThanOrEqual("trigger ".length + n);
    }
    expect(leadMidCut("trigger ", "card-todo", 9)).toBe("trigger card-todo");
  });
  it("with a tip, is a stop for the keyboard whose tooltip is the app's, not the browser's", () => {
    const html = renderToStaticMarkup(
      createElement(MidCut, { lead: "Started by trigger ", text: "card-todo", tip: "A rule named card-todo ran it." }),
    );
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-tip="A rule named card-todo ran it."');
    expect(html).toContain("data-tip-wrap");
    expect(html).toContain('title=""');
    expect(html).toContain('data-text="Started by trigger card-todo"');
  });
  it("with a tip, gives a screen reader the tip as its description: the app's tooltip is drawn for eyes only", () => {
    const html = renderToStaticMarkup(
      createElement(MidCut, { lead: "Started by trigger ", text: "card-todo", tip: "A rule named card-todo ran it." }),
    );
    const id = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<span id="${id}" hidden="">A rule named card-todo ran it.</span>`);
    // Without one, nothing to describe and no stop.
    const plain = renderToStaticMarkup(createElement(MidCut, { lead: "trigger ", text: "card-todo" }));
    expect(plain).not.toContain("aria-describedby");
    expect(plain).not.toContain("tabindex");
  });
  it("draws its separator before the lead, whole, and leaves it out of the tooltip and of what is read", () => {
    const html = renderToStaticMarkup(createElement(MidCut, { sep: "· ", lead: "trigger ", text: "card-todo" }));
    expect(html).toContain('data-text="· trigger card-todo"');
    expect(html).toContain('title="trigger card-todo"');
    expect(html).toContain('<span class="midcut-text" aria-hidden="true">· trigger card-todo</span>');
    expect(html).toContain('<span class="sr-only">trigger card-todo</span>');
  });
});

describe("EndCut", () => {
  it("lays its box out from the lead and the whole text, its tooltip too", () => {
    expect(
      renderToStaticMarkup(createElement(EndCut, { lead: "for ", text: "Plan the migration", className: "inbox-for" })),
    ).toBe(
      '<span class="chip midcut inbox-for" title="for Plan the migration" data-text="for Plan the migration"><span class="midcut-text">for Plan the migration</span></span>',
    );
  });
});

const render = (text: string, name?: string | null) => renderToStaticMarkup(createElement(WithName, { text, name }));

describe("WithName", () => {
  it("keeps the full stop after the name inside its piece", () => {
    expect(render("Too late to answer from here; answer it on Misha-Petrov-laptop.", "Misha-Petrov-laptop")).toBe(
      'Too late to answer from here; answer it on <span class="whole-name">Misha-Petrov-laptop.</span>',
    );
  });

  it("keeps a no-break space and the dot after the name inside it, and stops at a space", () => {
    expect(render("Answer it on studio-mac\u00a0·", "studio-mac")).toBe(
      'Answer it on <span class="whole-name">studio-mac\u00a0·</span>',
    );
    expect(render("studio-mac hasn't added this iPhone yet.", "studio-mac")).toBe(
      '<span class="whole-name">studio-mac</span> hasn&#x27;t added this iPhone yet.',
    );
    expect(render("on (studio-mac), then", "studio-mac")).toBe('on <span class="whole-name">(studio-mac),</span> then');
  });

  it("is the text as it is with no name, or a name not in it", () => {
    expect(render("waiting for the connection", null)).toBe("waiting for the connection");
    expect(render("waiting for the connection", "studio-mac")).toBe("waiting for the connection");
  });
});
