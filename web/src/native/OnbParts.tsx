// SPDX-License-Identifier: Apache-2.0
// The parts every screen of the phone's first run is made of (PhoneOnboarding.tsx): one
// screen with its bar, title, line and actions, and the three weights of button.
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef } from "react";

/** A line that names the computer: its name never breaks at its hyphen ("studio-" /
 *  "mac"), so the words stay one word. */
function withHost(text: string, host?: string): ReactNode {
  if (!host || !text.includes(host)) return text;
  const parts = text.split(host);
  return parts.map((part, i) => (
    <span key={i}>
      {part}
      {i < parts.length - 1 && <span className="onb-nowrap">{host}</span>}
    </span>
  ));
}

/** One screen: an optional bar (Back), a glyph over the title, a figure under it where
 *  there is one (a number to compare), one line, then its actions. */
export function Screen({
  bar,
  glyph,
  title,
  figure,
  body,
  host,
  live,
  focusTitle,
  children,
  ...rest
}: {
  bar?: ReactNode;
  glyph?: ReactNode;
  title?: string;
  figure?: ReactNode;
  body?: string;
  /** The computer's name, where the title or body says it. */
  host?: string;
  live?: boolean;
  /** Each new step puts focus on its title, so a screen reader says where the tap led and
   *  the keyboard starts at the top of it (a flow of several steps: the account's). */
  focusTitle?: boolean;
  children?: ReactNode;
  "data-step"?: string;
  "data-opened"?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const stepName = rest["data-step"];
  // The step's name is among what it depends on: a new name is a new step on screen.
  useEffect(() => {
    if (focusTitle) heading.current?.focus({ preventScroll: true });
  }, [focusTitle, stepName]);
  return (
    <div className="onb" {...rest}>
      <header className="onb-bar">{bar}</header>
      <main className="onb-body onb-body--step" id="main" aria-live={live ? "polite" : undefined}>
        {title && (
          <div className="onb-head">
            {glyph}
            <h1 className="onb-title" ref={heading} {...(focusTitle ? { tabIndex: -1 } : {})}>
              {withHost(title, host)}
            </h1>
            {figure}
            {body && <p className="onb-text">{withHost(body, host)}</p>}
          </div>
        )}
        <div className="onb-actions">{children}</div>
      </main>
    </div>
  );
}

/** The one primary action of a screen: the ink fill, as every primary in the app. */
export function Primary(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className="btn btn--primary btn--lg onb-primary" />;
}
export function Secondary(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className="btn btn--lg onb-secondary" />;
}
export function Quiet(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className="btn btn--ghost btn--lg onb-quiet" />;
}
