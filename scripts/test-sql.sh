#!/usr/bin/env bash
# scripts/test-sql.sh — tests SQL des migrations Supabase sur un Postgres 16 jetable.
#
#   pnpm test:sql            (ou bash scripts/test-sql.sh)
#
# 1. crée un cluster Postgres 16 jetable : initdb local si disponible, sinon Docker
#    (image postgres:16) ;
# 2. installe le shim Supabase (tests/sql/00_supabase_shim.sql) ;
# 3. applique les migrations 001→009, des données « ancien client »
#    (tests/sql/seed_legacy.sql), puis 010 et suivantes, DEUX fois (idempotence) ;
# 4. exécute tests/sql/NN_*.sql (et NN_*.sh) dans l'ordre ; échoue au premier échec ;
# 5. arrête et supprime le cluster dans tous les cas.
#
# Variables : TEST_SQL_DIR (dossier de travail, défaut : mktemp), TEST_SQL_PORT,
#             PG_BIN (dossier des binaires Postgres), TEST_SQL_MODE=local|docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_DIR="$ROOT/tests/sql"
MIG_DIR="$ROOT/supabase/migrations"
DB=kinetic
ADMIN=supabase_admin

find_pg_bin() {
  if [[ -n "${PG_BIN:-}" && -x "$PG_BIN/initdb" ]]; then echo "$PG_BIN"; return; fi
  if [[ -x /usr/lib/postgresql/16/bin/initdb ]]; then echo /usr/lib/postgresql/16/bin; return; fi
  if command -v pg_config >/dev/null 2>&1; then
    local d; d="$(pg_config --bindir)"
    if [[ -x "$d/initdb" ]] && "$d/postgres" --version | grep -q ' 16\.'; then echo "$d"; return; fi
  fi
  if command -v initdb >/dev/null 2>&1 && initdb --version | grep -q ' 16\.'; then
    dirname "$(command -v initdb)"; return
  fi
  echo ""
}

MODE="${TEST_SQL_MODE:-}"
PGBIN="$(find_pg_bin)"
if [[ -z "$MODE" ]]; then
  if [[ -n "$PGBIN" ]]; then MODE=local
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then MODE=docker
  else echo "test-sql : ni Postgres 16 (initdb) ni Docker disponible" >&2; exit 2
  fi
fi
command -v psql >/dev/null 2>&1 || { echo "test-sql : psql introuvable" >&2; exit 2; }

CREATED_DIR=""
if [[ -n "${TEST_SQL_DIR:-}" ]]; then
  WORK="$TEST_SQL_DIR"; mkdir -p "$WORK"
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/kinetic-sql.XXXXXX")"; CREATED_DIR="$WORK"
fi
WORK="$(cd "$WORK" && pwd)"
PORT="${TEST_SQL_PORT:-}"
CONTAINER=""
SOCK=""
RUN_AS=()

cleanup() {
  local code=$?
  if [[ "$MODE" == local && -d "$WORK/data" ]]; then
    "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$WORK/data" "$WORK/log" "$WORK"/.s.PGSQL.* 2>/dev/null || true
  fi
  if [[ -n "$SOCK" ]]; then rm -rf "$SOCK"; fi
  if [[ -n "$CONTAINER" ]]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  if [[ -n "$CREATED_DIR" ]]; then rm -rf "$CREATED_DIR"; fi
  exit $code
}
trap cleanup EXIT INT TERM

free_port() {
  local p
  for p in $(seq 55432 55532); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "$p"; return; fi
  done
  echo 55432
}

