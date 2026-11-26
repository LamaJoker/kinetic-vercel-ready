-- 20 — sync_push : ok / conflit / rejet / report, par élément, sans échec global.
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
begin;
select t.login(:A);
set role authenticated;

create temp table r (n int primary key, res jsonb);

-- Création (base null).
insert into r values (1, public.sync_push('[{"key":"k:settings","value":{"unit":"kg"},"base":null}]'));
select t.eq((select res -> 0 ->> 'status' from r where n = 1), 'ok', 'création avec base null : ok');
select t.ok((select (res -> 0 ->> 'updated_at')::timestamptz from r where n = 1) is not null, 'ok renvoie la nouvelle version');
select t.eq((select res -> 0 -> 'deleted' from r where n = 1), 'false'::jsonb, 'ok renvoie deleted = false');

-- Mise à jour avec la bonne base.
insert into r select 2, public.sync_push(jsonb_build_array(jsonb_build_object(
  'key', 'k:settings', 'value', '{"unit":"lb"}'::jsonb, 'base', (select res -> 0 ->> 'updated_at' from r where n = 1))));
select t.eq((select res -> 0 ->> 'status' from r where n = 2), 'ok', 'mise à jour avec base = version serveur : ok');
select t.ok((select (res -> 0 ->> 'updated_at')::timestamptz from r where n = 2)
  > (select (res -> 0 ->> 'updated_at')::timestamptz from r where n = 1), 'la version augmente');
select t.eq((select value from public.user_storage where key = 'k:settings'), '{"unit":"lb"}'::jsonb, 'valeur écrite');

-- Base périmée : conflit, valeur serveur renvoyée, rien d'écrit.
insert into r select 3, public.sync_push(jsonb_build_array(jsonb_build_object(
  'key', 'k:settings', 'value', '{"unit":"st"}'::jsonb, 'base', (select res -> 0 ->> 'updated_at' from r where n = 1))));
select t.eq((select res -> 0 ->> 'status' from r where n = 3), 'conflict', 'base périmée : conflit');
select t.eq((select res -> 0 -> 'server_value' from r where n = 3), '{"unit":"lb"}'::jsonb, 'conflit : server_value');
select t.eq((select res -> 0 -> 'server_deleted' from r where n = 3), 'false'::jsonb, 'conflit : server_deleted = false');
select t.eq((select res -> 0 ->> 'updated_at' from r where n = 3), (select res -> 0 ->> 'updated_at' from r where n = 2),
  'conflit : updated_at = version serveur courante');
select t.eq((select value from public.user_storage where key = 'k:settings'), '{"unit":"lb"}'::jsonb, 'conflit : rien écrit');

-- Base null alors que la clé existe : conflit.
select t.eq(public.sync_push('[{"key":"k:settings","value":{"unit":"x"},"base":null}]') -> 0 ->> 'status', 'conflict',
  'base null sur clé existante : conflit');

-- Idempotence : renvoyer exactement l'état serveur (réponse perdue puis réessai) → ok sans nouvelle version.
insert into r select 4, public.sync_push(jsonb_build_array(jsonb_build_object(
  'key', 'k:settings', 'value', '{"unit":"lb"}'::jsonb, 'base', (select res -> 0 ->> 'updated_at' from r where n = 1))));
select t.eq((select res -> 0 ->> 'status' from r where n = 4), 'ok', 'réessai idempotent : ok');
select t.eq((select res -> 0 ->> 'updated_at' from r where n = 4), (select res -> 0 ->> 'updated_at' from r where n = 2),
  'réessai idempotent : pas de nouvelle version');

-- Valeur JSON null (vivante) ≠ suppression ≠ absence.
select t.eq(public.sync_push('[{"key":"k:nullable","value":null,"base":null}]') -> 0 ->> 'status', 'ok', 'valeur JSON null acceptée');
select t.eq((select (deleted, value) from public.user_storage where key = 'k:nullable'), (false, 'null'::jsonb),
  'valeur null stockée comme ligne VIVANTE');
select t.eq(public.sync_push('[{"key":"k:nov","base":null}]') -> 0 ->> 'reason', 'missing_value',
  'élément sans value ni deleted : rejeté missing_value');

-- Suppression (tombstone) avec base correcte.
insert into r select 5, public.sync_push(jsonb_build_array(jsonb_build_object(
  'key', 'k:settings', 'deleted', true, 'base', (select res -> 0 ->> 'updated_at' from r where n = 2))));
