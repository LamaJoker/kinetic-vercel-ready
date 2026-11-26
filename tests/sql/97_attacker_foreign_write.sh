#!/usr/bin/env bash
# 97 — Revue « attaquant » (011) : un INSERT dans user_storage portant le user_id
# d'un AUTRE utilisateur ne doit exécuter aucun code privilégié sur les données de la
# victime.
#
# Scénario : le trigger BEFORE user_storage_10_before_write (010) est SECURITY DEFINER
# et s'exécute AVANT le contrôle RLS (WITH CHECK). Un compte quelconque qui envoyait
# INSERT (user_id = victime) prenait donc le verrou de la ligne user_storage_usage de
# la victime (et y écrivait) avant d'être refusé : en rafale, il bloquait la synchro de
# la victime. Correction : trigger user_storage_01_owner_check (SECURITY INVOKER),
# déclenché en premier, qui refuse (42501) sans rien verrouiller.
# Lancé par scripts/test-sql.sh (PGHOST/PGPORT/PGUSER/PGDATABASE exportés).
set -euo pipefail
Q() { psql -X -q -v ON_ERROR_STOP=1 -At "$@"; }
fail() { echo "ÉCHEC : $1"; exit 1; }
ok() { echo "ok - $1"; }
ATT=d7000000-0000-0000-0000-00000000000a
VIC=d7000000-0000-0000-0000-00000000000b
OUT="$(mktemp -d "${TMPDIR:-/tmp}/kinetic-sec97.XXXXXX")"
HOLDER=""

cleanup() {
  [[ -n "$HOLDER" ]] && kill "$HOLDER" 2>/dev/null || true
  Q -c "delete from auth.users where id in ('$ATT','$VIC')" >/dev/null 2>&1 || true
  rm -rf "$OUT"
}
trap cleanup EXIT

Q -c "insert into auth.users (id, email) values ('$ATT','att@test.local'),('$VIC','vic@test.local')" \
  -c "insert into public.user_storage_usage (user_id) values ('$VIC') on conflict (user_id) do nothing" >/dev/null

# Écriture de l'attaquant (rôle authenticated, JWT de l'attaquant) avec le user_id de la
# victime ; lock_timeout court : si le verrou de la victime est demandé, 55P03.
attack() {
  Q -c "select t.login('$ATT')" -c "set role authenticated" -c "set lock_timeout = '1500ms'" \
    -c "do \$\$ begin
          insert into public.user_storage (user_id, key, value) values ('$VIC', 'pirate', '1'::jsonb);
          raise notice 'STATE=00000';
        exception when others then
          raise notice 'STATE=%', sqlstate;
        end \$\$" 2>&1 | sed -n 's/.*STATE=\([0-9A-Z]*\).*/\1/p'
}

# 1. Sans contention : refus 42501.
state="$(attack)"
[[ "$state" == 42501 ]] || fail "INSERT pour la victime : 42501 attendu (obtenu '$state')"
ok "INSERT avec le user_id d'un autre : refusé (42501)"

# 2. La victime est en pleine synchro (verrou de sa ligne de compteur tenu 6 s).
Q -c "begin" \
  -c "select 1 from public.user_storage_usage where user_id = '$VIC' for update" \
  -c "select pg_sleep(6) /* kinetic-sec97-holder */" -c "commit" >/dev/null 2>&1 &
HOLDER=$!
for _ in $(seq 1 100); do
  n="$(Q -c "select count(*) from pg_stat_activity where state = 'active' and query like '%kinetic-sec97-holder%' and pid <> pg_backend_pid()")"
  [[ "$n" -ge 1 ]] && break
  sleep 0.05
done
[[ "$n" -ge 1 ]] || fail "la session de la victime n'a pas démarré"

start=$(date +%s%N)
state="$(attack)"
elapsed_ms=$(( ($(date +%s%N) - start) / 1000000 ))
[[ "$state" == 42501 ]] || fail "pendant la synchro de la victime : 42501 immédiat attendu (obtenu '$state' : l'attaquant a attendu le verrou de la victime)"
ok "pendant la synchro de la victime : refus immédiat, aucun verrou de la victime demandé"
[[ "$elapsed_ms" -lt 1500 ]] || fail "refus trop lent ($elapsed_ms ms)"
ok "refus en ${elapsed_ms} ms (< lock_timeout)"
wait "$HOLDER" || true
HOLDER=""

# 3. Rien n'a été écrit chez la victime ; l'attaquant écrit toujours chez lui.
n="$(Q -c "select count(*) from public.user_storage where user_id = '$VIC'")"
[[ "$n" == 0 ]] || fail "ligne écrite chez la victime"
ok "aucune ligne écrite chez la victime"
Q -c "select t.login('$ATT')" -c "set role authenticated" \
  -c "insert into public.user_storage (user_id, key, value) values ('$ATT', 'mine', '1'::jsonb)" >/dev/null \
  || fail "écriture légitime de l'attaquant sur ses propres données refusée"
ok "écriture sur ses propres données : toujours acceptée"
