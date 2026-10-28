#!/usr/bin/env bash
#
# fleet-status — one-screen view of a Paperclip fleet: who is working, who is
# idle, what is waiting on a human, and which wakeups are stuck.
#
# Read-only. It issues SELECTs against the instance database and refuses to run
# outside a read-only transaction (see "Read-only boundary" below).
#
# Usage
#   scripts/fleet-status.sh                     # render once
#   scripts/fleet-status.sh --json              # machine-readable, same facts
#   scripts/fleet-status.sh --watch 60          # re-render every 60s
#   scripts/fleet-status.sh --company Delegra   # scope to one company (name or id)
#   scripts/fleet-status.sh --db <dsn>          # override the connection string
#
# Exit codes (identical for text and JSON)
#   0  nothing needs a human right now
#   1  at least one item needs a human (see "What counts as attention")
#   2  the panel is unavailable: bad usage, psql missing, unreachable database,
#      query/schema failure, unparsable row, or a scope that matches no agent
#
#   --watch keeps running and does not propagate these codes; each failure is
#   reported on stderr and the next interval still runs.
#
# What counts as attention (exit 1)
#   · a live run older than --running-slow, or silent longer than --run-silent
#   · a run stuck in the queue longer than --wake-stale
#   · in-progress cards that no live run, fresh wakeup or recovery action covers
#     and that carry no monitor of their own
#   · in_review work that is not the card of a live run
#   · a paused agent that still holds unfinished work
#   · agent status error / pending_approval
#   · failed wakeup requests inside the --wake-window window
#   · queued or deferred wakeups older than --wake-stale when no run could be
#     draining them; behind a live run the same queue is reported, not flagged
#
# What does NOT count as attention (exit 0)
#   · an idle agent with no unfinished work — that is free capacity, not a
#     problem. It is reported so you can hand it work, and nothing more.
#   · an idle agent whose work is covered by a scheduled monitor, a queued
#     wakeup, or an active recovery action — something is already moving.
#
# Deliberately not decided here
#   A long or silent run is reported as a run to inspect. This panel does not
#   claim the run is wedged, does not recommend interrupting it, and does not
#   suggest rewriting or clearing any field. Those calls need the run log,
#   process state and artifacts, which this tool does not read.
#
# Read-only boundary
#   Every statement runs with default_transaction_read_only=on, so a write
#   fails instead of succeeding quietly. The panel also sets statement_timeout
#   and lock_timeout so a blocked read cannot hang a shell, and it verifies the
#   read-only setting before trusting the session.
#
# Data source and schema dependency
#   Direct SQL, not the HTTP API. The board API exposes aggregate counts
#   (/dashboard) and a decision feed (/attention), both behind board auth, and
#   neither carries per-agent run state. This tool therefore depends on these
#   relations: companies, agents, issues, heartbeat_runs, agent_wakeup_requests,
#   issue_recovery_actions. A schema change to any of them needs a matching
#   change here; a missing relation fails loudly with exit 2, and a missing
#   column surfaces as a query failure.
#
#   Embedded PostgreSQL (DATABASE_URL unset) has no TCP endpoint, so this tool
#   needs an external PostgreSQL instance.
#
# Dependencies: bash >= 3.2 and the psql client. No python, no jq.

set -uo pipefail

readonly PROG="fleet-status"
readonly SCHEMA_VERSION=1
readonly FIELD_COUNT=21
readonly FS=$'\x1f'

# Defaults. Override with flags; see usage().
DB_DSN=""
COMPANY=""
MODE="text"
WATCH=""

RUNNING_SLOW=25   # minutes a live run may age before it is worth inspecting
RUN_SILENT=10     # minutes without output before a live run is worth inspecting
TODO_IDLE=8       # minutes of no update on in-progress work before it is stale
REVIEW_WAIT=15    # minutes in_review may wait before it is called backlogged
WAKE_WINDOW_H=3   # hours of failed-wakeup history to summarise
WAKE_STALE=30     # minutes a queued/deferred wakeup may wait before it is stale

STATEMENT_TIMEOUT_MS=15000
LOCK_TIMEOUT_MS=3000

ROWS=""
SQL_OUT=""
SQL_ERR=""
ERR_FILE=""

# Summary counters, filled by the single classification pass.
N_TOTAL=0
N_BUSY=0
N_QUEUED=0
N_IDLE_WORK=0
N_WAITING=0
N_FREE=0
N_PAUSED=0
N_ERROR=0
N_PENDING_APPROVAL=0
A_AGENTS=0
A_LONG_RUNNING=0
A_SILENT_RUN=0
A_IDLE_WORK=0
A_PAUSED_WORK=0
A_AGENT_ERROR=0
A_PENDING_APPROVAL=0
A_REVIEW=0
A_FAILED_WAKE=0
A_STALE_WAKE=0
A_FAILED_WAKE_EVENTS=0
A_STALE_WAKE_EVENTS=0
NEEDS_ATTENTION=0
SCOPE_NAMES=""
SCOPE_MULTI=0
EXCLUDED_TERMINATED=0
GENERATED_AT=""
GENERATED_AT_ISO=""
UTF8_LOCALE=""

usage() {
  cat <<'EOF'
fleet-status — read-only Paperclip fleet panel.

Usage:
  scripts/fleet-status.sh [options]

Options:
  --json                 emit one JSON document instead of the text panel
  --watch <seconds>      re-render every <seconds> until interrupted
  --company <name|id>    limit the panel to one company (default: all companies)
  --db <dsn>             PostgreSQL connection string
  --running-slow <min>   live-run age that is worth inspecting   (default 25)
  --run-silent <min>     live-run silence worth inspecting        (default 10)
  --todo-idle <min>      in-progress age the note calls stale     (default 8)
  --review-wait <min>    in_review age the note calls backlogged  (default 15)
  --wake-window <hours>  failed-wakeup history window             (default 3)
  --wake-stale <min>     queued-wakeup wait that reads as stale   (default 30)
  -h, --help             show this help

Exit codes:
  0  nothing needs a human
  1  something needs a human
  2  panel unavailable (usage, psql, connection, query, schema, empty scope)

--todo-idle and --review-wait grade the note only: they do not change whether a
row is flagged. An in-progress card with no run, no wake, no monitor and no
recovery is anomalous at any age, because a healthy fleet always leaves one of
those behind.

Connection string resolution order: --db, PAPERCLIP_FLEET_DATABASE_URL,
DATABASE_URL, then postgresql://delegra_app@127.0.0.1:5432/delegra.

Thresholds can also be set through FLEET_RUNNING_SLOW, FLEET_RUN_SILENT,
FLEET_TODO_IDLE, FLEET_REVIEW_WAIT, FLEET_WAKE_WINDOW_H and FLEET_WAKE_STALE.
EOF
}

