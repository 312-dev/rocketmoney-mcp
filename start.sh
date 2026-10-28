#!/bin/zsh
# Starts the server for the launchd agent, with auto-login credentials read from
# the macOS Keychain (never written to disk in plain text). Add them once with:
#   security add-generic-password -s rocketmoney-mcp -a email -w
#   security add-generic-password -s rocketmoney-mcp -a password -w
# Without them the server still runs; it just can't log itself back in.
# stderr goes to the launchd log, so a Keychain failure says why (it never carries the secret).
kc() { /usr/bin/security find-generic-password -s rocketmoney-mcp -a "$1" -w; }
export ROCKETMONEY_EMAIL="$(kc email)"
export ROCKETMONEY_PASSWORD="$(kc password)"
[[ -n $ROCKETMONEY_EMAIL && -n $ROCKETMONEY_PASSWORD ]] || echo "[start] no Keychain credentials (email ${#ROCKETMONEY_EMAIL} chars, password ${#ROCKETMONEY_PASSWORD} chars, HOME=$HOME); auto-login off" >&2
exec "${NODE:-node}" "${0:A:h}/dist/index.js"
