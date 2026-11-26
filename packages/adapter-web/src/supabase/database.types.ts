export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      user_storage: {
        Row: {
          user_id: string;
          key: string;
          value: Json | null;
          updated_at: string;
          /** Migration 010 : tombstone (suppression synchronisée). */
          deleted: boolean;
          deleted_at: string | null;
        };
        Insert: {
          user_id: string;
          key: string;
          value?: Json | null;
          updated_at?: string;
          deleted?: boolean;
        };
        Update: {
          value?: Json | null;
          updated_at?: string;
          deleted?: boolean;
        };
        Relationships: [];
      };
      entitlements: {
        Row: {
          user_id: string;
          tier: 'free' | 'pro';
          pro_until: string | null;
          trial_ends_at: string | null;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          tier?: 'free' | 'pro';
          pro_until?: string | null;
          trial_ends_at?: string | null;
        };
        Update: {
          tier?: 'free' | 'pro';
          pro_until?: string | null;
          trial_ends_at?: string | null;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          email: string | null;
          full_name: string | null;
          avatar_url: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          email?: string | null;
          full_name?: string | null;
          avatar_url?: string | null;
        };
        Update: {
          email?: string | null;
          full_name?: string | null;
          avatar_url?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      upsert_daily_log: {
        Args: {
          p_date:        string;
          p_xp_earned:   number;
          p_tasks_done:  number;
          p_streak_day:  number;
          p_metadata?:   Json | null;
        };
        Returns: void;
      };
      sync_pull: {
        Args: { p_since: string; p_after_key: string; p_limit: number };
        Returns: { key: string; value: Json; updated_at: string }[];
      };
      /** Migration 010 : écriture conditionnelle par lots. */
      sync_push: {
        Args: { p_items: Json };
        Returns: Json;
      };
      /** Migration 010 : pull paginé avec tombstones et resync. */
      sync_pull_v2: {
        Args: { p_since: string | null; p_after_key: string; p_limit: number };
        Returns: Json;
      };
      sync_delete_all: {
        Args: Record<string, never>;
        Returns: Json;
      };
      sync_usage: {
        Args: Record<string, never>;
        Returns: Json;
      };
      keep_alive: {
        Args: Record<string, never>;
        Returns: string;
      };
      get_changes_since: {
        Args: { p_since: string };
        Returns: { key: string; value: Json; updated_at: string }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