die() {
  printf '%s: %s\n' "$PROG" "$*" >&2
  exit 2
}

warn() {
  printf '%s: %s\n' "$PROG" "$*" >&2
}

# ---------------------------------------------------------------- arguments

# Validates in the current shell: a die inside $(...) would only exit the
# subshell and let the script continue with an empty value.
assert_uint() {
  local name=$1 value=$2
  case "$value" in
    ''|*[!0-9]*) die "$name needs a non-negative integer, got '$value'" ;;
  esac
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) MODE="json"; shift ;;
      --watch|--watch=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--watch needs a number of seconds"
          val=$2; shift
        fi
        assert_uint "--watch" "$val"
        [ "$val" -ge 1 ] || die "--watch needs at least 1 second"
        WATCH=$val; shift ;;
      --company|--company=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--company needs a company name or id"
          val=$2; shift
        fi
        [ -n "$val" ] || die "--company needs a company name or id"
        while [ "${val# }" != "$val" ]; do val=${val# }; done
        while [ "${val% }" != "$val" ]; do val=${val% }; done
        COMPANY=$val; shift ;;
      --db|--db=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--db needs a connection string"
          val=$2; shift
        fi
        [ -n "$val" ] || die "--db needs a connection string"
        DB_DSN=$val; shift ;;
      --running-slow|--running-slow=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--running-slow needs minutes"
          val=$2; shift
        fi
        assert_uint "--running-slow" "$val"; RUNNING_SLOW=$val; shift ;;
      --run-silent|--run-silent=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--run-silent needs minutes"
          val=$2; shift
        fi
        assert_uint "--run-silent" "$val"; RUN_SILENT=$val; shift ;;
      --todo-idle|--todo-idle=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--todo-idle needs minutes"
          val=$2; shift
        fi
        assert_uint "--todo-idle" "$val"; TODO_IDLE=$val; shift ;;
      --review-wait|--review-wait=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--review-wait needs minutes"
          val=$2; shift
        fi
        assert_uint "--review-wait" "$val"; REVIEW_WAIT=$val; shift ;;
      --wake-window|--wake-window=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--wake-window needs hours"
          val=$2; shift
        fi
        assert_uint "--wake-window" "$val"; WAKE_WINDOW_H=$val; shift ;;
      --wake-stale|--wake-stale=*)
        local val="${1#*=}"
        if [ "$val" = "$1" ]; then
          [ $# -ge 2 ] || die "--wake-stale needs minutes"
          val=$2; shift
        fi
        assert_uint "--wake-stale" "$val"; WAKE_STALE=$val; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument '$1' (try --help)" ;;
    esac
  done

  # Environment fallbacks keep --watch invocations short.
  if [ -n "${FLEET_RUNNING_SLOW:-}" ]; then
    assert_uint FLEET_RUNNING_SLOW "$FLEET_RUNNING_SLOW"; RUNNING_SLOW=$FLEET_RUNNING_SLOW
  fi
  if [ -n "${FLEET_RUN_SILENT:-}" ]; then
    assert_uint FLEET_RUN_SILENT "$FLEET_RUN_SILENT"; RUN_SILENT=$FLEET_RUN_SILENT
  fi
  if [ -n "${FLEET_TODO_IDLE:-}" ]; then
    assert_uint FLEET_TODO_IDLE "$FLEET_TODO_IDLE"; TODO_IDLE=$FLEET_TODO_IDLE
  fi
  if [ -n "${FLEET_REVIEW_WAIT:-}" ]; then
    assert_uint FLEET_REVIEW_WAIT "$FLEET_REVIEW_WAIT"; REVIEW_WAIT=$FLEET_REVIEW_WAIT
  fi
  if [ -n "${FLEET_WAKE_WINDOW_H:-}" ]; then
    assert_uint FLEET_WAKE_WINDOW_H "$FLEET_WAKE_WINDOW_H"; WAKE_WINDOW_H=$FLEET_WAKE_WINDOW_H
  fi
  if [ -n "${FLEET_WAKE_STALE:-}" ]; then
    assert_uint FLEET_WAKE_STALE "$FLEET_WAKE_STALE"; WAKE_STALE=$FLEET_WAKE_STALE
  fi

  if [ -z "$DB_DSN" ]; then
    DB_DSN="${PAPERCLIP_FLEET_DATABASE_URL:-${DATABASE_URL:-postgresql://delegra_app@127.0.0.1:5432/delegra}}"
  fi

  if [ -n "$WATCH" ] && [ "$MODE" = "json" ]; then
    warn "--json with --watch emits one JSON document per interval, not one stream."
  fi
}

# ---------------------------------------------------------------- transport

# Runs SQL from stdin in a read-only session with a bounded runtime. stdout is
# the data stream; stderr goes to ERR_FILE so a NOTICE can never corrupt rows.
query() {
  SQL_OUT=$(PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=${LOCK_TIMEOUT_MS}" \
    psql "$DB_DSN" -X -q -t -A -F "$FS" -v ON_ERROR_STOP=1 \
      -v company="$COMPANY" \
      -v wake_window_h="$WAKE_WINDOW_H" \
      -v wake_stale="$WAKE_STALE" \
      -f - 2>"$ERR_FILE")
  local rc=$?
  SQL_ERR=$(<"$ERR_FILE")
  return $rc
}

explain_sql_failure() {
  local rc=$1 err=$2
  case "$rc" in
    2) warn "cannot connect to the database (psql exit 2)."
       warn "  check --db / PAPERCLIP_FLEET_DATABASE_URL / DATABASE_URL."
       warn "  note: embedded PostgreSQL (DATABASE_URL unset) has no TCP endpoint,"
       warn "  so this panel needs an external PostgreSQL instance." ;;
    3) warn "the query failed (psql exit 3)." ;;
    *) warn "psql failed (exit $rc)." ;;
  esac
  if [ -n "$err" ]; then
    printf '%s\n' "$err" | sed 's/^/  /' >&2
  fi
  case "$err" in
    *"does not exist"*|*"no such table"*)
      warn "  a missing relation or column means the database schema and this"
      warn "  panel have drifted; update scripts/fleet-status.sh to match." ;;
  esac
}

