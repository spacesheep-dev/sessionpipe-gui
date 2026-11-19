// SPDX-License-Identifier: Apache-2.0
// A machine's name in a line is one piece the line can't break inside, and what touches the
// name goes with it: a line may break on either side of that piece, so a full stop outside it
// could start a line of its own.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WithName } from "./bits";

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
