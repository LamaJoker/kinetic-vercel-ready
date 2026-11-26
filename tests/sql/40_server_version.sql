-- 40 — La version (updated_at) est fixée par le SERVEUR : le client ne peut pas la forcer.
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
begin;
select t.login(:A);
set role authenticated;

insert into public.user_storage (user_id, key, value, updated_at, created_at)
values (:A, 'v:1', '1', '2099-01-01', '2000-01-01');
select t.ok((select updated_at from public.user_storage where key = 'v:1') < now() + interval '1 minute',
  'INSERT avec updated_at = 2099 : ignoré (heure serveur)');
select t.ok((select created_at from public.user_storage where key = 'v:1') > '2001-01-01',
  'INSERT avec created_at forcé : ignoré');

create temp table v (ts timestamptz);
insert into v select updated_at from public.user_storage where key = 'v:1';
update public.user_storage set value = '2', updated_at = '1999-01-01', created_at = '1999-01-01' where key = 'v:1';
select t.ok((select updated_at from public.user_storage where key = 'v:1') > (select ts from v),
  'UPDATE avec updated_at = 1999 : ignoré, version croissante');
select t.ok((select created_at from public.user_storage where key = 'v:1') > '2001-01-01', 'UPDATE : created_at préservé');

-- Upsert direct avec updated_at dans le futur (chemin ancien client).
insert into public.user_storage (user_id, key, value, updated_at) values (:A, 'v:1', '3', '2099-01-01')
on conflict (user_id, key) do update set value = excluded.value, updated_at = excluded.updated_at;
select t.ok((select updated_at from public.user_storage where key = 'v:1') < now() + interval '1 minute',
  'upsert avec updated_at futur : ignoré');

-- Versions strictement croissantes par utilisateur, même dans une seule transaction.
insert into public.user_storage (user_id, key, value) select :A, 'v:m' || g, '0' from generate_series(1, 50) g;
select t.eq((select count(distinct updated_at) from public.user_storage where key like 'v:m%')::int, 50,
  '50 écritures dans une transaction : 50 versions distinctes');
select t.ok((select max(updated_at) from public.user_storage where key like 'v:m%')
  <= (select last_version from public.user_storage_usage where user_id = :A), 'last_version = plus grande version émise');

-- Même si l'horloge recule (simulation : last_version dans le futur proche), la version reste croissante.
reset role;
update public.user_storage_usage set last_version = clock_timestamp() + interval '10 seconds' where user_id = :A;
delete from v;
insert into v select last_version from public.user_storage_usage where user_id = :A;
set role authenticated;
update public.user_storage set value = '4' where key = 'v:1';
select t.eq((select updated_at from public.user_storage where key = 'v:1'), (select ts + interval '1 microsecond' from v),
  'horloge en retard : version = last_version + 1 µs (monotonie)');

-- user_id / key immuables.
select t.throws($$update public.user_storage set key = 'v:renamed' where key = 'v:1'$$, '22023', 'renommer une clé : refusé');
reset role;
rollback;