if [[ "$MODE" == local ]]; then
  PORT="${PORT:-$(free_port)}"
  if [[ "$(id -u)" == 0 ]]; then
    # initdb refuse root : le cluster tourne sous l'utilisateur postgres.
    id postgres >/dev/null 2>&1 || { echo "test-sql : utilisateur système postgres absent" >&2; exit 2; }
    RUN_AS=(runuser -u postgres --)
    chown postgres "$WORK"
    if ! "${RUN_AS[@]}" test -w "$WORK"; then
      echo "test-sql : $WORK inaccessible à l'utilisateur postgres (dossier parent fermé ?)" >&2
      exit 2
    fi
  fi
  # Chemin de socket Unix limité à ~107 octets : dossier court dédié.
  SOCK="$(mktemp -d /tmp/kpgsock.XXXXXX)"
  [[ ${#RUN_AS[@]} -gt 0 ]] && chown postgres "$SOCK"
  "${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U "$ADMIN" -A trust -E UTF8 --no-locale >/dev/null
  if ! "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -l "$WORK/log" -w \
    -o "-p $PORT -k $SOCK -c listen_addresses= -c fsync=off" start >/dev/null; then
    cat "$WORK/log" >&2; exit 1
  fi
  export PGHOST="$SOCK"
else
  PORT="${PORT:-$(free_port)}"
  CONTAINER="kinetic-sql-test-$$"
  docker run -d --rm --name "$CONTAINER" -e POSTGRES_USER="$ADMIN" \
    -e POSTGRES_HOST_AUTH_METHOD=trust -p "127.0.0.1:$PORT:5432" postgres:16 >/dev/null
  export PGHOST=127.0.0.1
  for _ in $(seq 1 60); do
    if psql -h 127.0.0.1 -p "$PORT" -U "$ADMIN" -d postgres -Atqc 'select 1' >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi
export PGPORT="$PORT" PGUSER="$ADMIN" PGDATABASE="$DB"

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null
"${PSQL[@]}" -f "$SQL_DIR/00_supabase_shim.sql" >/dev/null

apply() { # $1 = fichier de migration ; appliquée par le rôle postgres, en une transaction
  if ! out="$("${PSQL[@]}" -U postgres --single-transaction -f "$1" 2>&1)"; then
    echo "$out" >&2; echo "ÉCHEC migration $(basename "$1")" >&2; exit 1
  fi
}

echo "▶ migrations (Postgres $MODE, port $PORT)"
seeded=0
for m in "$MIG_DIR"/*.sql; do
  n="$(basename "$m")"
  if [[ $seeded == 0 && $((10#${n%%_*})) -ge 10 ]]; then
    "${PSQL[@]}" -f "$SQL_DIR/seed_legacy.sql" >/dev/null; seeded=1
  fi
  apply "$m"; echo "  ✓ $n"
done
[[ $seeded == 1 ]] || "${PSQL[@]}" -f "$SQL_DIR/seed_legacy.sql" >/dev/null
for m in "$MIG_DIR"/*.sql; do
  n="$(basename "$m")"
  if [[ $((10#${n%%_*})) -ge 10 ]]; then apply "$m"; echo "  ✓ $n (rejouée : idempotente)"; fi
done

"${PSQL[@]}" -f "$SQL_DIR/01_test_helpers.sql" >/dev/null

total=0
echo "▶ tests"
for f in "$SQL_DIR"/[1-9][0-9]_*; do
  n="$(basename "$f")"
  case "$n" in
    *.sql) if ! out="$("${PSQL[@]}" -f "$f" 2>&1)"; then fail=1; else fail=0; fi ;;
    *.sh)  if ! out="$(bash "$f" 2>&1)"; then fail=1; else fail=0; fi ;;
    *) continue ;;
  esac
  count="$(grep -c 'ok - ' <<<"$out" || true)"
  if [[ $fail == 1 ]] || grep -q 'ÉCHEC' <<<"$out"; then
    echo "$out" | grep -E 'ok - |ÉCHEC|ERROR|ERREUR' >&2 || echo "$out" >&2
    echo "✗ $n" >&2
    exit 1
  fi
  total=$((total + count))
  echo "  ✓ $n ($count assertions)"
done
echo "▶ $total assertions OK"
