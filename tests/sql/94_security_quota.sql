-- 94 — Sécurité (011) : quotas anti-abus appelés par les fonctions Edge
-- (consume_ai_quota, consume_ai_coach_quota, consume_rate_limit, purge_security_counters).
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
begin;

-- Plafonds réduits pour le test.
update public.ai_coach_limits set hourly_per_user = 3, daily_per_user = 5, daily_global = 7;
delete from public.ai_coach_daily_global;
delete from public.ai_coach_usage;

set role service_role;
create temp table r (n serial, who text, res jsonb);
insert into r (who, res) select 'A', public.consume_ai_quota(:A, 100) from generate_series(1, 3);
select t.eq((select count(*) from r where (res ->> 'allowed')::boolean)::int, 3, 'IA : 3 requêtes acceptées (plafond horaire 3)');
select t.eq((select res ->> 'remaining_hour' from r where n = 3), '0', 'IA : remaining_hour décompté');
select t.eq((select res ->> 'remaining_day' from r where n = 1), '4', 'IA : remaining_day décompté');
select t.eq(public.consume_ai_quota(:A, 100) ->> 'reason', 'user_hourly', 'IA : 4e requête de l''heure refusée');
select t.ok((public.consume_ai_quota(:A, 100) ->> 'retry_after_seconds')::int between 3500 and 3600,
  'IA : retry_after ≈ 1 h');
reset role;
select t.eq((select count(*) from public.ai_coach_usage where user_id = :A)::int, 3, 'IA : un refus ne consomme rien');
select t.eq((select requests from public.ai_coach_daily_global), 3, 'IA : compteur global = requêtes acceptées');

-- Une heure plus tard (lignes vieillies de 2 h) : le plafond JOURNALIER prend le relais.
update public.ai_coach_usage set requested_at = requested_at - interval '2 hours' where user_id = :A;
set role service_role;
select t.ok((public.consume_ai_quota(:A, 0) ->> 'allowed')::boolean, 'IA : 4e requête du jour acceptée');
select t.ok((public.consume_ai_quota(:A, 0) ->> 'allowed')::boolean, 'IA : 5e requête du jour acceptée');
select t.eq(public.consume_ai_quota(:A, 0) ->> 'reason', 'user_daily', 'IA : 6e requête du jour refusée (plafond 5/24 h)');

-- Plafond global : B n'a consommé aucun quota personnel, mais le global (7) est atteint après 2.
select t.ok((public.consume_ai_quota(:B, 0) ->> 'allowed')::boolean, 'IA global : B 1/2');
select t.ok((public.consume_ai_quota(:B, 0) ->> 'allowed')::boolean, 'IA global : B 2/2');
select t.eq(public.consume_ai_quota(:B, 0) ->> 'reason', 'global_daily', 'IA global : 8e requête du jour refusée (plafond global 7)');
select t.ok((public.consume_ai_quota(:B, 0) ->> 'retry_after_seconds')::int between 1 and 86400,
  'IA global : retry_after jusqu''à minuit UTC');
reset role;
select t.eq((select requests from public.ai_coach_daily_global), 7, 'IA global : compteur jamais au-delà du plafond');
select t.eq((select count(*) from public.ai_coach_usage)::int, 7, 'IA global : 7 lignes d''usage au total');

-- Compatibilité 009 : consume_ai_coach_quota renvoie un booléen et respecte les nouveaux plafonds.
delete from public.ai_coach_daily_global;
delete from public.ai_coach_usage;
set role service_role;
select t.eq(public.consume_ai_coach_quota(:B, 10, 50), true, 'compat 009 : booléen true');
select t.eq(public.consume_ai_coach_quota(:B, 1, 50), false, 'compat 009 : p_limit plus bas appliqué');
select t.eq(public.consume_ai_coach_quota(:B, 1000, 50), true, 'compat 009 : p_limit plus haut ne dépasse pas le plafond configuré (2/3)');
select t.eq(public.consume_ai_coach_quota(:B, 1000, 50), true, 'compat 009 : 3/3');
select t.eq(public.consume_ai_coach_quota(:B, 1000, 50), false, 'compat 009 : 4e refusée (plafond configuré 3, pas 1000)');
select t.eq(public.consume_ai_quota(:A, 0, 0) ->> 'reason', 'user_hourly', 'p_hourly_limit = 0 : tout refusé');

