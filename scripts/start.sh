#!/bin/sh
# Starts Sayso on a host. Metal keys and mandate credentials are files (.metal/); a host passes them
# as METAL_BUNDLE, the base64 of `tar czf - .metal`. Without any keys it runs offline.
set -e
if [ -n "$METAL_BUNDLE" ] && [ ! -d .metal ]; then echo "$METAL_BUNDLE" | base64 -d | tar xzf -; fi
if [ -n "$AWX_CLIENT_ID" ] && [ -n "$METAL_PRINCIPAL" ] && [ -f "${METAL_OWNER_KEY:-.metal/owner.json}" ]; then exec npx tsx src/serve.ts; fi
echo "Airwallex keys, METAL_PRINCIPAL or the Metal key files (METAL_BUNDLE) are missing: starting offline (simulated Airwallex and Metal)"
exec npx tsx src/serve.ts --offline
