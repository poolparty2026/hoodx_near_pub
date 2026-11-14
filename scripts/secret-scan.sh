#!/usr/bin/env bash
# Refuses secrets anywhere in the repository's object database: every blob of
# every commit, binary files and merge resolutions included, whatever
# .gitattributes says (security re-audit M-1, L-1, L-2). Prints only object ids
# and paths, never the matched text. Exit 0: clean. Exit 1: possible secret.
# Exit 2: the scan itself failed.
set -euo pipefail
cd "${1:-.}" || exit 2
git rev-parse --git-dir > /dev/null 2>&1 || { echo "secret scan: not a git repository" >&2; exit 2; }
B58='[1-9A-HJ-NP-Za-km-z]'
# ed25519 secret keys are 64 bytes (about 88 base58 characters; public keys are
# about 44). secp256k1 secret keys are 32 bytes (about 44; public keys about 87).
PATTERN="(ed25519:${B58}{80,}|secp256k1:${B58}{40,50}([^1-9A-HJ-NP-Za-km-z]|\$)|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})"
# Keyword-based secrets, matched case-insensitively: seed phrases (12 or more
# words) and 64-or-more-hex private keys (EVM refund-side keys), security re-audit L-5.
PATTERN_I="((seed|mnemonic|recovery|passphrase|secret[_ -]?(phrase|words))([_ -]?(phrase|words))?[\"'\`]?([[:space:]]*:[[:space:]]*[a-z]+)?[[:space:]]*[:=][[:space:]]*[\\[\"'\` ]*[a-z]+([\"'\`]?[[:space:],]+[\"'\`]?[a-z]+){11,}|[a-z0-9_./-]*(key|secret|priv|pk)[a-z0-9_./-]*[\"'\`]?([[:space:]]*:[[:space:]]*[a-z]+)?[[:space:]]*[:=][[:space:]]*[\"'\`]?(0x)?[0-9a-f]{64,}|[a-z0-9_-]*secret[a-z0-9_-]*[\"'\`]?[[:space:]]*[:=][[:space:]]*[\"'\`][a-z]+([[:space:],]+[a-z]+){11,}|[a-z0-9_./-]*pub(lic)?[_ -]?key.*[0-9a-f].*[^0-9a-f][0-9a-f]{64,})"
# A match exempt as a public key: the whole match is exactly a key name (dotted and
# slashed paths included) ending in pub/public key, a separator (optionally with a type
# or quotes) and one value of exactly 64 hex; PUBLIC_ONLY is anchored at both ends. A
# match containing priv, secret, seed, mnemonic, passphrase or signing is never exempt.
# NOT_PUBLIC's hex clauses repeat what the anchors already enforce: deliberate defence in
# depth, so an edit to either half alone still fails closed (test re-audit of ffaa5d7, I-1).
PUBLIC_ONLY="^[a-z0-9_./-]*pub(lic)?[_ -]?key[\"'\`]?([[:space:]]*:[[:space:]]*[a-z]+)?[[:space:]]*[:=][[:space:]]*[\"'\`]?(0x)?[0-9a-f]{64}$"
NOT_PUBLIC="(priv|secret|seed|mnemonic|passphrase|signing|[0-9a-f]{65}|[0-9a-f]{64}.*[^0-9a-f][0-9a-f]{64})"
# A public-key name followed later on the line by any hex and then a 64-hex run is one
# match (the pair rule) and can't be exempt, so a secret written after a public key is
# caught; prose naming a public key before a 64-hex value is flagged too (deliberate).
# Known blind spots (listed in SECURITY_PROCESS): base64-encoded keys, keys inside
# compressed files, UTF-16 text, seed phrases split across lines, an unquoted seed
# phrase after a bare `secret:`, a match exempt as a public key (defined at PUBLIC_ONLY above), 64-hex values whose own name has no key, secret, priv or pk, and key formats not named above.
tmp=$(mktemp)
tmp2=$(mktemp)
tmp3=$(mktemp)
trap 'rm -f "$tmp" "$tmp2" "$tmp3"' EXIT
# Self-check: the pattern must compile and match a known sample, or fail closed.
printf 'sk-%s\n' AAAAAAAAAAAAAAAAAAAAAAAA > "$tmp"
if ! grep -aqE "$PATTERN" "$tmp"; then echo "secret scan: pattern self-check failed" >&2; exit 2; fi
printf 'private_key = "%s"\n' 0000000000000000000000000000000000000000000000000000000000000000 > "$tmp"
if ! grep -aqiE "$PATTERN_I" "$tmp"; then echo "secret scan: keyword pattern self-check failed" >&2; exit 2; fi
found=0
blobs=$(git cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)' | awk '$2 == "blob" { print $1 }')
for oid in $blobs; do
  git cat-file blob "$oid" > "$tmp"
  rc=0; grep -aqE "$PATTERN" "$tmp" || rc=$?
  if [ "$rc" -eq 1 ]; then
    # Keyword matches, minus matches that only assign a public key (security re-audit L-5).
    # Two steps through a file, not a pipe, so neither grep's exit status is lost.
    # -o emits each match on its own, starting at its key name, so a public-key
    # match is exempt without hiding a secret later on the same line (re-audit M-1).
    rc=0; grep -aoiE "$PATTERN_I" "$tmp" > "$tmp2" || rc=$?
    if [ "$rc" -eq 0 ]; then
      # Keep a match unless it is exempt as a public key (see PUBLIC_ONLY and NOT_PUBLIC).
      grep -aiE "$PUBLIC_ONLY" "$tmp2" | grep -aivE "$NOT_PUBLIC" > "$tmp3" || true
      rc=0; grep -aqvxiFf "$tmp3" "$tmp2" || rc=$?
    fi
  fi
  if [ "$rc" -eq 0 ]; then
    paths=$(git log --all --format= --name-only --find-object="$oid" | sort -u | tr '\n' ' ')
    echo "Possible secret in blob $oid (${paths:-unknown path})" >&2
    found=1
  elif [ "$rc" -ne 1 ]; then
    echo "secret scan: grep failed on blob $oid (exit $rc)" >&2; exit 2
  fi
done
exit "$found"