select t.eq((select res -> 0 ->> 'status' from r where n = 5), 'ok', 'tombstone : ok');
select t.eq((select res -> 0 -> 'deleted' from r where n = 5), 'true'::jsonb, 'tombstone : deleted = true');
select t.eq((select (deleted, value, deleted_at is not null) from public.user_storage where key = 'k:settings'),
  (true, 'null'::jsonb, true), 'tombstone stockée (deleted, value null, deleted_at)');

-- Écriture sur une tombstone avec une base périmée : conflit server_deleted, sans server_value.
insert into r select 6, public.sync_push(jsonb_build_array(jsonb_build_object(
  'key', 'k:settings', 'value', '{"unit":"kg"}'::jsonb, 'base', (select res -> 0 ->> 'updated_at' from r where n = 2))));
select t.eq((select res -> 0 ->> 'status' from r where n = 6), 'conflict', 'écriture sur tombstone avec base périmée : conflit');
select t.eq((select res -> 0 -> 'server_deleted' from r where n = 6), 'true'::jsonb, 'conflit : server_deleted = true');
select t.ok((select not (res -> 0 ? 'server_value') from r where n = 6), 'conflit sur tombstone : pas de server_value');
-- Re-supprimer une tombstone : idempotent.
select t.eq(public.sync_push('[{"key":"k:settings","deleted":true,"base":null}]') -> 0 ->> 'status', 'ok',
  'supprimer une clé déjà supprimée : ok idempotent');
-- Recréation en connaissance de cause (base = version de la tombstone).
insert into r select 7, public.sync_push(jsonb_build_array(jsonb_build_object(
  'key', 'k:settings', 'value', '{"unit":"kg"}'::jsonb, 'base', (select res -> 0 ->> 'updated_at' from r where n = 5))));
select t.eq((select res -> 0 ->> 'status' from r where n = 7), 'ok', 'recréation avec base = tombstone : ok');
select t.eq((select (deleted, value) from public.user_storage where key = 'k:settings'), (false, '{"unit":"kg"}'::jsonb),
  'clé recréée vivante');
-- Suppression d'une clé jamais vue : tombstone créée.
select t.eq(public.sync_push('[{"key":"k:never","deleted":true,"base":null}]') -> 0 ->> 'status', 'ok',
  'suppression d''une clé absente : ok (tombstone créée)');
select t.ok((select deleted from public.user_storage where key = 'k:never'), 'tombstone créée pour clé absente');

-- Lot mixte : un mauvais élément n'empêche pas les autres.
insert into r values (8, public.sync_push(jsonb_build_array(
  jsonb_build_object('key', 'k:good1', 'value', 1, 'base', null),
  jsonb_build_object('key', 'bad key!', 'value', 1, 'base', null),
  jsonb_build_object('key', repeat('k', 201), 'value', 1, 'base', null),
  jsonb_build_object('key', 'k:big', 'value', repeat('x', 1048577), 'base', null),
  jsonb_build_object('key', 'k:good1', 'value', 2, 'base', null),
  '"pas un objet"'::jsonb,
  jsonb_build_object('key', 'k:badbase', 'value', 1, 'base', 'pas une date'),
  jsonb_build_object('key', 'k:baddel', 'deleted', 'oui', 'base', null),
  jsonb_build_object('key', 'k:good2', 'value', '[1,2,3]'::jsonb, 'base', null)
)));
select t.eq((select jsonb_array_length(res) from r where n = 8), 9, 'un résultat par élément, dans l''ordre');
select t.eq((select res -> 0 ->> 'status' from r where n = 8), 'ok', 'élément valide 1 : ok');
select t.eq((select res -> 1 ->> 'reason' from r where n = 8), 'invalid_key', 'clé invalide : rejected invalid_key');
select t.eq((select res -> 1 ->> 'status' from r where n = 8), 'rejected', 'clé invalide : status rejected');
select t.eq((select res -> 2 ->> 'reason' from r where n = 8), 'invalid_key', 'clé > 200 caractères : invalid_key');
select t.eq((select res -> 3 ->> 'reason' from r where n = 8), 'value_too_large', 'valeur > 1 Mo : value_too_large');
select t.eq((select res -> 4 ->> 'reason' from r where n = 8), 'duplicate_key', 'clé en double dans le lot : duplicate_key');
select t.eq((select res -> 5 ->> 'reason' from r where n = 8), 'invalid_item', 'élément non objet : invalid_item');
select t.eq((select res -> 6 ->> 'reason' from r where n = 8), 'invalid_base', 'base non date : invalid_base');
select t.eq((select res -> 7 ->> 'reason' from r where n = 8), 'invalid_item', 'deleted non booléen : invalid_item');
select t.eq((select res -> 8 ->> 'status' from r where n = 8), 'ok', 'élément valide 2 : ok malgré les rejets');
select t.eq((select value from public.user_storage where key = 'k:good2'), '[1,2,3]'::jsonb, 'élément valide 2 écrit');
select t.ok(not exists (select 1 from public.user_storage where key = 'k:big'), 'valeur trop grosse non écrite');