preflight() {
  command -v psql >/dev/null 2>&1 || die "psql not found in PATH; install the PostgreSQL client."

  query <<'SQL'
SELECT current_setting('default_transaction_read_only'),
       coalesce((
         SELECT string_agg(name, ',' ORDER BY name)
         FROM (VALUES
           ('agents'),
           ('agent_wakeup_requests'),
           ('companies'),
           ('heartbeat_runs'),
           ('issue_recovery_actions'),
           ('issues')
         ) AS required(name)
         WHERE to_regclass(current_schema() || '.' || name) IS NULL
       ), '');
SQL
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    explain_sql_failure "$rc" "$SQL_ERR"
    return 2
  fi

  local ro missing rest
  ro=${SQL_OUT%%"$FS"*}
  rest=${SQL_OUT#*"$FS"}
  missing=${rest%%"$FS"*}
  if [ "$ro" != "on" ]; then
    die "refusing to run: the session is not read-only (default_transaction_read_only=$ro)."
  fi
  if [ -n "$missing" ]; then
    die "missing relation(s): $missing. The database schema and this panel have drifted."
  fi
  return 0
}

# Resolves the company scope in one round trip: how many companies matched,
# their names, and how many terminated agents the scope holds. A scope that
# matches nothing is a configuration problem, not an all-clear.
resolve_scope() {
  query <<'SQL'
WITH scoped AS (
  SELECT id, name, status
  FROM companies
  WHERE :'company' = ''
     OR id::text = :'company'
     OR lower(name) = lower(:'company')
)
SELECT (SELECT count(*) FROM scoped)::text,
       (SELECT coalesce(string_agg(name, '|' ORDER BY name), '') FROM scoped),
       (SELECT count(*) FROM scoped WHERE status = 'archived')::text,
       (SELECT count(*) FROM agents a
        JOIN scoped s ON s.id = a.company_id
        WHERE a.status = 'terminated' AND s.status <> 'archived')::text;
SQL
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    explain_sql_failure "$rc" "$SQL_ERR"
    return 2
  fi

  local count rest archived
  count=${SQL_OUT%%"$FS"*}
  rest=${SQL_OUT#*"$FS"}
  SCOPE_NAMES=${rest%%"$FS"*}
  rest=${rest#*"$FS"}
  archived=${rest%%"$FS"*}
  EXCLUDED_TERMINATED=${rest#*"$FS"}

  case "$count" in
    ''|*[!0-9]*) die "unexpected scope answer from the database: '$count'" ;;
  esac
  case "$EXCLUDED_TERMINATED" in
    ''|*[!0-9]*) EXCLUDED_TERMINATED=0 ;;
  esac
  case "$archived" in
    ''|*[!0-9]*) archived=0 ;;
  esac
  if [ "$count" -eq 0 ]; then
    if [ -n "$COMPANY" ]; then
      die "no company matches --company '$COMPANY'."
    fi
    die "no company rows found; check that --db points at the intended instance."
  fi
  if [ "$archived" -eq "$count" ]; then
    die "scope '$SCOPE_NAMES' is archived; the panel excludes archived companies."
  fi
  if [ "$count" -gt 1 ]; then SCOPE_MULTI=1; fi
  return 0
}

# ---------------------------------------------------------------- data

fetch_rows() {
  query <<'SQL'
WITH live_run AS (
  -- The run that best explains what an agent is doing right now: a running run
  -- outranks a queued one, which outranks a scheduled retry.
  SELECT DISTINCT ON (r.agent_id)
         r.agent_id,
         r.status,
         r.issue_id,
         r.created_at,
         r.started_at,
         r.last_output_at,
         (SELECT i.identifier FROM issues i WHERE i.id = r.issue_id) AS card
  FROM heartbeat_runs r
  WHERE r.status IN ('running', 'queued', 'scheduled_retry')
    AND (:'company' = '' OR r.company_id IN (
      SELECT id FROM companies WHERE id::text = :'company' OR lower(name) = lower(:'company')))
  ORDER BY r.agent_id,
           CASE r.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
           r.created_at DESC
),
card_stats AS (
  -- Conversation containers, hidden rows and non-execution harness rows are
  -- not work cards, so they are excluded the same way the board excludes them.
  -- The review age skips the card of the live run, so "waiting for a decision"
  -- never reports the age of work that is currently being executed.
  SELECT i.assignee_agent_id AS agent_id,
         count(*) FILTER (WHERE i.status IN ('todo', 'in_progress')) AS active_cards,
         count(*) FILTER (WHERE i.status IN ('todo', 'in_progress')
                            AND i.monitor_next_check_at IS NOT NULL) AS active_monitored,
         count(*) FILTER (WHERE i.status = 'in_review') AS review_cards,
         count(*) FILTER (WHERE i.status IN ('backlog', 'blocked')) AS parked_cards,
         now() - min(i.updated_at) FILTER (WHERE i.status IN ('todo', 'in_progress')) AS oldest_active,
         now() - min(i.updated_at) FILTER (
           WHERE i.status = 'in_review' AND i.id IS DISTINCT FROM lr.issue_id
         ) AS oldest_review
  FROM issues i
  LEFT JOIN live_run lr ON lr.agent_id = i.assignee_agent_id
  WHERE i.status NOT IN ('done', 'cancelled')
    AND i.hidden_at IS NULL
    AND i.harness_kind IS NULL
    AND i.conversation_agent_id IS NULL
    AND (:'company' = '' OR i.company_id IN (
      SELECT id FROM companies WHERE id::text = :'company' OR lower(name) = lower(:'company')))
  GROUP BY i.assignee_agent_id
),
pending_wake AS (
  -- No time window: a wakeup that has waited for hours is the interesting case.
  -- "claimed" is deliberately excluded: it records that a run took the wakeup,
  -- and not every completion path advances the row to a terminal status, so
  -- counting it would report permanent backlog.
  SELECT w.agent_id,
         count(*) AS n,
         count(*) FILTER (
           WHERE w.created_at < now() - (:'wake_stale'::int * interval '1 minute')
         ) AS stale_n,
         now() - min(w.created_at) AS oldest
  FROM agent_wakeup_requests w
  WHERE w.status IN ('queued', 'deferred_issue_execution')
    AND (:'company' = '' OR w.company_id IN (
      SELECT id FROM companies WHERE id::text = :'company' OR lower(name) = lower(:'company')))
  GROUP BY w.agent_id
),
failed_wake AS (
  -- deferred_issue_execution is a queue state the scheduler resumes, not a
  -- failure, so it is deliberately absent from this bucket.
  SELECT w.agent_id,
         count(*) AS n,
         mode() WITHIN GROUP (
           ORDER BY left(coalesce(nullif(btrim(w.error), ''), w.reason, 'unknown'), 60)
         ) AS detail
  FROM agent_wakeup_requests w
  WHERE w.status = 'failed'
    AND w.created_at > now() - (:'wake_window_h'::int * interval '1 hour')
    AND (:'company' = '' OR w.company_id IN (
      SELECT id FROM companies WHERE id::text = :'company' OR lower(name) = lower(:'company')))
  GROUP BY w.agent_id
),
recovery AS (
  SELECT ra.owner_agent_id AS agent_id, count(*) AS n
  FROM issue_recovery_actions ra
  WHERE ra.status IN ('active', 'escalated')
    AND (:'company' = '' OR ra.company_id IN (
      SELECT id FROM companies WHERE id::text = :'company' OR lower(name) = lower(:'company')))
  GROUP BY ra.owner_agent_id
)
SELECT
  regexp_replace(c.name, '[[:cntrl:]]', ' ', 'g'),
  regexp_replace(a.name, '[[:cntrl:]]', ' ', 'g'),
  regexp_replace(a.status, '[[:cntrl:]]', ' ', 'g'),
  regexp_replace(coalesce(a.pause_reason, ''), '[[:cntrl:]]', ' ', 'g'),
  regexp_replace(coalesce(lr.status, ''), '[[:cntrl:]]', ' ', 'g'),
  regexp_replace(coalesce(lr.card, ''), '[[:cntrl:]]', ' ', 'g'),
  -- Run age counts from the start of this execution attempt, falling back to
  -- creation time for a run that has not started yet. NULL stays NULL so the
  -- caller can tell "no run" apart from "zero minutes".
  coalesce((extract(epoch FROM now() - coalesce(lr.started_at, lr.created_at)) / 60)::int, -1),
  -- Silence counts from the later of the last output and this attempt's start,
  -- so a restarted attempt never inherits silence from an earlier one.
  coalesce((extract(epoch FROM now()
      - greatest(lr.last_output_at, coalesce(lr.started_at, lr.created_at))) / 60)::int, -1),
  coalesce(cs.active_cards, 0),
  coalesce(cs.active_monitored, 0),
  coalesce(cs.review_cards, 0),
  (SELECT count(*) FROM issues x WHERE x.id = lr.issue_id AND x.status = 'in_review'),
  coalesce(cs.parked_cards, 0),
  coalesce((extract(epoch FROM cs.oldest_active) / 60)::int, -1),
  coalesce((extract(epoch FROM cs.oldest_review) / 60)::int, -1),
  coalesce(fw.n, 0),
  regexp_replace(coalesce(fw.detail, ''), '[[:cntrl:]]', ' ', 'g'),
  coalesce(pw.n, 0),
  coalesce(pw.stale_n, 0),
  coalesce((extract(epoch FROM pw.oldest) / 60)::int, -1),
  coalesce(rc.n, 0)
FROM agents a
JOIN companies c ON c.id = a.company_id
LEFT JOIN live_run lr ON lr.agent_id = a.id
LEFT JOIN card_stats cs ON cs.agent_id = a.id
LEFT JOIN pending_wake pw ON pw.agent_id = a.id
LEFT JOIN failed_wake fw ON fw.agent_id = a.id
LEFT JOIN recovery rc ON rc.agent_id = a.id
WHERE a.status <> 'terminated'
  AND c.status <> 'archived'
  AND (:'company' = '' OR c.id::text = :'company' OR lower(c.name) = lower(:'company'))
ORDER BY c.name, (lr.status IS NOT NULL) DESC, a.name;
SQL
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    explain_sql_failure "$rc" "$SQL_ERR"
    return 2
  fi
  return 0
}

# ---------------------------------------------------------------- classify

# Globals set by classify_row: ROW_STATE, ROW_ATTENTION (space-separated codes),
# ROW_NOTE (one human sentence), ROW_REVIEW_PENDING.
ROW_STATE=""
ROW_ATTENTION=""
ROW_NOTE=""
ROW_REVIEW_PENDING=0

# classify_row reads the 21 fields of one row from its arguments.
#
# The rule this encodes: a state is only called out when the database shows no
# waiting path for it. A live run, a scheduled monitor, a queued wakeup and an
# active recovery action all count as something already moving.
classify_row() {
  local company=$1 name=$2 status=$3 pause_reason=$4
  local run_state=$5 run_card=$6 run_age=$7 run_silent=$8
  local active=$9 monitored=${10} review=${11} review_in_run=${12} parked=${13}
  local oldest_active=${14} oldest_review=${15}
  local failed=${16} failed_detail=${17}
  local pending=${18} stale_pending=${19} oldest_pending=${20} recoveries=${21}

  ROW_ATTENTION=""
  ROW_NOTE=""
  ROW_REVIEW_PENDING=$((review - review_in_run))
  if [ "$ROW_REVIEW_PENDING" -lt 0 ]; then ROW_REVIEW_PENDING=0; fi

  # Cards that nothing is scheduled to pick up. A live run, a fresh queued
  # wakeup or an active recovery covers the whole agent; a monitor only covers
  # the card it is attached to, so it is subtracted per card rather than
  # suppressing the whole row.
  #
  # A queued wakeup only counts as a path while it is fresh. Treating a stale
  # queue as a path would print "waiting to be claimed" and "queued for six
  # hours" about the same wakeup in one row.
  local fresh_pending=$((pending - stale_pending))
  if [ "$fresh_pending" -lt 0 ]; then fresh_pending=0; fi
  local uncovered=0
  if [ "$active" -gt 0 ] && [ "$fresh_pending" -eq 0 ] && [ "$recoveries" -eq 0 ]; then
    uncovered=$((active - monitored))
    if [ "$uncovered" -lt 0 ]; then uncovered=0; fi
  fi

  case "$run_state" in
    running|queued|scheduled_retry)
      if [ "$run_state" = "running" ]; then ROW_STATE="busy"; else ROW_STATE="queued"; fi
      if [ "$run_state" = "running" ] && [ "$run_age" -ge "$RUNNING_SLOW" ]; then
        ROW_ATTENTION="$ROW_ATTENTION long_run"
        if [ "$run_silent" -ge "$RUN_SILENT" ]; then
          ROW_ATTENTION="$ROW_ATTENTION silent_run"
          ROW_NOTE="运行 ${run_age}m，已 ${run_silent}m 无新输出：核对运行日志与产物"
        else
          ROW_NOTE="运行 ${run_age}m：核对进度与产物"
        fi
      elif [ "$run_state" != "running" ] && [ "$run_age" -ge "$WAKE_STALE" ]; then
        ROW_ATTENTION="$ROW_ATTENTION stale_run"
        ROW_NOTE="已 ${run_age}m 未进入运行：核对唤醒与并发上限"
      fi
      ;;
    *)
      # No live run. Agent-level status decides the branch before work does,
      # otherwise a paused agent is misreported as an idle one.
      case "$status" in
        paused)
          ROW_STATE="paused"
          if [ $((active + review)) -gt 0 ]; then
            ROW_ATTENTION="$ROW_ATTENTION paused_with_work"
            ROW_NOTE="已暂停但仍有 ${active} 办 / ${review} 审 未结${pause_reason:+（原因 ${pause_reason}）}：确认是否有意为之"
          elif [ -n "$pause_reason" ]; then
            ROW_NOTE="已暂停（原因 ${pause_reason}）"
          fi
          ;;
        error)
          ROW_STATE="error"
          ROW_ATTENTION="$ROW_ATTENTION agent_error"
          ROW_NOTE="agent 状态为 error：核对最近一次运行的失败原因"
          ;;
        pending_approval)
          ROW_STATE="pending_approval"
          ROW_ATTENTION="$ROW_ATTENTION pending_approval"
          ROW_NOTE="等待审批"
          ;;
        *)
          if [ "$uncovered" -gt 0 ]; then
            ROW_STATE="idle_with_work"
            ROW_ATTENTION="$ROW_ATTENTION idle_with_work"
            if [ "$oldest_active" -ge "$TODO_IDLE" ]; then
              ROW_NOTE="有 ${uncovered} 张在办卡无监控兜底，且无运行/可用唤醒/恢复动作：最久 ${oldest_active}m 未更新"
            else
              ROW_NOTE="有 ${uncovered} 张在办卡无监控兜底，且无运行/可用唤醒/恢复动作"
            fi
          elif [ "$active" -gt 0 ]; then
            ROW_STATE="waiting"
            if [ "$monitored" -gt 0 ]; then
              ROW_NOTE="有 ${active} 张在办卡，已挂监控：等待下次检查"
            elif [ "$fresh_pending" -gt 0 ]; then
              ROW_NOTE="有 ${active} 张在办卡，已有排队唤醒 ${fresh_pending} 条：等待领取"
            else
              ROW_NOTE="有 ${active} 张在办卡"
            fi
          else
            ROW_STATE="free"
          fi
          ;;
      esac
      ;;
  esac

  if [ "$stale_pending" -gt 0 ]; then
    if [ -z "$run_state" ]; then
      # Nothing is running, so nothing can be draining this queue.
      ROW_ATTENTION="$ROW_ATTENTION stale_wake"
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}；}排队超 ${WAKE_STALE}m 的唤醒 ${stale_pending} 条（最久 ${oldest_pending}m）"
    else
      # A live run serialises its agent's wakeups, so an old queue entry is not
      # by itself a fault. Report the fact without claiming attention.
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}；}另有排队唤醒 ${stale_pending} 条（最久 ${oldest_pending}m），当前有运行在跑或排队，未计入超时"
    fi
  fi

  if [ "$failed" -gt 0 ]; then
    ROW_ATTENTION="$ROW_ATTENTION failed_wake"
    if [ -n "$failed_detail" ]; then
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}；}近 ${WAKE_WINDOW_H}h 失败唤醒 ${failed} 条（${failed_detail}）"
    else
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}；}近 ${WAKE_WINDOW_H}h 失败唤醒 ${failed} 条"
    fi
  fi

  if [ "$ROW_REVIEW_PENDING" -gt 0 ]; then
    ROW_ATTENTION="$ROW_ATTENTION review_waiting"
    if [ "$oldest_review" -ge "$REVIEW_WAIT" ]; then
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}；}待裁决 ${ROW_REVIEW_PENDING} 张，最久 ${oldest_review}m"
    else
      ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}；}待裁决 ${ROW_REVIEW_PENDING} 张"
    fi
  fi

  if [ "$recoveries" -gt 0 ]; then
    ROW_NOTE="${ROW_NOTE:+${ROW_NOTE}；}恢复动作进行中 ${recoveries} 条"
  fi

  # Trim the single leading space left by the append pattern above. A sed here
  # cost more than the rest of the row put together.
  ROW_ATTENTION=${ROW_ATTENTION# }
}

