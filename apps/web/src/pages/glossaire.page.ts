import { GLOSSARY, searchGlossary, type GlossaryTerm } from '@kinetic/core';

export function glossairePage() {
  return {
    query: '',
    allTerms: [...GLOSSARY] as GlossaryTerm[],

    init(): void {
      // rien à charger — données statiques
    },

    get results(): GlossaryTerm[] {
      return searchGlossary(this.query);
    },
  };
}
