// SPDX-License-Identifier: Apache-2.0
// Markdown as React, from the tree lib/markdown.ts builds. Every node becomes an element
// or a text node, never injected HTML. Links open only for http(s) destinations; any
// other destination shows as its text. Images are named ("[alt]"), never fetched. A
// fenced block is a quiet well with its language and a copy button, its long lines
// wrapping under a hanging indent; a host that has menus gives it one through CodeFrame
// (this module stays free of the app's router).
import {
  type ComponentType,
  type CSSProperties,
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown";
import { CopyIconButton, Redacted } from "./bits";
import "../styles/markdown.css";

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className={className ? `md ${className}` : "md"}>{blocks.map(renderBlock)}</div>;
}

const hostOf = (href: string): string | undefined => {
  try {
    return new URL(href).host;
  } catch {
    return undefined;
  }
};

const renderInlines = (nodes: Inline[]): ReactNode[] => nodes.map((n, i) => renderInline(n, i));

function renderInline(n: Inline, key: number): ReactNode {
  switch (n.type) {
    case "text":
      return (
        <Fragment key={key}>
          <Redacted text={n.text} />
        </Fragment>
      );
    case "code":
      return <code key={key}>{n.text}</code>;
    case "strong":
      return <strong key={key}>{renderInlines(n.children)}</strong>;
    case "em":
      return <em key={key}>{renderInlines(n.children)}</em>;
    case "br":
      return <br key={key} />;
    case "image":
      return <Fragment key={key}>[{n.alt}]</Fragment>;
    case "link":
      // Only http(s) opens; anything else (javascript:, mailto:, relative) is just its text.
      if (!/^https?:\/\//i.test(n.href)) return <Fragment key={key}>{renderInlines(n.children)}</Fragment>;
      return (
        <a key={key} href={n.href} target="_blank" rel="noopener noreferrer" title={hostOf(n.href)}>
          {renderInlines(n.children)}
        </a>
      );
  }
}

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.type) {
    case "paragraph":
      return <p key={i}>{renderInlines(b.children)}</p>;
    case "heading": {
      const H = `h${b.level}` as "h1" | "h2" | "h3" | "h4";
      return <H key={i}>{renderInlines(b.children)}</H>;
    }
    case "code":
      return <CodeBlock key={i} lang={b.lang} text={b.text} />;
    case "list": {
      const items = b.items.map((item, j) => <li key={j}>{item.map(renderBlock)}</li>);
      return b.ordered ? (
        <ol key={i} start={b.start === 1 ? undefined : b.start}>
          {items}
        </ol>
      ) : (
        <ul key={i}>{items}</ul>
      );
    }
    case "blockquote":
      return <blockquote key={i}>{b.children.map(renderBlock)}</blockquote>;
    case "hr":
      return <hr key={i} />;
    case "table":
      return (
        <table key={i} className="md-table">
          <thead>
            <tr>
              {b.header.map((cell, j) => (
                <th key={j}>{renderInlines(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, j) => (
                  <td key={j}>{renderInlines(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

/** How a host frames each fenced block: a `div.md-pre` around `children`, with whatever it
 *  adds (SessionView's right-click "Copy code"). Without one, a plain div. */
export const CodeFrame = createContext<ComponentType<{ text: string; children: ReactNode }> | null>(null);

/** A code line wraps instead of scrolling sideways, and its wrapped part hangs two
 *  columns in from where the line's own text starts (md-line, `--i` its indent), so a
 *  long line still reads as one line on a phone or in the panel. */
function indentOf(line: string): CSSProperties | undefined {
  const lead = /^[ \t]*/.exec(line)![0];
  const n = lead.length + (lead.split("\t").length - 1);
  return n ? ({ "--i": n } as CSSProperties) : undefined;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const Frame = useContext(CodeFrame);
  const lines = useMemo(() => text.split("\n"), [text]);
  const body = (
    <>
      <div className="md-pre-head">
        <span className="md-pre-lang">{lang}</span>
        <CopyIconButton text={text} label="Copy code" />
      </div>
      <pre className="md-code">
        <code>
          {lines.map((line, i) => (
            <span key={i} className="md-line" style={indentOf(line)}>
              {line}
            </span>
          ))}
        </code>
      </pre>
    </>
  );
  return Frame ? <Frame text={text}>{body}</Frame> : <div className="md-pre">{body}</div>;
}
