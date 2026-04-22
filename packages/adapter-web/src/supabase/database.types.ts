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
        };
        Insert: {
          user_id: string;
          key: string;
          value?: Json | null;
          updated_at?: string;
        };
        Update: {
          value?: Json | null;
          updated_at?: string;
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
      get_changes_since: {
        Args: { p_since: string };
        Returns: { key: string; value: Json; updated_at: string }[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
