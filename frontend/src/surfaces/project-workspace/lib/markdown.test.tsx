import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MarkdownText } from './markdown';

describe('MarkdownText — React elements only, no raw HTML path', () => {
  it('renders bold, italic, inline code, lists and paragraphs', () => {
    const { container } = render(
      <MarkdownText source={'**Bold** and *it* and `code`\n\n- one\n- two\n\n1. first\n2. second'} />,
    );
    expect(container.querySelector('strong')).toHaveTextContent('Bold');
    expect(container.querySelector('em')).toHaveTextContent('it');
    expect(container.querySelector('code')).toHaveTextContent('code');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('prints HTML as literal text — no element is ever created from input markup', () => {
    const { container } = render(<MarkdownText source={'<img src=x onerror="alert(1)"><script>alert(2)</script>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByTestId('markdown')).toHaveTextContent('<img src=x onerror="alert(1)"><script>alert(2)</script>');
  });

  it('links only for http(s)/mailto; javascript: and data: stay text', () => {
    const { container } = render(
      <MarkdownText source={'[ok](https://example.com) [bad](javascript:alert(1)) [data](data:text/html,x)'} />,
    );
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://example.com');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(screen.getByTestId('markdown')).toHaveTextContent('[bad](javascript:alert(1))');
  });

  it('highlights @mentions', () => {
    const { container } = render(<MarkdownText source={'cc @hana.planner@example.com and @Nikos'} />);
    expect(container.querySelectorAll('[data-mention]')).toHaveLength(2);
  });
});

describe('MarkdownText — linear-time link parsing (security S-06)', () => {
  // Timing guard, deliberately GENEROUS. The old unbounded link pattern took
  // ~90 ms in Node (and far more under jsdom + a parallel suite) for 10 000 `[`
  // because every `[` rescanned to the end of the line (O(n²)). The bounded
  // pattern does it in well under 1 ms. The 250 ms ceiling is ~1000x the
  // expected cost, so it only trips on a return to super-linear behaviour, not on
  // a slow CI machine. Each input is 10 000 chars, the server's comment cap.
  it.each([
    ['a run of [', '['.repeat(10_000)],
    ['repeated unclosed [a](', '[a]('.repeat(2_500)],
    ['[a]( then a long tail', '[a]('.repeat(1_250) + 'x'.repeat(5_000)],
  ])('renders %s in linear time', (_name, source) => {
    const start = performance.now();
    render(<MarkdownText source={source} />);
    const elapsed = performance.now() - start;
    expect(screen.getByTestId('markdown').textContent).toBe(source);
    expect(elapsed).toBeLessThan(250);
  });

  it('still renders ordinary links after the bound', () => {
    const { container } = render(<MarkdownText source={'see [the spec](https://example.com/a_b) now'} />);
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com/a_b');
  });
});
