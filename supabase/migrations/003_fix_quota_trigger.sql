-- supabase/migrations/003_fix_quota_trigger.sql
-- H6 FIX : le trigger quota s'appliquait uniquement à INSERT.
-- Un UPDATE remplaçant une petite ligne par une grande contournait le quota.
-- On le recréé avec BEFORE INSERT OR UPDATE.

drop trigger if exists enforce_storage_quota on public.user_storage;

create trigger enforce_storage_quota
  before insert or update on public.user_storage
  for each row
  execute function public.check_user_storage_quota();
