import { describe, it, expect } from 'vitest';
import { LEGAL_DOCS } from './legal';

/**
 * The Spanish legal text is a block-for-block translation of the English draft, so a
 * change to one should never leave the other behind. Comparing structure (and list
 * lengths) catches a dropped section or bullet without diffing the prose itself.
 */
describe('legal documents', () => {
  for (const [id, doc] of Object.entries(LEGAL_DOCS)) {
    it(`${id} has a Spanish mirror with the same structure`, () => {
      expect(doc.blocksEs).toHaveLength(doc.blocks.length);
      doc.blocks.forEach((block, i) => {
        const translated = doc.blocksEs[i];
        expect(Object.keys(translated)).toEqual(Object.keys(block));
        if ('ul' in block && 'ul' in translated) {
          expect(translated.ul).toHaveLength(block.ul.length);
        }
      });
    });
  }
});
