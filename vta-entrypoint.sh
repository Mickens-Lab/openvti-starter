#!/bin/sh
# First boot: render a non-interactive setup file and run `vta setup --from`.
# Later boots: skip straight to serving. State lives in the /var/lib/vta volume.
#
# DEV ONLY. The seed is a plaintext file on the volume.
#
# MODE=local (default): loopback DID, REST only, no mediator.
# MODE=tunnel: PUBLIC_HOST (the VTA's quick-tunnel host) and MEDIATOR_DID are set by `npm run up`;
#   the DID is did:webvh at that host and messaging (DIDComm + TSP) uses the existing mediator.
#   The DID is bound to the host, so a volume made for another host is refused, not reused.
set -eu

: "${ADMIN_DID:?ADMIN_DID is not set. Run \`npm run keygen\` first.}"
PORT="${VTA_PORT:-8100}"
CONFIG=/var/lib/vta/config.toml
# TOML array body, quoted strings. Override with CORS_ORIGINS_TOML (first boot only).
# BEGIN default-cors (kept equal to packages/vta-client/src/cors.ts by scripts/test/cors.test.ts)
# DEV ONLY, loopback only: http://localhost and http://127.0.0.1 on common dev-server ports.
default_cors() {
  out=""
  for range in "3000 3009" "3050 3050" "4000 4009" "4173 4173" "5173 5183" "8000 8009"; do
    set -- $range
    p=$1
    while [ "$p" -le "$2" ]; do
      for h in localhost 127.0.0.1; do out="$out${out:+, }\"http://$h:$p\""; done
      p=$((p+1))
    done
  done
  printf '%s' "$out"
}
# END default-cors
DEFAULT_CORS="$(default_cors)"
CORS="${CORS_ORIGINS_TOML:-$DEFAULT_CORS}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
MARKER=/var/lib/vta/.starter-public-url
if [ -n "$PUBLIC_HOST" ]; then
  : "${MEDIATOR_DID:?MODE=tunnel needs MEDIATOR_DID (npm run up sets it once the mediator is up).}"
  PUBLIC_URL="https://$PUBLIC_HOST"
  MESSAGING_TOML="kind = \"existing\"
did  = \"$MEDIATOR_DID\""
  SERVICES_TOML="didcomm = true
tsp     = true"
else
  PUBLIC_URL="http://localhost:$PORT"
  MESSAGING_TOML='kind = "skip"'
  SERVICES_TOML="didcomm = false
tsp     = false"
fi
if [ -f "$CONFIG" ] && [ -f "$MARKER" ] && [ "$(cat "$MARKER")" != "$PUBLIC_URL" ]; then
  echo "refusing to start: this volume was set up for $(cat "$MARKER"), not $PUBLIC_URL. A did:webvh DID is bound to" >&2
  echo "its host, so the old identity cannot move. Reset with: npm run down, then npm run up." >&2
  exit 1
fi

if [ ! -f "$CONFIG" ]; then
  cat > /tmp/setup.toml <<TOML
config_path = "$CONFIG"
data_dir    = "/var/lib/vta/data"
vta_name    = "buildathon-vta"
public_url  = "$PUBLIC_URL"
admin_did   = "$ADMIN_DID"
admin_label = "buildathon-admin"

[server]
host = "0.0.0.0"
port = $PORT
# Exact-match origins; the VTA accepts no wildcard (default: loopback dev ports only). Edit and re-create the
# volume (docker compose down -v) to change.
cors_origins = [$CORS]
# Dev loop: refill auth tokens quickly instead of 1 per 5 s.
rate_limit_interval_secs = 1
rate_limit_burst = 60

[log]
level  = "info"
format = "text"

[secrets]
backend = "plaintext"

[messaging]
$MESSAGING_TOML

[services]
$SERVICES_TOML

[vta_did]
kind = "create_webvh"
url  = "$PUBLIC_URL"
TOML
  vta setup --from /tmp/setup.toml
  # Optional approvals demo (npm run approvals:setup, docs/APPROVALS.md): the setup wizard cannot carry a [policy]
  # section, so it is appended to the generated config. The VTA applies this seed ONCE, on the first boot with no
  # stored rules, and nothing is enforced unless enforcement = true. Local to this volume; DEV ONLY.
  if [ -n "${APPROVER_DID:-}" ]; then
    # The generated config already has a [policy] table (enforcement = false, approvals = [], an empty approver_sets
    # table), so edit those lines rather than adding a second [policy].
    # APPROVER_DID may be one DID or a comma-separated list (e.g. a phone wallet plus the software approver).
    APPROVER_LIST=$(printf '%s' "$APPROVER_DID" | sed -e 's/[[:space:]]//g' -e 's/,/","/g')
    sed -i \
      -e '/^\[policy\]$/,/^\[policy\.approver_sets\]$/ s/^enforcement = false$/enforcement = true/' \
      -e '/^\[policy\]$/,/^\[policy\.approver_sets\]$/ { /^approvals = \[\]$/d }' \
      -e "s|^\[policy\.approver_sets\]\$|[policy.approver_sets]\ndemo-approvers = [\"$APPROVER_LIST\"]|" \
      "$CONFIG"
    # Field names are camelCase here; the VTA's docs show snake_case, which this VTA rejects ("unknown field").
    cat >> "$CONFIG" <<TOML

[[policy.approvals]]
taskType         = "https://trusttasks.org/spec/vta/contexts/update/1.0"
requires         = "consent"
approverSet      = "demo-approvers"
minApprovals     = 1
excludeRequester = true
TOML
    grep -q '^enforcement = true$' "$CONFIG" || { echo "approvals demo: could not switch policy.enforcement on; refusing to start with a rule that gates nothing" >&2; exit 1; }
    echo "approvals demo: consent required for vta/contexts/update/1.0, approver set = $(printf '%s' "$APPROVER_DID" | sed -e 's/[[:space:]]//g' -e 's/,/, /g'), enforcement on" >&2
  fi
  echo "$PUBLIC_URL" > "$MARKER"
fi

exec vta --config "$CONFIG"
