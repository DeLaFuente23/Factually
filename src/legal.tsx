import React from 'react';
import type { LegalBlock } from './legal';

/**
 * Renders a legal document body. The supplied drafts are written as light Markdown,
 * so this handles the two constructs they actually use: `**bold**` emphasis and
 * `[label](url)` links. Everything else is plain text.
 *
 * Inline links open in a new tab so the player never loses their place in the game.
 */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Matches a link [label](url) or bold **text**, whichever comes first.
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      const href = match[2].replace(/^mailto\\?:/, 'mailto:');
      nodes.push(<a key={`${keyPrefix}-a${n++}`} href={href} target="_blank" rel="noopener noreferrer">{match[1]}</a>);
    } else {
      nodes.push(<strong key={`${keyPrefix}-b${n++}`}>{match[3]}</strong>);
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
