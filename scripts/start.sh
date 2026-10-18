#!/bin/sh
# Starts Sayso on a host. Metal keys and mandate credentials are files (.metal/); a host passes them
# as METAL_BUNDLE, the base64 of `tar czf - .metal`. Without any keys it runs offline.
set -e
if [ -n "$METAL_BUNDLE" ] && [ ! -d .metal ]; then echo "$METAL_BUNDLE" | base64 -d | tar xzf -; fi
if [ -n "$AWX_CLIENT_ID" ] && [ -n "$METAL_PRINCIPAL" ]; then exec npx tsx src/serve.ts; fi
echo "AWX_CLIENT_ID or METAL_PRINCIPAL is missing: starting offline (simulated Airwallex and Metal)"
exec npx tsx src/serve.ts --offline
