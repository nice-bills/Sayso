#!/bin/sh
# Starts Sayso on a host. Metal keys and mandate credentials are files (.metal/); a host passes them
# as METAL_BUNDLE, the base64 of `tar czf - .metal`. With no keys at all it runs the offline demo.
# Some keys but not all is a mistake: refuse to start rather than quietly simulate money.
set -e
if [ -n "$METAL_BUNDLE" ] && [ ! -d .metal ]; then echo "$METAL_BUNDLE" | base64 -d | tar xzf -; fi
if [ -n "$AWX_CLIENT_ID" ] && [ -n "$METAL_PRINCIPAL" ] && [ -f "${METAL_OWNER_KEY:-.metal/owner.json}" ]; then exec npx tsx src/serve.ts; fi
missing=""
[ -n "$AWX_CLIENT_ID" ] || missing="$missing AWX_CLIENT_ID"
[ -n "$METAL_PRINCIPAL" ] || missing="$missing METAL_PRINCIPAL"
[ -f "${METAL_OWNER_KEY:-.metal/owner.json}" ] || missing="$missing ${METAL_OWNER_KEY:-.metal/owner.json}(METAL_BUNDLE)"
if [ "$SAYSO_OFFLINE" != "on" ] && { [ -n "$AWX_CLIENT_ID" ] || [ -n "$METAL_PRINCIPAL" ] || [ -n "$METAL_BUNDLE" ]; }; then
  echo "Refusing to start: some live keys are set but these are missing:$missing. Fix them, or set SAYSO_OFFLINE=on to run the simulated demo." >&2
  exit 1
fi
echo "No live keys: starting the offline demo (simulated Airwallex and Metal; every proof starts with sim:)"
exec npx tsx src/serve.ts --offline
