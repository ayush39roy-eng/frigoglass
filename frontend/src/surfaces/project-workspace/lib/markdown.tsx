import * as React from 'react';

/**
 * A deliberately small Markdown SUBSET rendered to React elements only.
 *
 * Comments arrive as raw `body_md` (the server no longer sends rendered HTML,
 * P9-R02). Rendering HTML would need `dangerouslySetInnerHTML` (forbidden), so the
 * Markdown is rendered here instead. There is no HTML path at all: every
 * character of input ends up as a React text node or inside an element this
 * file creates, so `<script>`, `<img onerror>` and friends print as literal
 * text. Links only render for `http:`, `https:` and `mailto:` URLs; anything
 * else (`javascript:`, `data:` …) is shown as plain text.
 *
 * Supported: paragraphs (blank line), line breaks, `-`/`*` and `1.` lists,
 * `inline code`, **bold**, *italic* / _italic_, [text](url), @mentions.
 * Chosen over `react-markdown` (≈30–45 KB gzip with micromark/mdast) because
 * comments need nothing more, and "no raw HTML" is then true by construction
 * rather than by configuration.
 */

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

type Inline = React.ReactNode;

// Order matters: code first (its content is literal), then links, bold, italic, mentions.
//
// P9-R03 (security S-06): the link alternative must stay LINEAR. The old
// `\[([^\]\n]+)\]\(([^)\s]+)\)` let the link text contain `[` and the URL contain
// `[`/`(`, so on a run of `[` (or of `[a](`) with no closing bracket every start
// position rescanned to the end of the line: O(n²), ~90 ms for 10 000 `[`, times
// 50 comments per page. Now:
//   - link text excludes `[` and is capped at 500 chars;
//   - the URL excludes `(` and is capped at 2048 chars.
// A failed attempt at one `[` therefore stops at the next `[`/`(` (or the cap), and
// the total work is linear. Nested brackets in link text and parens inside URLs are
// outside this subset; they render as plain text. Guarded by a timing test.
const INLINE_RE =
  /(`[^`\n]+`)|\[([^[\]\n]{1,500})\]\(([^()\s]{1,2048})\)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(@[\w.+-]+(?:@[\w-]+\.[\w.-]+)?)/g;

function renderInline(text: string, keyPrefix = 'i'): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index;
    if (idx > last) out.push(text.slice(last, idx));
    const key = `${keyPrefix}-${String(n++)}`;
    const [whole, code, linkText, linkUrl, bold, italic, mention] = m;
    if (code) {
      out.push(
        <code key={key} className="rounded bg-surface-sunken px-1 font-mono text-[0.92em] text-text">
          {code.slice(1, -1)}
        </code>,
      );
    } else if (linkText !== undefined && linkUrl !== undefined) {
      out.push(
        SAFE_URL.test(linkUrl) ? (
          <a key={key} href={linkUrl} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-2">
            {renderInline(linkText, key)}
          </a>
        ) : (
          whole
        ),
      );
    } else if (bold) {
      out.push(<strong key={key}>{renderInline(bold.slice(2, -2), key)}</strong>);
    } else if (italic) {
      out.push(<em key={key}>{renderInline(italic.slice(1, -1), key)}</em>);
    } else if (mention) {
      out.push(
        <span key={key} className="rounded bg-primary-subtle px-0.5 font-medium text-primary-subtle-fg" data-mention="">
          {mention}
        </span>,
      );
    } else {
      out.push(whole);
    }
    last = idx + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(lines: string[], keyPrefix: string): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={`${keyPrefix}-br-${String(i)}`} />);
    out.push(...renderInline(line, `${keyPrefix}-${String(i)}`));
  });
  return out;
}

export function MarkdownText({ source, className }: { source: string; className?: string }): React.JSX.Element {
  const blocks = source.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  return (
    <div className={className} data-testid="markdown">
      {blocks.map((block, b) => {
        const lines = block.split('\n');
        const key = `b${String(b)}`;
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={key} className="my-1 list-disc pl-5">
              {lines.map((l, i) => (
                <li key={i}>{renderInline(l.replace(/^\s*[-*]\s+/, ''), `${key}-${String(i)}`)}</li>
              ))}
            </ul>
          );
        }
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={key} className="my-1 list-decimal pl-5">
              {lines.map((l, i) => (
                <li key={i}>{renderInline(l.replace(/^\s*\d+[.)]\s+/, ''), `${key}-${String(i)}`)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={key} className="my-1">
            {withBreaks(lines, key)}
          </p>
        );
      })}
    </div>
  );
}