# Applies one classified row to the summary counters.
tally_row() {
  local failed_events=${1:-0} stale_events=${2:-0}
  N_TOTAL=$((N_TOTAL + 1))
  case "$ROW_STATE" in
    busy) N_BUSY=$((N_BUSY + 1)) ;;
    queued) N_QUEUED=$((N_QUEUED + 1)) ;;
    idle_with_work) N_IDLE_WORK=$((N_IDLE_WORK + 1)) ;;
    waiting) N_WAITING=$((N_WAITING + 1)) ;;
    free) N_FREE=$((N_FREE + 1)) ;;
    paused) N_PAUSED=$((N_PAUSED + 1)) ;;
    error) N_ERROR=$((N_ERROR + 1)) ;;
    pending_approval) N_PENDING_APPROVAL=$((N_PENDING_APPROVAL + 1)) ;;
  esac

  local code marked=0
  for code in $ROW_ATTENTION; do
    marked=1
    case "$code" in
      long_run|stale_run) A_LONG_RUNNING=$((A_LONG_RUNNING + 1)) ;;
      silent_run) A_SILENT_RUN=$((A_SILENT_RUN + 1)) ;;
      idle_with_work) A_IDLE_WORK=$((A_IDLE_WORK + 1)) ;;
      paused_with_work) A_PAUSED_WORK=$((A_PAUSED_WORK + 1)) ;;
      agent_error) A_AGENT_ERROR=$((A_AGENT_ERROR + 1)) ;;
      pending_approval) A_PENDING_APPROVAL=$((A_PENDING_APPROVAL + 1)) ;;
      review_waiting) A_REVIEW=$((A_REVIEW + ROW_REVIEW_PENDING)) ;;
      failed_wake)
        A_FAILED_WAKE=$((A_FAILED_WAKE + 1))
        A_FAILED_WAKE_EVENTS=$((A_FAILED_WAKE_EVENTS + failed_events)) ;;
      stale_wake)
        A_STALE_WAKE=$((A_STALE_WAKE + 1))
        A_STALE_WAKE_EVENTS=$((A_STALE_WAKE_EVENTS + stale_events)) ;;
    esac
  done
  if [ "$marked" -eq 1 ]; then A_AGENTS=$((A_AGENTS + 1)); fi

  if [ "$marked" -eq 1 ]; then NEEDS_ATTENTION=1; fi
}