-- Plus de 100 éléments : le surplus est « deferred » (à renvoyer), pas d'échec.
insert into r select 9, public.sync_push((select jsonb_agg(jsonb_build_object('key', 'k:many:' || g, 'value', g, 'base', null))
  from generate_series(1, 105) g));
select t.eq((select count(*) from jsonb_array_elements((select res from r where n = 9)) e where e ->> 'status' = 'ok')::int, 100,
  '105 éléments : 100 écrits');
select t.eq((select count(*) from jsonb_array_elements((select res from r where n = 9)) e
  where e ->> 'status' = 'deferred' and e ->> 'reason' = 'batch_limit')::int, 5, '105 éléments : 5 deferred batch_limit');

-- Taille du lot > 4 Mo : le surplus est reporté.
insert into r select 10, public.sync_push((select jsonb_agg(jsonb_build_object('key', 'k:heavy:' || g,
  'value', repeat('h', 1000000), 'base', null)) from generate_series(1, 6) g));
select t.eq((select count(*) from jsonb_array_elements((select res from r where n = 10)) e where e ->> 'status' = 'ok')::int, 4,
  'lot de 6 × 1 Mo : 4 écrits (≤ 4 Mo)');
select t.eq((select count(*) from jsonb_array_elements((select res from r where n = 10)) e where e ->> 'status' = 'deferred')::int, 2,
  'lot de 6 × 1 Mo : 2 reportés');

-- Quota par élément : on place le compteur juste sous la limite (superuser).
reset role;
update public.user_storage_usage set bytes = public.user_storage_max_bytes() - 50 where user_id = :A;
set role authenticated;
insert into r values (11, public.sync_push(jsonb_build_array(
  jsonb_build_object('key', 'k:small', 'value', 1, 'base', null),
  jsonb_build_object('key', 'k:toobig', 'value', repeat('q', 200), 'base', null),
  jsonb_build_object('key', 'k:small2', 'value', 2, 'base', null))));
select t.eq((select res -> 0 ->> 'status' from r where n = 11), 'ok', 'quota : petit élément ok');
select t.eq((select res -> 1 ->> 'reason' from r where n = 11), 'quota_bytes', 'quota : élément qui dépasse → rejected quota_bytes');
select t.eq((select res -> 2 ->> 'status' from r where n = 11), 'ok', 'quota : élément suivant ok');
select t.ok(not exists (select 1 from public.user_storage where key = 'k:toobig'), 'quota : élément rejeté non écrit');
reset role;
update public.user_storage_usage set keys = public.user_storage_max_keys(), bytes = 0 where user_id = :A;
set role authenticated;
select t.eq(public.sync_push('[{"key":"k:onemore","value":1,"base":null}]') -> 0 ->> 'reason', 'quota_keys',
  'quota de clés atteint : rejected quota_keys');
select t.eq(t.item(public.sync_push(jsonb_build_array(jsonb_build_object('key', 'k:good2', 'value', '[1]'::jsonb,
  'base', (select updated_at from public.user_storage where key = 'k:good2')))), 'k:good2') ->> 'status', 'ok',
  'quota de clés atteint : mise à jour d''une clé existante toujours possible');
select t.eq(t.item(public.sync_push(jsonb_build_array(jsonb_build_object('key', 'k:good2', 'deleted', true,
  'base', (select updated_at from public.user_storage where key = 'k:good2')))), 'k:good2') ->> 'status', 'ok',
  'quota atteint : suppression toujours possible');

-- Entrée invalide globale : erreur explicite.
select t.throws($$select public.sync_push('{"key":"x"}')$$, '22023', 'p_items non tableau : 22023');
select t.eq(public.sync_push('[]'), '[]'::jsonb, 'lot vide : résultat vide');
reset role;
rollback;