-- Taille, interrupteur, paramètres invalides.
select t.eq(public.consume_ai_quota(:A, 40001) ->> 'reason', 'prompt_too_large', 'IA : requête trop grosse refusée');
reset role;
update public.ai_coach_limits set enabled = false;
set role service_role;
select t.eq(public.consume_ai_quota(:A, 0) ->> 'reason', 'disabled', 'IA : interrupteur d''urgence');
reset role;
update public.ai_coach_limits set enabled = true;
set role service_role;
select t.throws($$select public.consume_ai_quota(null)$$, '22023', 'IA : p_user null refusé');
select t.throws($$select public.consume_ai_quota('aaaaaaaa-0000-0000-0000-00000000000a', -1)$$, '22023', 'IA : taille négative refusée');
select t.throws($$select public.consume_ai_quota('99999999-0000-0000-0000-000000000009')$$, '23503', 'IA : utilisateur inconnu refusé');
reset role;
select t.throws($$update public.ai_coach_limits set daily_global = 0$$, '23514', 'IA : plafond global ≥ 1 imposé');
select t.throws($$insert into public.ai_coach_limits (id) values (2)$$, '23514', 'IA : une seule ligne de configuration');

-- ── consume_rate_limit ────────────────────────────────────────────────────
set role service_role;
create temp table rl (n serial, res jsonb);
insert into rl (res) select public.consume_rate_limit('report_error_ip', 'f00dcafe', 3, 3600) from generate_series(1, 5);
select t.eq((select string_agg(res ->> 'allowed', ',' order by n) from rl), 'true,true,true,false,false',
  'rate limit : 3 acceptés puis refus');
select t.eq((select string_agg(res ->> 'count', ',' order by n) from rl), '1,2,3,3,3',
  'rate limit : un refus n''incrémente plus le compteur');
select t.ok((select (res ->> 'retry_after_seconds')::int from rl where n = 4) between 1 and 3600, 'rate limit : retry_after');
select t.ok((public.consume_rate_limit('report_error_ip', 'other', 3, 3600) ->> 'allowed')::boolean,
  'rate limit : sujets indépendants');
select t.ok((public.consume_rate_limit('delete_account', 'f00dcafe', 3, 3600) ->> 'allowed')::boolean,
  'rate limit : scopes indépendants');
reset role;
update public.rate_limits set window_start = window_start - interval '2 hours', window_end = window_end - interval '2 hours'
where scope = 'report_error_ip' and subject = 'f00dcafe';
set role service_role;
select t.eq(public.consume_rate_limit('report_error_ip', 'f00dcafe', 3, 3600) ->> 'count', '1',
  'rate limit : nouvelle fenêtre, compteur remis à 1');
select t.throws($$select public.consume_rate_limit('report_error_ip', '203.0.113.7', 3, 60)$$, '22023',
  'rate limit : IPv4 brute refusée (exiger un HMAC)');
select t.throws($$select public.consume_rate_limit('report_error_ip', '2001:db8::1', 3, 60)$$, '22023',
  'rate limit : IPv6 brute refusée');
select t.throws($$select public.consume_rate_limit('Bad Scope', 'x', 3, 60)$$, '22023', 'rate limit : scope invalide refusé');
select t.throws($$select public.consume_rate_limit('s', repeat('a', 129), 3, 60)$$, '22023', 'rate limit : sujet trop long refusé');
select t.throws($$select public.consume_rate_limit('s', 'x', 0, 60)$$, '22023', 'rate limit : limite 0 refusée');
select t.throws($$select public.consume_rate_limit('s', 'x', 1, 86401)$$, '22023', 'rate limit : fenêtre > 24 h refusée');

-- ── Purge ─────────────────────────────────────────────────────────────────
reset role;
insert into public.ai_coach_usage (user_id, requested_at) values (:A, now() - interval '31 days');
insert into public.ai_coach_daily_global (day, requests) values (current_date - 40, 5);
insert into public.rate_limits (scope, subject, window_start, window_end, count)
values ('report_error_ip', 'expired', now() - interval '2 hours', now() - interval '1 hour', 9);
set role service_role;
create temp table pr as select public.purge_security_counters() as res;
reset role;
select t.eq((select (res ->> 'ai_coach_usage')::int from pr), 1, 'purge : usage IA > 30 jours supprimé');
select t.eq((select (res ->> 'ai_coach_daily_global')::int from pr), 1, 'purge : compteur global > 30 jours supprimé');
select t.eq((select (res ->> 'rate_limits')::int from pr), 1, 'purge : fenêtre de rate limit expirée supprimée');
select t.ok((select count(*) from public.rate_limits) > 0, 'purge : fenêtres en cours conservées');
select t.ok((select count(*) from public.ai_coach_usage) > 0, 'purge : usage récent conservé');
rollback;