# ---------------------------------------------------------------- rendering

# Resolves a UTF-8 locale for character counting. Without one, bash reports byte
# lengths and CJK text is padded to three columns per character.
resolve_utf8_locale() {
  local name
  for name in C.UTF-8 en_US.UTF-8; do
    if [ "$(LC_ALL=$name locale charmap 2>/dev/null)" = "UTF-8" ]; then
      printf '%s' "$name"
      return 0
    fi
  done
  return 1
}

# Sets W to the display width of $1 in terminal columns, computed from bytes
# rather than characters so the table lines up the same way under LC_ALL=C
# (cron, systemd, CI) as it does in an interactive shell. Three-byte characters
# are CJK and occupy two columns; a two-byte character is counted one column
# short, which is rare in agent names and only ever under-pads.
#
# The length calls are builtins scoped by a local LC_ALL, so the per-cell cost
# is arithmetic rather than a fork. The tr/wc fallback runs only on hosts with
# no UTF-8 locale at all.
disp_width() {
  local s=$1 chars bytes
  case "$s" in
    *[!-~]*) ;;
    *) W=${#s}; return ;;
  esac
  if [ -n "$UTF8_LOCALE" ]; then
    local LC_ALL=$UTF8_LOCALE
    chars=${#s}
    local LC_ALL=C
    bytes=${#s}
    W=$(( chars + (bytes - chars) / 2 ))
    return
  fi
  chars=$(printf '%s' "$s" | tr -d '\000-\177' | wc -c | tr -d '[:space:]')
  bytes=$(printf '%s' "$s" | wc -c | tr -d '[:space:]')
  case "$chars$bytes" in
    ''|*[!0-9]*) W=${#s}; return ;;
  esac
  W=$(( (bytes - chars) + (chars / 3) * 2 ))
}

# Resolved once at load time so sourced callers get the same behaviour as an
# executed run.
UTF8_LOCALE=$(resolve_utf8_locale 2>/dev/null) || UTF8_LOCALE=""

# Writes one line of output. A consumer that stops reading (`| head`) is normal
# usage and ends the panel quietly; a failed write to a file or device is a real
# failure and must not be reported as a successful run.
emit() {
  # stderr is silenced for the write itself: bash prints "write error: Broken
  # pipe" for every remaining cell otherwise. Formats here are literals, so the
  # only thing being hidden is that message.
  printf "$@" 2>/dev/null && return 0
  if [ -f /dev/stdout ]; then
    printf '%s: cannot write output\n' "$PROG" >&2
    exit 2
  fi
  exit 0
}

# Sets PADDED to $1 right-padded to $2 display columns.
pad() {
  local s=$1 width=$2 fill
  disp_width "$s"
  fill=$(( width - W ))
  if [ "$fill" -lt 0 ]; then fill=0; fi
  printf -v PADDED '%s%*s' "$s" "$fill" ''
}

# Sets JSON to $1 as a quoted JSON string.
json_string() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\b'/\\b}
  s=${s//$'\f'/\\f}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf -v JSON '"%s"' "$s"
}

json_optional_string() {
  if [ -z "$1" ]; then JSON="null"; else json_string "$1"; fi
}

json_optional_number() {
  if [ -z "$1" ] || [ "$1" -lt 0 ] 2>/dev/null; then
    JSON="null"
  else
    JSON=$1
  fi
}

json_bool() {
  if [ "$1" -eq 1 ]; then JSON="true"; else JSON="false"; fi
}

# The table shows the derived state, not agents.status: a database row can still
# read "idle" while a run is already executing, and the panel's job is to say
# what is happening, not what was last written to the row.
state_label() {
  case "$1" in
    busy) STATE_LABEL='在跑' ;;
    queued) STATE_LABEL='排队' ;;
    idle_with_work) STATE_LABEL='有卡未动' ;;
    waiting) STATE_LABEL='等待' ;;
    free) STATE_LABEL='可派活' ;;
    paused) STATE_LABEL='暂停' ;;
    error) STATE_LABEL='error' ;;
    pending_approval) STATE_LABEL='待审批' ;;
    *) STATE_LABEL=$1 ;;
  esac
}

