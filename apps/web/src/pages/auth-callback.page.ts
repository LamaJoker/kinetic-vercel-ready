import { supabase } from '@kinetic/adapters-web';

export function authCallback() {
  return {
    error: null as string | null,

    async init(): Promise<void> {
      try {
        if (!supabase) {
          window.location.hash = '/';
          return;
        }

        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;

        if (session) {
          setTimeout(() => { window.location.hash = '/'; }, 500);
          return;
        }

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
          if (event === 'SIGNED_IN' && s) {
            subscription.unsubscribe();
            window.location.hash = '/';
          }
        });

        setTimeout(() => {
          subscription.unsubscribe();
          this.error = 'Délai dépassé — veuillez réessayer';
        }, 10_000);
      } catch (e) {
        this.error = e instanceof Error ? e.message : 'Erreur de connexion';
      }
    },
  };
}
