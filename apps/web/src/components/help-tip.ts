/**
 * helpTip — composant Alpine réutilisable : une petite icône ⓘ cliquable
 * qui affiche la définition courte d'un terme du glossaire dans un popover.
 *
 * Usage HTML (CSP-safe, enregistré via Alpine.data) :
 *   <span x-data="helpTip" data-term="rpe" class="relative inline-flex">
 *     <button @click="toggle()" type="button" aria-label="Aide">ⓘ</button>
 *     <span x-show="open" x-text="def" ...></span>
 *   </span>
 *
 * On lit l'attribut `data-term` au init pour résoudre la définition courte
 * depuis le glossaire. Le terme inconnu → pas de popover (fail-safe).
 */

import { getGlossaryTerm } from '@kinetic/core';

export function helpTip() {
  return {
    open: false,
    term: '',
    label: '',
    def: '',

    init(this: {
      open: boolean;
      term: string;
      label: string;
      def: string;
      $el: HTMLElement;
    }): void {
      this.term = this.$el.getAttribute('data-term') ?? '';
      const entry = getGlossaryTerm(this.term);
      if (entry) {
        this.label = entry.term;
        this.def = entry.short;
      } else {
        // Terme inconnu — on garde un fallback discret
        this.label = this.term;
        this.def = '';
      }
    },

    toggle(this: { open: boolean; def: string }): void {
      if (!this.def) return;
      this.open = !this.open;
    },

    close(this: { open: boolean }): void {
      this.open = false;
    },
  };
}