# Sets JSON to the attention codes as a JSON array.
json_attention_array() {
  local code sep="" out="["
  for code in $ROW_ATTENTION; do
    json_string "$code"
    out="$out$sep$JSON"
    sep=","
  done
  JSON="$out]"
}

# Sets JSON to the resolved company names as a JSON array.
scope_companies_json() {
  local old_ifs=$IFS name first=1 out=""
  IFS='|'
  for name in $SCOPE_NAMES; do
    name=${name# }
    name=${name% }
    if [ "$first" -eq 0 ]; then out="$out, "; fi
    first=0
    json_string "$name"
    out="$out$JSON"
  done
  IFS=$old_ifs
  JSON="[$out]"
}

render_header_text() {
  emit '══ 军团状态 %s ══\n' "$GENERATED_AT"
  emit '范围 %s · 阈值 运行>%sm/静默>%sm · 在办>%sm · 待裁决>%sm · 唤醒窗口 %sh/排队>%sm\n' \
    "$SCOPE_NAMES" "$RUNNING_SLOW" "$RUN_SILENT" "$TODO_IDLE" "$REVIEW_WAIT" "$WAKE_WINDOW_H" "$WAKE_STALE"
  emit '\n'
  local line="" rule=""
  if [ "$SCOPE_MULTI" -eq 1 ]; then
    pad '公司' 10; line="$PADDED "
    rule='---------- '
  fi
  pad 'AGENT' 14; line="$line$PADDED "; rule="$rule-------------- "
  pad '状态' 14; line="$line$PADDED "; rule="$rule-------------- "
  pad '当前卡' 10; line="$line$PADDED "; rule="$rule---------- "
  pad '时长' 8; line="$line$PADDED "; rule="$rule-------- "
  pad '办/审/停' 12; line="$line$PADDED"; rule="$rule------------"
  emit '%s\n' "$line"
  emit '%s\n' "$rule"
}

render_row_text() {
  local company=$1 name=$2 state=$3 run_card=$4 run_age=$5
  local active=$6 review=$7 parked=$8
  local shown_card="-" shown_age="-" line=""

  if [ -n "$run_card" ]; then shown_card=$run_card; fi
  if [ "$run_age" -ge 0 ]; then shown_age="${run_age}m"; fi

  if [ "$SCOPE_MULTI" -eq 1 ]; then
    pad "$company" 10; line="$PADDED "
  fi
  pad "$name" 14; line="$line$PADDED "
  state_label "$state"; pad "$STATE_LABEL" 14; line="$line$PADDED "
  pad "$shown_card" 10; line="$line$PADDED "
  pad "$shown_age" 8; line="$line$PADDED "
  pad "${active}办/${review}审/${parked}停" 12; line="$line$PADDED "
  emit '%s%s\n' "$line" "${ROW_NOTE:-—}"
}

render_footer_text() {
  emit '\n── 汇总 ──\n'
  emit '  agent %s：在跑 %s · 排队 %s · 有卡未动 %s · 有卡等待 %s · 可派活 %s · 暂停 %s · error %s · 待审批 %s\n' \
    "$N_TOTAL" "$N_BUSY" "$N_QUEUED" "$N_IDLE_WORK" "$N_WAITING" "$N_FREE" "$N_PAUSED" "$N_ERROR" "$N_PENDING_APPROVAL"
  emit '  待裁决 in_review %s 张 · 运行较久 %s · 运行静默 %s · 暂停有活 %s · 失败唤醒 %s 条（%s 个 agent）· 排队超时 %s 条（%s 个 agent 无运行在跑）\n' \
    "$A_REVIEW" "$A_LONG_RUNNING" "$A_SILENT_RUN" "$A_PAUSED_WORK" \
    "$A_FAILED_WAKE_EVENTS" "$A_FAILED_WAKE" "$A_STALE_WAKE_EVENTS" "$A_STALE_WAKE"
  if [ "$EXCLUDED_TERMINATED" -gt 0 ]; then
    emit '  已排除 terminated agent %s 个\n' "$EXCLUDED_TERMINATED"
  fi

  emit '\n'
  if [ "$NEEDS_ATTENTION" -eq 1 ]; then
    emit '── 该我动手（%s 个 agent 需核对）──\n' "$A_AGENTS"
    if [ "$A_IDLE_WORK" -gt 0 ]; then
      emit '  · %s 个 agent 有在办卡且无任何等待路径：先核对任务与唤醒，再决定是否补唤醒\n' "$A_IDLE_WORK"
    fi
    if [ "$A_LONG_RUNNING" -gt 0 ]; then
      emit '  · %s 个运行较久/排队较久：先看运行日志、进程与产物，不据此判定卡死\n' "$A_LONG_RUNNING"
    fi
    if [ "$A_SILENT_RUN" -gt 0 ]; then
      emit '  · %s 个运行静默：确认是否仍在产出；静默本身不等于停滞\n' "$A_SILENT_RUN"
    fi
    if [ "$A_REVIEW" -gt 0 ]; then
      emit '  · %s 张 in_review 待裁决：瓶颈在我，先裁决再派新活\n' "$A_REVIEW"
    fi
    if [ "$A_PAUSED_WORK" -gt 0 ]; then
      emit '  · %s 个暂停中的 agent 仍持有未结卡片：确认暂停是否有意为之\n' "$A_PAUSED_WORK"
    fi
    if [ "$A_AGENT_ERROR" -gt 0 ]; then
      emit '  · %s 个 agent 状态为 error：核对最近一次运行的失败原因\n' "$A_AGENT_ERROR"
    fi
    if [ "$A_PENDING_APPROVAL" -gt 0 ]; then
      emit '  · %s 个 agent 待审批\n' "$A_PENDING_APPROVAL"
    fi
    if [ "$A_FAILED_WAKE_EVENTS" -gt 0 ]; then
      emit '  · 近 %sh 失败唤醒 %s 条：逐条核对是否已由重试覆盖\n' "$WAKE_WINDOW_H" "$A_FAILED_WAKE_EVENTS"
    fi
    if [ "$A_STALE_WAKE_EVENTS" -gt 0 ]; then
      emit '  · 排队超 %sm 的唤醒 %s 条：核对队列与并发上限\n' "$WAKE_STALE" "$A_STALE_WAKE_EVENTS"
    fi
  else
    emit '  无可执行事项。\n'
  fi
}

render_text() {
  local line
  render_header_text
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    split_row "$line"
    classify_row "${F[@]}"
    tally_row "${F[15]}" "${F[18]}"
    render_row_text "${F[0]}" "${F[1]}" "$ROW_STATE" "${F[5]}" "${F[6]}" "${F[8]}" "${F[10]}" "${F[12]}"
  done <<< "$ROWS"
  render_footer_text
}

render_json() {
  local line sep=""
  local entries=()

  # Classify first: the summary block is printed above the per-agent entries,
  # so the counters must already be complete when it is written.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    split_row "$line"
    classify_row "${F[@]}"
    tally_row "${F[15]}" "${F[18]}"
    render_entry_json "${F[@]}"
    entries+=("$ENTRY")
  done <<< "$ROWS"

  emit '{\n'
  emit '  "schemaVersion": %s,\n' "$SCHEMA_VERSION"
  json_string "$GENERATED_AT_ISO"
  emit '  "generatedAt": %s,\n' "$JSON"
  json_optional_string "$COMPANY"
  local requested=$JSON
  scope_companies_json
  emit '  "scope": {"requested": %s, "companies": %s},\n' "$requested" "$JSON"
  emit '  "thresholds": {"runningSlowMinutes": %s, "runSilentMinutes": %s, "todoIdleMinutes": %s, "reviewWaitMinutes": %s, "wakeWindowHours": %s, "wakeStaleMinutes": %s},\n' \
    "$RUNNING_SLOW" "$RUN_SILENT" "$TODO_IDLE" "$REVIEW_WAIT" "$WAKE_WINDOW_H" "$WAKE_STALE"
  json_bool "$NEEDS_ATTENTION"
  emit '  "needsAttention": %s,\n' "$JSON"
  emit '  "summary": {\n'
  emit '    "agents": {"total": %s, "busy": %s, "queued": %s, "idleWithWork": %s, "waiting": %s, "free": %s, "paused": %s, "error": %s, "pendingApproval": %s, "excludedTerminated": %s},\n' \
    "$N_TOTAL" "$N_BUSY" "$N_QUEUED" "$N_IDLE_WORK" "$N_WAITING" "$N_FREE" "$N_PAUSED" "$N_ERROR" \
    "$N_PENDING_APPROVAL" "$EXCLUDED_TERMINATED"
  emit '    "attention": {"agents": %s, "longRunning": %s, "silentRun": %s, "idleWithWork": %s, "pausedWithWork": %s, "agentError": %s, "pendingApproval": %s, "reviewCards": %s, "failedWakeAgents": %s, "failedWakeEvents": %s, "staleWakeAgents": %s, "staleWakeEvents": %s}\n' \
    "$A_AGENTS" "$A_LONG_RUNNING" "$A_SILENT_RUN" "$A_IDLE_WORK" "$A_PAUSED_WORK" "$A_AGENT_ERROR" \
    "$A_PENDING_APPROVAL" "$A_REVIEW" "$A_FAILED_WAKE" "$A_FAILED_WAKE_EVENTS" "$A_STALE_WAKE" "$A_STALE_WAKE_EVENTS"
  emit '  },\n'
  emit '  "agents": [\n'
  # Indexed loop: bash 3.2 treats "${empty[@]}" as an unbound variable under
  # set -u, and this array is empty whenever the scope has no rows.
  local i=0
  while [ "$i" -lt "${#entries[@]}" ]; do
    emit '%s%s' "$sep" "${entries[$i]}"
    sep=$',\n'
    i=$((i + 1))
  done
  emit '\n  ]\n'
  emit '}\n'
}

# Sets ENTRY to one agent object. Every value is written through the JSON
# helpers, which set $JSON, so no value passes through a subshell.
render_entry_json() {
  local company=$1 name=$2 status=$3 pause_reason=$4
  local run_state=$5 run_card=$6 run_age=$7 run_silent=$8
  local active=$9 monitored=${10} review=${11} review_in_run=${12} parked=${13}
  local oldest_active=${14} oldest_review=${15}
  local failed=${16} failed_detail=${17}
  local pending=${18} stale_pending=${19} oldest_pending=${20} recoveries=${21}
  local out="    {" attention_flag=0

  json_string "$company"; out="$out\"company\": $JSON, "
  json_string "$name"; out="$out\"agent\": $JSON, "
  json_string "$status"; out="$out\"agentStatus\": $JSON, "
  json_optional_string "$pause_reason"; out="$out\"pauseReason\": $JSON, "
  json_string "$ROW_STATE"; out="$out\"state\": $JSON, "
  if [ -n "$ROW_ATTENTION" ]; then attention_flag=1; fi
  json_bool "$attention_flag"; out="$out\"needsAttention\": $JSON, "
  json_attention_array; out="$out\"attention\": $JSON, "
  json_optional_string "$ROW_NOTE"; out="$out\"note\": $JSON, "

  json_optional_string "$run_state"; out="$out\"run\": {\"state\": $JSON, "
  json_optional_string "$run_card"; out="$out\"card\": $JSON, "
  json_optional_number "$run_age"; out="$out\"ageMinutes\": $JSON, "
  json_optional_number "$run_silent"; out="$out\"silentMinutes\": $JSON}, "

  out="$out\"cards\": {\"active\": $active, \"activeMonitored\": $monitored, "
  out="$out\"review\": $review, \"reviewPending\": $ROW_REVIEW_PENDING, \"parked\": $parked, "
  json_optional_number "$oldest_active"; out="$out\"oldestActiveMinutes\": $JSON, "
  json_optional_number "$oldest_review"; out="$out\"oldestReviewMinutes\": $JSON}, "

  out="$out\"wakeups\": {\"failed\": $failed, "
  json_optional_string "$failed_detail"; out="$out\"failedDetail\": $JSON, "
  out="$out\"pending\": $pending, \"stalePending\": $stale_pending, "
  json_optional_number "$oldest_pending"; out="$out\"oldestPendingMinutes\": $JSON}, "

  ENTRY="$out\"recoveries\": $recoveries}"
}

# ---------------------------------------------------------------- pipeline

# Splits one transport row into F and rejects a wrong field count instead of
# silently dropping the row.
F=()
split_row() {
  local rest=$1 field n=0
  F=()
  while :; do
    case "$rest" in
      *"$FS"*)
        field=${rest%%"$FS"*}
        rest=${rest#*"$FS"}
        F[$n]=$field
        n=$((n + 1))
        ;;
      *)
        F[$n]=$rest
        n=$((n + 1))
        break
        ;;
    esac
  done
  if [ "$n" -ne "$FIELD_COUNT" ]; then
    die "row has $n fields, expected $FIELD_COUNT; the query and the parser disagree."
  fi
}

