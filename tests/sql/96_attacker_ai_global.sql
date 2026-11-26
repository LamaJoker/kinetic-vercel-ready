-- 96 — Revue « attaquant » (011) : un attaquant ne doit pas pouvoir vider le plafond
-- GLOBAL du coach IA au détriment des abonnés payants.
--
-- Scénario : chaque inscription reçoit un essai Pro de 7 jours (009) et l'inscription
-- n'a pas de CAPTCHA. Avec 30 requêtes/jour par compte et 2 000/jour au total, ~67
-- comptes jetables épuisaient chaque jour le plafond global : plus aucun abonné payant
-- n'obtenait de réponse. Correction : les comptes NON payants (essai, gratuit, Pro
-- expiré) n'ont droit qu'à une part du plafond global (daily_global_unpaid).
begin;

insert into auth.users (id, email) values
  ('d6000000-0000-0000-0000-000000000001', 't1@test.local'),
  ('d6000000-0000-0000-0000-000000000002', 't2@test.local'),
  ('d6000000-0000-0000-0000-000000000003', 't3@test.local'),
  ('d6000000-0000-0000-0000-0000000000aa', 'paid@test.local'),
  ('d6000000-0000-0000-0000-0000000000bb', 'expired@test.local');

-- Les essais sont créés par le trigger d'inscription (009) ; un compte payant, un Pro expiré.
select t.eq((select count(*) from public.entitlements
             where user_id::text like 'd6000000-%' and trial_ends_at > now())::int, 5,
  'chaque inscription reçoit un essai (point de départ de l''attaque)');
update public.entitlements set tier = 'pro', pro_until = null, trial_ends_at = null
  where user_id = 'd6000000-0000-0000-0000-0000000000aa';
update public.entitlements set tier = 'pro', pro_until = now() - interval '1 day', trial_ends_at = null
  where user_id = 'd6000000-0000-0000-0000-0000000000bb';

delete from public.ai_coach_daily_global;
delete from public.ai_coach_usage;
update public.ai_coach_limits
  set hourly_per_user = 10, daily_per_user = 30, daily_global = 6, daily_global_unpaid = 3, enabled = true;

set role service_role;
-- Comptes d'essai de l'attaquant : 3 requêtes au total, puis refus « global_daily ».
select t.ok((public.consume_ai_quota('d6000000-0000-0000-0000-000000000001', 10) ->> 'allowed')::boolean, 'essai 1 : requête 1 acceptée');
select t.ok((public.consume_ai_quota('d6000000-0000-0000-0000-000000000001', 10) ->> 'allowed')::boolean, 'essai 1 : requête 2 acceptée');
select t.ok((public.consume_ai_quota('d6000000-0000-0000-0000-000000000002', 10) ->> 'allowed')::boolean, 'essai 2 : requête 1 acceptée (part non payante 3/3)');
select t.eq(public.consume_ai_quota('d6000000-0000-0000-0000-000000000002', 10) ->> 'reason', 'global_daily',
  'essai 2 : refusé, part non payante du plafond global épuisée');
select t.eq(public.consume_ai_quota('d6000000-0000-0000-0000-000000000003', 10) ->> 'reason', 'global_daily',
  'nouveau compte jetable : refusé aussi (multiplier les comptes ne sert plus)');
select t.eq(public.consume_ai_quota('d6000000-0000-0000-0000-0000000000bb', 10) ->> 'reason', 'global_daily',
  'Pro expiré : compté comme non payant');

-- L'abonné payant garde le reste du plafond global.
select t.ok((public.consume_ai_quota('d6000000-0000-0000-0000-0000000000aa', 10) ->> 'allowed')::boolean, 'payant : 1/3 accepté malgré l''attaque');
select t.ok((public.consume_ai_quota('d6000000-0000-0000-0000-0000000000aa', 10) ->> 'allowed')::boolean, 'payant : 2/3');
select t.ok((public.consume_ai_quota('d6000000-0000-0000-0000-0000000000aa', 10) ->> 'allowed')::boolean, 'payant : 3/3');
select t.eq(public.consume_ai_quota('d6000000-0000-0000-0000-0000000000aa', 10) ->> 'reason', 'global_daily',
  'payant : le plafond global total reste une borne de coût');
reset role;

select t.eq((select requests from public.ai_coach_daily_global), 6, 'compteur global = 6 (plafond)');
select t.eq((select unpaid_requests from public.ai_coach_daily_global), 3, 'compteur non payant = 3 (part)');
select t.eq((select count(*) from public.ai_coach_usage)::int, 6, 'aucun refus n''a consommé de quota');

-- Configuration : la part non payante ne peut pas être nulle ni négative.
select t.throws($$update public.ai_coach_limits set daily_global_unpaid = 0$$, '23514', 'part non payante ≥ 1 imposée');

-- Les clients ne lisent ni n'écrivent ces compteurs.
select t.login('d6000000-0000-0000-0000-000000000001');
set role authenticated;
select t.throws($$select * from public.ai_coach_daily_global$$, '42501', 'authenticated : compteur global illisible');
select t.throws($$update public.ai_coach_limits set daily_global_unpaid = 1000000$$, '42501', 'authenticated : plafonds non modifiables');
reset role;

rollback;
