import React from 'react';
import type { LegalBlock } from './legal';

/**
 * Renders a legal or info page body. The supplied text is light Markdown, so this
 * handles the constructs it actually uses: `**bold**`, `*italic*` and `[label](url)`
 * links (whose label may itself be bold). Everything else is plain text.
 *
 * External links open in a new tab so the player never loses their place in the game;
 * site links (`/…`) and mail links open in place and are picked up by the router.
 */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Matches a link [label](url), bold **text** or italic *text*, whichever comes first.
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      const href = match[2].replace(/^mailto\\?:/, 'mailto:');
      const key = `${keyPrefix}-a${n++}`;
      const label = inline(match[1], key);
      nodes.push(/^(\/|mailto:)/.test(href)
        ? <a key={key} href={href}>{label}</a>
        : <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a>);
    } else if (match[3] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b${n++}`}>{match[3]}</strong>);
    } else {
      nodes.push(<em key={`${keyPrefix}-i${n++}`}>{match[4]}</em>);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function LegalBody({ blocks }: { blocks: LegalBlock[] }) {
  return <>
    {blocks.map((block, i) => {
      if ('h' in block) return <h3 key={i}>{block.h}</h3>;
      if ('ul' in block) return <ul key={i}>{block.ul.map((item, j) => <li key={j}>{inline(item, `${i}-${j}`)}</li>)}</ul>;
      return <p key={i}>{inline(block.p, String(i))}</p>;
    })}
  </>;
}