reset_counters() {
  N_TOTAL=0; N_BUSY=0; N_QUEUED=0; N_IDLE_WORK=0; N_WAITING=0; N_FREE=0
  N_PAUSED=0; N_ERROR=0; N_PENDING_APPROVAL=0
  A_AGENTS=0; A_LONG_RUNNING=0; A_SILENT_RUN=0; A_IDLE_WORK=0
  A_PAUSED_WORK=0; A_AGENT_ERROR=0; A_PENDING_APPROVAL=0; A_REVIEW=0
  A_FAILED_WAKE=0; A_STALE_WAKE=0; A_FAILED_WAKE_EVENTS=0; A_STALE_WAKE_EVENTS=0
  NEEDS_ATTENTION=0
  # Scope is re-derived every run; leaving it set would keep the company column
  # visible after a --watch run whose scope shrank to one company.
  SCOPE_MULTI=0
}

collect() {
  reset_counters
  resolve_scope || return 2
  fetch_rows || return 2
  ROWS=$SQL_OUT
  # An empty table is only suspicious when nothing explains it. A scope whose
  # agents are all terminated is a real, quiet answer; anything else usually
  # means the wrong database or company, and must not read as all-clear.
  if [ -z "$ROWS" ] && [ "$EXCLUDED_TERMINATED" -eq 0 ]; then
    die "the query returned no agents for scope '$SCOPE_NAMES'; check --db and --company."
  fi
  return 0
}

