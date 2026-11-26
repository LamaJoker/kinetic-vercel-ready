-- tests/sql/seed_legacy.sql — données « d'avant 010 », écrites APRÈS 001→009 et
-- AVANT 010, par les chemins d'un ancien client (upsert direct en authenticated).
-- Vérifiées par 15_upgrade.sql une fois 010 appliquée. Validé (commit).

insert into auth.users (id, email) values ('cccccccc-0000-0000-0000-00000000000c', 'c@test.local');

set role authenticated;
select set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-00000000000c', false);

insert into public.user_storage (user_id, key, value)
values ('cccccccc-0000-0000-0000-00000000000c', 'kinetic:xp', '120'),
       ('cccccccc-0000-0000-0000-00000000000c', 'kinetic:training:session:s1', '{"id":"s1","name":"Push"}'),
       ('cccccccc-0000-0000-0000-00000000000c', 'kinetic:userProfile', '{"name":"Céline"}')
on conflict (user_id, key) do update set value = excluded.value;

-- Ancien défaut SEC-10 : une version dans le futur fixée par le client.
insert into public.user_storage (user_id, key, value, updated_at)
values ('cccccccc-0000-0000-0000-00000000000c', 'kinetic:future', '"x"', '2099-01-01');

-- Mise à jour d'une valeur existante (ancien chemin).
update public.user_storage set value = '130'
where user_id = 'cccccccc-0000-0000-0000-00000000000c' and key = 'kinetic:xp';

reset role;
