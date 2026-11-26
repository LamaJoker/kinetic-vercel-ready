#!/usr/bin/env bash
# 95 — Sécurité (011) : quotas atomiques sous concurrence réelle (connexions séparées,
# transactions validées), comme les appels parallèles des fonctions Edge.
#  - consume_ai_quota : 25 appels simultanés d'un même compte → exactement le plafond horaire ;
#  - plafond global : 3 comptes × 10 appels simultanés → exactement le plafond global ;
#  - consume_rate_limit : 30 appels simultanés → exactement la limite ;
#  - push_subscriptions : 15 insertions simultanées d'un même compte → exactement 10.
# Lancé par scripts/test-sql.sh (PGHOST/PGPORT/PGUSER/PGDATABASE exportés).
set -euo pipefail
Q() { psql -X -q -v ON_ERROR_STOP=1 -At "$@"; }
fail() { echo "ÉCHEC : $1"; exit 1; }
ok() { echo "ok - $1"; }
U1=c0c0c0c0-0000-0000-0000-000000000001
U2=c0c0c0c0-0000-0000-0000-000000000002
U3=c0c0c0c0-0000-0000-0000-000000000003
U4=c0c0c0c0-0000-0000-0000-000000000004
OUT="$(mktemp -d "${TMPDIR:-/tmp}/kinetic-sec95.XXXXXX")"

cleanup() {
  Q -c "delete from auth.users where id in ('$U1','$U2','$U3','$U4')" \
    -c "delete from public.rate_limits where scope = 'test_concurrency'" \
    -c "delete from public.ai_coach_daily_global" \
    -c "update public.ai_coach_limits set hourly_per_user = 10, daily_per_user = 30, daily_global = 2000, enabled = true" \
    >/dev/null 2>&1 || true
  rm -rf "$OUT"
}
trap cleanup EXIT

Q -c "insert into auth.users (id, email) values ('$U1','u1@test.local'),('$U2','u2@test.local'),('$U3','u3@test.local'),('$U4','u4@test.local')" >/dev/null
Q -c "delete from public.ai_coach_daily_global" \
  -c "update public.ai_coach_limits set hourly_per_user = 10, daily_per_user = 30, daily_global = 2000, enabled = true" >/dev/null

# ── Plafond horaire par utilisateur ─────────────────────────────────────────
for i in $(seq 1 25); do
  Q -c "set role service_role" -c "select public.consume_ai_quota('$U1', 10) ->> 'allowed'" >"$OUT/ai1.$i" &
done
wait
allowed=$(cat "$OUT"/ai1.* | grep -c '^true$' || true)
[[ "$allowed" == 10 ]] || fail "plafond horaire : 10 acceptés attendus sur 25 simultanés (obtenu $allowed)"
ok "consume_ai_quota : 25 appels simultanés, exactement 10 acceptés (plafond horaire)"
rows=$(Q -c "select count(*) from public.ai_coach_usage where user_id = '$U1'")
[[ "$rows" == 10 ]] || fail "10 lignes d'usage attendues (obtenu $rows)"
ok "consume_ai_quota : exactement 10 lignes d'usage (aucun refus consommé)"

# ── Plafond global ──────────────────────────────────────────────────────────
Q -c "update public.ai_coach_limits set daily_global = coalesce((select requests from public.ai_coach_daily_global where day = (now() at time zone 'utc')::date), 0) + 12" >/dev/null
for u in $U2 $U3 $U4; do
  for i in $(seq 1 10); do
    Q -c "set role service_role" -c "select public.consume_ai_quota('$u', 10) ->> 'allowed'" >"$OUT/ai2.$u.$i" &
  done
done
wait
allowed=$(cat "$OUT"/ai2.* | grep -c '^true$' || true)
[[ "$allowed" == 12 ]] || fail "plafond global : 12 acceptés attendus sur 30 simultanés (obtenu $allowed)"
ok "consume_ai_quota : 3 comptes × 10 appels simultanés, exactement 12 acceptés (plafond global)"
over=$(Q -c "select (select requests from public.ai_coach_daily_global where day = (now() at time zone 'utc')::date) = (select daily_global from public.ai_coach_limits)")
[[ "$over" == t ]] || fail "compteur global différent du plafond"
ok "compteur global égal au plafond, jamais au-delà"

# ── Limiteur générique ──────────────────────────────────────────────────────
for i in $(seq 1 30); do
  Q -c "set role service_role" -c "select public.consume_rate_limit('test_concurrency', 'abc123', 7, 86400) ->> 'allowed'" >"$OUT/rl.$i" &
done
wait
allowed=$(cat "$OUT"/rl.* | grep -c '^true$' || true)
[[ "$allowed" == 7 ]] || fail "rate limit : 7 acceptés attendus sur 30 simultanés (obtenu $allowed)"
ok "consume_rate_limit : 30 appels simultanés, exactement 7 acceptés"
cnt=$(Q -c "select count from public.rate_limits where scope = 'test_concurrency' and subject = 'abc123'")
[[ "$cnt" == 7 ]] || fail "compteur du rate limit attendu à 7 (obtenu $cnt)"
ok "consume_rate_limit : compteur exact (pas d'incrément sur refus)"

# ── Plafond d'abonnements push ──────────────────────────────────────────────
for i in $(seq 1 15); do
  Q -c "set role authenticated" -c "set request.jwt.claim.sub = '$U1'" \
    -c "insert into public.push_subscriptions (endpoint, user_id, p256dh, auth) values ('https://fcm.googleapis.com/fcm/send/conc-$i', '$U1', 'k', 'a')" \
    >/dev/null 2>&1 &
done
wait || true
n=$(Q -c "select count(*) from public.push_subscriptions where user_id = '$U1'")
[[ "$n" == 10 ]] || fail "push : 10 abonnements attendus après 15 insertions simultanées (obtenu $n)"
ok "push_subscriptions : 15 insertions simultanées, exactement 10 acceptées"