# Single source of truth for the exit status of one successful run, so the text
# and JSON modes cannot disagree.
decide_exit() {
  if [ "$NEEDS_ATTENTION" -eq 1 ]; then return 1; fi
  return 0
}

run_once() {
  GENERATED_AT=$(date '+%Y-%m-%d %H:%M:%S')
  GENERATED_AT_ISO=$(date '+%Y-%m-%dT%H:%M:%S%z')
  collect || return 2
  if [ "$MODE" = "json" ]; then
    render_json
  else
    render_text
  fi
  decide_exit
}

main() {
  parse_args "$@"

  ERR_FILE=$(mktemp "${TMPDIR:-/tmp}/fleet-status.XXXXXX") || die "cannot create a temporary file"
  trap 'rm -f "$ERR_FILE"' EXIT

  preflight || return 2

  if [ -n "$WATCH" ]; then
    while :; do
      # Only clear a real terminal: the escape sequence would otherwise land in
      # a redirected file once per frame.
      if [ -t 1 ]; then clear 2>/dev/null || true; fi
      # Exit 1 is a normal "needs attention" render; only 2 means the panel
      # could not answer, and only that is worth a warning between intervals.
      run_once
      if [ $? -eq 2 ]; then
        warn "panel unavailable; retrying in ${WATCH}s"
      fi
      sleep "$WATCH"
    done
  fi

  run_once
  return $?
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
  exit $?
fi
