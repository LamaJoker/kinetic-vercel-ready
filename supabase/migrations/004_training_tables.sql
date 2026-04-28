-- Migration 004 : tables workout_sessions et workout_sets
-- Sync cloud pour les séances d'entraînement (complète la couche IDB locale).

create table public.workout_sessions (
  id            uuid primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  template_id   uuid,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  duration_min  int,
  avg_rpe       numeric(3,1),
  calories_kcal int,
  created_at    timestamptz default now()
);

create table public.workout_sets (
  id           uuid primary key,
  session_id   uuid not null references workout_sessions(id) on delete cascade,
  exercise_id  text not null,
  set_index    int  not null,
  reps         int  not null check (reps between 0 and 100),
  weight_kg    numeric(6,2) not null check (weight_kg >= 0),
  rpe          numeric(3,1) check (rpe between 6 and 10),
  performed_at timestamptz not null default now()
);

create index on workout_sessions (user_id, started_at desc);
create index on workout_sets     (session_id, set_index);
create index on workout_sets     (exercise_id, performed_at desc);

alter table workout_sessions enable row level security;
alter table workout_sets     enable row level security;

create policy "own sessions" on workout_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own sets" on workout_sets
  for all using (
    exists (select 1 from workout_sessions s
            where s.id = session_id and s.user_id = auth.uid())
  );

-- Table bodyweight (sync poids corporel)
create table public.bodyweight_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  date          date not null,
  weight_kg     numeric(5,2) not null check (weight_kg between 20 and 400),
  body_fat_pct  numeric(4,1) check (body_fat_pct between 1 and 70),
  note          text,
  created_at    timestamptz default now(),
  unique (user_id, date)
);

create index on bodyweight_entries (user_id, date desc);

alter table bodyweight_entries enable row level security;

create policy "own bodyweight" on bodyweight_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Table weekly_goals (objectifs hebdo)
create table public.weekly_goals (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  target_sessions   int not null default 3 check (target_sessions between 1 and 14),
  target_tonnage_kg int not null default 0 check (target_tonnage_kg >= 0),
  xp_awarded_week   text,
  updated_at        timestamptz default now(),
  unique (user_id)
);

alter table weekly_goals enable row level security;

create policy "own goals" on weekly_goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
