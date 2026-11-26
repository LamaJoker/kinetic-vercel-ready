#!/usr/bin/env bash
# 90 — Concurrence réelle (plusieurs connexions validées) :
#  - F11 : une transaction lente ne peut plus être « doublée » par le curseur de pull ;
#  - deux lots sync_push concurrents du même compte, clés en ordre inverse : pas d'interblocage.
# Lancé par scripts/test-sql.sh (PGHOST/PGPORT/PGUSER/PGDATABASE exportés).
set -euo pipefail
D=dddddddd-0000-0000-0000-00000000000d
Q() { psql -X -q -v ON_ERROR_STOP=1 -At "$@"; }
AS_D="set role authenticated; set request.jwt.claim.sub = '$D';"
fail() { echo "ÉCHEC : $1"; exit 1; }
ok() { echo "ok - $1"; }

Q -c "insert into auth.users (id, email) values ('$D', 'd@test.local')"
trap 'Q -c "delete from auth.users where id = '"'$D'"'" >/dev/null 2>&1 || true' EXIT

# ── F11 ────────────────────────────────────────────────────────────────────
# T1 écrit c:slow puis reste ouverte 3 s ; T2 écrit c:xp à +1 s ; un appareil tire à +2 s.
( Q <<SQL
$AS_D
begin;
insert into public.user_storage (user_id, key, value) values ('$D', 'c:slow', '"lent"');
select pg_sleep(3);
commit;
SQL
) >/dev/null &
T1=$!
sleep 1
start=$(date +%s%N)
( Q -c "$AS_D" -c "insert into public.user_storage (user_id, key, value) values ('$D', 'c:xp', '1')" ) &
T2=$!
sleep 1
mid=$(Q -c "$AS_D" -c "select jsonb_array_length(public.sync_pull_v2(null) -> 'changes')")
[[ "$mid" == 0 ]] || fail "pendant T1 : le pull ne doit rien voir (obtenu $mid)"
ok "pendant la transaction lente, le pull ne voit ni c:slow ni c:xp (curseur inchangé)"
wait $T1
wait $T2
waited_ms=$(( ($(date +%s%N) - start) / 1000000 ))
(( waited_ms > 1300 )) || fail "T2 aurait dû attendre la fin de T1 (attente $waited_ms ms)"
ok "l'écriture concurrente du même compte attend la validation de T1 ($waited_ms ms)"
order=$(Q -c "$AS_D" -c "select string_agg(e->>'key', ',' order by o) from jsonb_array_elements(public.sync_pull_v2(null)->'changes') with ordinality x(e,o)")
[[ "$order" == "c:slow,c:xp" ]] || fail "ordre des versions attendu c:slow,c:xp (obtenu $order)"
ok "version(c:slow) < version(c:xp) : un curseur posé sur c:xp ne peut pas sauter c:slow"

# ── Lots concurrents, clés en ordre inverse ─────────────────────────────────
run_batches() { # $1 = ordre des clés
  for i in $(seq 1 15); do
    Q -c "$AS_D" -c "select public.sync_push('$1')" >/dev/null
  done
}
run_batches '[{"key":"c:k1","value":1,"base":null},{"key":"c:k2","value":1,"base":null}]' &
P1=$!
run_batches '[{"key":"c:k2","value":2,"base":null},{"key":"c:k1","value":2,"base":null}]' &
P2=$!
wait $P1 || fail "lot concurrent 1 en erreur"
wait $P2 || fail "lot concurrent 2 en erreur"
ok "30 lots sync_push concurrents (ordre de clés inverse) : aucune erreur ni interblocage"
n=$(Q -c "$AS_D" -c "select count(*) from public.user_storage where key in ('c:k1','c:k2')")
[[ "$n" == 2 ]] || fail "2 clés attendues (obtenu $n)"
ok "état final cohérent : 2 clés"
exact=$(Q -c "select (select (keys, bytes) from t.actual_usage('$D')) = (select (keys, bytes) from t.expected_usage('$D'))")
[[ "$exact" == t ]] || fail "compteur de quota inexact après concurrence"
ok "compteur de quota exact après écritures concurrentes"
