#!/data/data/com.termux/files/usr/bin/bash
# scripts/set_key.sh — one command to set any provider credential, instead of
# hand-editing .env or remembering sed syntax every time you rotate keys.
#
# Usage:  bash scripts/set_key.sh GEMINI_API_KEY YOUR_KEY_HERE
#         bash scripts/set_key.sh NVIDIA_API_KEY YOUR_KEY_HERE
#         bash scripts/set_key.sh PUTER_AUTH_TOKEN YOUR_TOKEN_HERE
#         bash scripts/set_key.sh OPENAI_API_KEY YOUR_KEY_HERE
#
# Never prints the full value back, and this script itself never contains a
# real key — you pass it fresh each time, it never lives in a file that gets
# zipped up or shared.

set -e
cd "$(dirname "$0")/.."

VAR="$1"
VAL="$2"
VALID="GEMINI_API_KEY GEMINI_MODEL NVIDIA_API_KEY NVIDIA_MODEL PUTER_AUTH_TOKEN PUTER_MODEL OPENAI_API_KEY OPENAI_MODEL PROVIDER_ORDER"

if [ -z "$VAR" ] || [ -z "$VAL" ]; then
  echo "Usage: bash scripts/set_key.sh VAR_NAME value"
  echo "Valid names: $VALID"
  exit 1
fi
if ! echo " $VALID " | grep -q " $VAR "; then
  echo "Unrecognized name \"$VAR\". Valid names: $VALID"
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
fi

if grep -q "^${VAR}=" .env; then
  sed -i "s|^${VAR}=.*|${VAR}=${VAL}|" .env
else
  echo "${VAR}=${VAL}" >> .env
fi

echo "${VAR} set. Verifying:"
grep "^${VAR}=" .env | cut -c1-30
echo "(showing first 30 chars only)"

