#!/usr/bin/env bash
# Self-test for secret-scan.sh: builds throwaway repos and checks that the scan
# fails on secrets hidden in binary files, merge resolutions and behind
# `-diff` attributes, catches secp256k1 secret keys and ignores public keys.
# The sample keys are random base58 of the right length, not real keys.
set -euo pipefail
# Isolate from the user's git config (signing, hooks).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
here=$(cd "$(dirname "$0")" && pwd)
scan="$here/secret-scan.sh"
# Random sample characters; head closing the pipe early is expected (SIGPIPE).
rnd() { LC_ALL=C tr -dc "$1" < /dev/urandom | head -c "$2" || true; }
b58() { rnd '1-9A-HJ-NP-Za-km-z' "$1"; }
fail=0
new_repo() {
  d=$(mktemp -d); git -C "$d" init -q -b t; git -C "$d" config user.email t@t; git -C "$d" config user.name t
  echo base > "$d/a.txt"; git -C "$d" add -A; git -C "$d" commit -qm base; echo "$d"
}
expect() { # expect <exit code> <name> <repo> [secret that must not appear in the output]
  rc=0; out=$("$scan" "$3" 2>&1) || rc=$?
  if [ "$rc" -ne "$1" ]; then echo "FAIL $2 (exit $rc, wanted $1)"; fail=1
  elif [ -n "${4:-}" ] && printf '%s' "$out" | grep -qF -- "$4"; then echo "FAIL $2 (printed the secret)"; fail=1
  else echo "ok   $2"; fi
  rm -rf "$3"
}
one() { # one <exit code> <name> <file content>: a repo with one committed file
  d=$(new_repo); printf '%s\n' "$3" > "$d/f.txt"; git -C "$d" add -A; git -C "$d" commit -qm f; expect "$1" "$2" "$d" "${4:-}"
}
d=$(new_repo); expect 0 "clean repo passes" "$d"
d=$(new_repo); printf '\0\ned25519:%s\n' "$(b58 88)" > "$d/key.bin"; git -C "$d" add -A; git -C "$d" commit -qm bin
expect 1 "secret in a binary file" "$d"
d=$(new_repo); git -C "$d" checkout -qb side; echo side > "$d/a.txt"; git -C "$d" commit -qam side
git -C "$d" checkout -q t; echo main > "$d/a.txt"; git -C "$d" commit -qam main
git -C "$d" merge -q side >/dev/null 2>&1 || true; echo "ed25519:$(b58 88)" > "$d/a.txt"; git -C "$d" commit -qam merge
expect 1 "secret written in a merge resolution" "$d"
d=$(new_repo); echo '* -diff' > "$d/.gitattributes"; echo "sk-$(b58 30)" > "$d/c.txt"; git -C "$d" add -A; git -C "$d" commit -qm attr
expect 1 "secret behind a -diff attribute" "$d"
d=$(new_repo); echo "key = \"secp256k1:$(b58 44)\"" > "$d/k.toml"; git -C "$d" add -A; git -C "$d" commit -qm k
expect 1 "secp256k1 secret key" "$d"
d=$(new_repo); { echo "secp256k1:$(b58 87)"; echo "ed25519:$(b58 44)"; } > "$d/pub.md"; git -C "$d" add -A; git -C "$d" commit -qm pub
expect 0 "public keys of both types pass" "$d"
d=$(new_repo); echo "sk-$(b58 30)" > "$d/x.txt"; git -C "$d" add -A; git -C "$d" commit -qm x; git -C "$d" rm -q x.txt; git -C "$d" commit -qm rm
expect 1 "secret deleted in a later commit" "$d"
# Every key class is caught and never printed (EC-S05).
s="ed25519:$(b58 88)"; one 1 "ed25519 secret, not printed" "$s" "$s"
s="123456789:$(rnd 'A-Za-z0-9_-' 35)"; one 1 "Telegram bot token, not printed" "TG_BOT_TOKEN=$s" "$s"
s="eyJ$(b58 20).$(b58 30).$(b58 30)"; one 1 "JWT, not printed" "jwt: $s" "$s"
s="sk-ant-api03-$(b58 40)"; one 1 "sk-ant key with hyphens, not printed" "$s" "$s"
s="sk-proj-$(b58 40)"; one 1 "sk-proj key with hyphens, not printed" "key=$s" "$s"
w="abandon ability able about above absent absorb abstract absurd abuse access accident"; s="$w"
one 1 "seed phrase in .env, not printed" "NEAR_SEED_PHRASE=\"$s\"" "$s"
one 1 "seed phrase in JSON" "{\"master_seed_phrase\": \"$s\"}" "$s"
s="0x$(rnd '0-9a-f' 64)"; one 1 "64-hex private key, not printed" "PRIVATE_KEY=$s" "$s"
one 1 "MNEMONIC= variable, not printed" "MNEMONIC=\"$w\"" "$w"
one 1 "mnemonic: in YAML" "mnemonic: $w" "$w"
one 1 "seed: in YAML" "seed: $w" "$w"
one 1 "comma-separated phrase" "seed_phrase = ${w// /, }" "${w// /, }"
h="$(rnd '0-9a-f' 64)"
one 1 "DEPLOYER_PK, not printed" "DEPLOYER_PK=0x$h" "$h"
one 1 "private key: with a space" "private key: $h" "$h"
one 1 "PK= at line start" "PK=$h" "$h"
one 0 "64-hex commit id passes" "commit $h"
one 0 "11-word phrase passes" "seed_phrase = \"abandon ability able about above absent absorb abstract absurd abuse access\""
one 0 "task-style words with sk- inside pass" "risk-assessment-and-mitigation-plan-for-the-demo"
# Length cut-offs.
one 0 "ed25519 at 79 characters passes" "ed25519:$(b58 79)"
one 1 "ed25519 at 80 characters is caught" "ed25519:$(b58 80)"
one 0 "secp256k1 at 39 characters passes" "secp256k1:$(b58 39)"
one 1 "secp256k1 at 40 characters is caught" "secp256k1:$(b58 40)"
one 1 "secp256k1 at 50 characters is caught" "secp256k1:$(b58 50)"
one 0 "secp256k1 at 51 characters passes (public-key length)" "secp256k1:$(b58 51)"
# Remaining cut-offs and spellings (test re-audit M-1, L-1).
one 0 "sk- with 19 characters passes" "sk-$(rnd 'A-Za-z0-9' 19)"
s="sk-$(rnd 'A-Za-z0-9' 20)"; one 1 "sk- with 20 characters is caught" "$s" "$s"
s="12345678:$(rnd 'A-Za-z0-9_-' 35)"; one 1 "Telegram token, 8-digit id" "$s" "$s"
s="1234567890:$(rnd 'A-Za-z0-9_-' 35)"; one 1 "Telegram token, 10-digit id" "$s" "$s"
one 0 "Telegram-like, 7-digit id passes" "1234567:$(rnd 'A-Za-z0-9_-' 35)"
one 0 "Telegram-like, 34 characters passes" "123456789:$(rnd 'A-Za-z0-9_-' 34) end"
one 0 "JWT-like with a 9-character segment passes" "eyJ$(b58 9).$(b58 30).$(b58 30)"
s="eyJ$(b58 10).$(b58 10).$(b58 10)"; one 1 "JWT with 10-character segments" "$s" "$s"
one 0 "63-hex private key passes" "PRIVATE_KEY=0x$(rnd '0-9a-f' 63)"
h="$(rnd '0-9a-f' 64)"; one 1 "64-hex private key without 0x" "PRIVATE_KEY=$h" "$h"
H="$(rnd '0-9A-F' 64)"; one 1 "upper-case 64-hex secret_key" "secret_key: $H" "$H"
one 1 "SECRET-KEY without 0x" "SECRET-KEY=$h" "$h"
one 1 "MNEMONIC_PHRASE, not printed" "MNEMONIC_PHRASE=\"$w\"" "$w"
# More spellings (security re-audit L-2).
h="$(rnd '0-9a-f' 64)"
one 1 "export PK=" "export PK=$h" "$h"
one 1 "indented YAML pk:" "  pk: $h" "$h"
one 1 "JSON \"pk\":" "{\"pk\": \"$h\"}" "$h"
one 1 "privkey=" "privkey=$h" "$h"
one 1 "private_key_hex=" "private_key_hex=$h" "$h"
one 1 "EVM_KEY=0x" "EVM_KEY=0x$h" "$h"
arr="[\"${w// /\", \"}\"]"
one 1 "mnemonic as a JSON array" "{\"mnemonic\": $arr}" "abandon\", \"ability"
one 1 "SEED_WORDS=" "SEED_WORDS=\"$w\"" "$w"
one 1 "recovery_phrase=" "recovery_phrase=\"$w\"" "$w"
one 0 "64-hex hash under a non-key name passes" "rules_hash = \"$h\""
# Numbered, hyphenated and other names (re-audits of 2643df5).
h="$(rnd '0-9a-f' 64)"
one 1 "PRIVATE_KEY_1=" "PRIVATE_KEY_1=$h" "$h"
one 1 "KEY2=0x" "KEY2=0x$h" "$h"
one 1 "ETH_KEY2=0x" "ETH_KEY2=0x$h" "$h"
one 1 "EVM-KEY-HEX=" "EVM-KEY-HEX=$h" "$h"
one 1 "PK1=" "PK1=$h" "$h"
one 1 "SECRET=0x" "SECRET=0x$h" "$h"
one 1 "wallet_secret:" "wallet_secret: $h" "$h"
one 1 "priv=" "priv=$h" "$h"
one 1 "backtick-quoted key" "key=\`$h\`" "$h"
one 1 "PASSPHRASE=" "PASSPHRASE=\"$w\"" "$w"
one 1 "secret_phrase=" "secret_phrase=\"$w\"" "$w"
one 1 "TypeScript privateKey with a type" "const privateKey: string = \"$h\"" "$h"
one 1 "TypeScript seedPhrase with a type" "const seedPhrase: string = \"$w\"" "$w"
# Prose and public keys pass (security re-audit L-5).
one 0 "prose after Secret:" "Secret: the rules stay hidden from followers until the creator reveals them at close time"
one 0 "public_key hex passes" "public_key = \"$h\""
one 0 "pubkey hex passes" "pubkey: $h"
# A public key first on the same line doesn't hide a secret (re-audit M-1); secret-named phrases (L-1).
h2="$(rnd '0-9a-f' 64)"
one 1 "public then private key in one-line JSON" "{\"publicKey\":\"0x$h\",\"privateKey\":\"0x$h2\"}" "$h2"
one 1 "PUBLIC_KEY then PRIVATE_KEY on one line" "PUBLIC_KEY=abc PRIVATE_KEY=$h2" "$h2"
one 1 "pubkey then mnemonic in one-line JSON" "{\"pubkey\": \"abc\", \"mnemonic\": \"$w\"}" "$w"
one 1 "private then public key (control)" "{\"privateKey\":\"0x$h2\",\"publicKey\":\"0x$h\"}" "$h2"
one 1 "SECRET= quoted phrase" "SECRET=\"$w\"" "$w"
one 1 "wallet_secret = quoted phrase" "wallet_secret = \"$w\"" "$w"
# Re-audit H-1 probes, pinned.
one 1 "public_key then private_key in one-line JSON" "{\"public_key\":\"ab\",\"private_key\":\"$h2\"}" "$h2"
one 1 "PUBKEY then PRIVKEY" "PUBKEY=ab PRIVKEY=$h2" "$h2"
one 1 "pubkey then private_key with a comma" "pubkey: abc, private_key = $h2" "$h2"
one 1 "privateKeyForPubkey" "const privateKeyForPubkey = \"$h2\"" "$h2"
# Colon forms and prefixed public keys (re-audit of d299c1e, L-1, L-2).
one 1 "JSON secret with a quoted phrase" "{\"secret\": \"$w\"}" "$w"
one 1 "object wallet_secret with a quoted phrase" "const c = { wallet_secret: \"$w\" }" "$w"
one 0 "NEAR_PUBLIC_KEY hex passes" "NEAR_PUBLIC_KEY=$h"
one 0 "signerPublicKey hex passes" "signerPublicKey: \"0x$h\""
one 1 "NEAR_PUBLIC_KEY_PRIV hex is caught" "NEAR_PUBLIC_KEY_PRIV=$h2" "$h2"
one 1 "public_key_secret hex is caught" "public_key_secret=$h2" "$h2"
# Cut-off and quote requirement of the secret-named phrase branch (test re-audit M-3, L-3).
one 0 "11-word SECRET= phrase passes" "SECRET=\"abandon ability able about above absent absorb abstract absurd abuse access\""
one 0 "unquoted prose after secret = passes" "secret = the rules stay hidden from followers until the creator reveals them at close time"
# Public-key exemption only for names ending in pub key (security re-audit of 50c8267, L-1).
one 1 "PUBKEY_SK" "PUBKEY_SK=$h2" "$h2"
one 1 "PUBLICKEY_PK" "PUBLICKEY_PK=$h2" "$h2"
one 1 "pubkey_and_signing_key" "pubkey_and_signing_key=$h2" "$h2"
one 1 "API_PUBKEY_TOKEN" "API_PUBKEY_TOKEN=$h2" "$h2"
one 1 "publicKey typed as a private key" "const publicKey: PrivateKeyHex = \"$h2\"" "$h2"
# Every NOT_PUBLIC term pinned, and the exemption matches whole matches only (test re-audit of 50c8267, 2-3).
for term in seed mnemonic passphrase signing priv secret; do one 1 "public_key_$term hex is caught" "public_key_$term=$h2" "$h2"; done
# These reach the exemption step: the names end in public key, so each NOT_PUBLIC term must refuse it (test re-audit of 342e8b9, M-1).
for term in seed mnemonic passphrase signing priv secret; do one 1 "${term}_public_key hex is caught" "${term}_public_key=$h2" "$h2"; done
one 1 "publicKey typed SeedHex" "const publicKey: SeedHex = \"$h2\"" "$h2"
# A pub-key word only in the type annotation doesn't exempt the match (L-1, the ^ anchor).
one 1 "DEPLOYER_PK typed PubKey" "DEPLOYER_PK: PubKey = \"$h2\"" "$h2"
d=$(new_repo); { echo "NEAR_PUBLIC_KEY=$h2"; echo "MY_PRIV_NEAR_PUBLIC_KEY=$h2"; } > "$d/both.env"; git -C "$d" add -A; git -C "$d" commit -qm both
expect 1 "exempt public key does not hide a longer secret match with the same value" "$d" "$h2"
# Dotted names and over-long values under pub-key names (security re-audit of 342e8b9, L-1).
one 1 "PRIVATE.PUBKEY" "PRIVATE.PUBKEY=$h2" "$h2"
one 1 "wallet.private.publicKey" "wallet.private.publicKey = \"$h2\"" "$h2"
one 1 "128 hex under NEAR_PUBLIC_KEY" "NEAR_PUBLIC_KEY=$h$h2" "$h2"
one 1 "128-hex PRIVATE_KEY" "PRIVATE_KEY=$h$h2" "$h2"
one 0 "64 hex under NEAR_PUBLIC_KEY passes (control)" "NEAR_PUBLIC_KEY=$h"
# Any hex run of 64 or more is caught (security re-audit of a6f6ddb, M-1, a regression).
for n in 65 96 127 129 192; do v="$(rnd '0-9a-f' "$n")"; one 1 "PRIVATE_KEY with $n hex" "PRIVATE_KEY=$v" "$v"; done
v="$(rnd '0-9a-f' 66)"; one 1 "PRIVATE_KEY=0x with 66 hex" "PRIVATE_KEY=0x$v" "$v"
v="$(rnd '0-9a-f' 72)"; one 1 "SIGNER_SECRET with 72 hex" "SIGNER_SECRET=\"$v\"" "$v"
v="$(rnd '0-9A-F' 96)"; one 1 "PRIVATE_KEY with 96 upper-case hex" "PRIVATE_KEY=$v" "$v"
for n in 65 129 192; do v="$(rnd '0-9a-f' "$n")"; one 1 "NEAR_PUBLIC_KEY with $n hex is not exempt" "NEAR_PUBLIC_KEY=$v" "$v"; done
one 1 "67 hex (64 plus hex abc)" "PRIVATE_KEY=${h2}abc" "$h2"
one 1 "64 hex followed by non-hex text" "PRIVATE_KEY=${h2}xyz" "$h2"
one 1 "0x and 64 hex followed by _old" "EVM_KEY=0x${h2}_old" "$h2"
one 0 "64-hex public key followed by text stays exempt (control)" "NEAR_PUBLIC_KEY=${h}xyz"
# Dotted and slashed names where the only NOT_PUBLIC term sits before the separator (test re-audit of a6f6ddb, 2).
one 1 "seed.publicKey" "seed.publicKey=$h2" "$h2"
one 1 "signing/pubkey" "signing/pubkey=$h2" "$h2"
# Dotted and slashed public-key names stay exempt (test re-audit of b185558, L-2); long upper-case values don't (Info-1).
one 0 "config.publicKey hex passes" "config.publicKey=$h"
one 0 "near/pubkey hex passes" "near/pubkey: $h"
v="$(rnd '0-9A-F' 96)"; one 1 "NEAR_PUBLIC_KEY with 96 upper-case hex is not exempt" "NEAR_PUBLIC_KEY=$v" "$v"
# A public key and a second hex value on one line is never exempt (security re-audit of c57c6b0, L-1).
one 1 "pub:priv keypair under NEAR_PUBLIC_KEY" "NEAR_PUBLIC_KEY=$h:$h2" "$h2"
one 1 "two hex runs split by x under NEAR_PUBLIC_KEY" "NEAR_PUBLIC_KEY=${h}x${h2}" "$h2"
one 1 "two hex runs split by _ under NEAR_PUBLIC_KEY (EC-S05)" "NEAR_PUBLIC_KEY=${h}_${h2}" "$h2"
# Layouts that slipped past the first fix (security re-audit of 6294065, L-1).
one 1 "TypeScript publicKey with a pub:secret value" "const publicKey: string = \"$h:$h2\"" "$h2"
one 1 "public_key with text before the value" "public_key (hex, no prefix) = $h:$h2" "$h2"
one 1 "hex words between the two values" "NEAR_PUBLIC_KEY=$h also $h2" "$h2"
one 1 "second value in a comment" "PUBLIC_KEY=\"$h\" # NEAR $h2" "$h2"
one 1 "value starting with n" "NEAR_PUBLIC_KEY = \"n$h:$h2\"" "$h2"
one 1 "backslash before the value" "NEAR_PUBLIC_KEY = \\$h:$h2" "$h2"
one 1 "separator ' and '" "NEAR_PUBLIC_KEY=$h and $h2" "$h2"
one 1 "separator ' # old: '" "NEAR_PUBLIC_KEY=$h # old: $h2" "$h2"
one 1 "0x pub:0x priv keypair" "NEAR_PUBLIC_KEY=0x$h:0x$h2" "$h2"
one 1 "JSON array of 0x pub and 0x priv" "\"publicKey\": [\"0x$h\", \"0x$h2\"]" "$h2"
# Deliberate fail-closed behaviour: a line naming a public key followed by two 64-hex
# values is flagged even in prose (security re-audit of c6892de, L-1; SECURITY_PROCESS).
one 1 "prose naming a public key with two hashes is flagged (intended)" "The public key is listed; rules hash $h, salt hash $h2" "$h2"
# Keypair rule under any secret name, dotted and slashed names, and the boundaries (test re-audit of c6892de, M-1, M-2, L-1; EC-S05).
one 1 "short public key then EVM_KEY" "NEAR_PUBLIC_KEY=abc EVM_KEY=$h2" "$h2"
one 1 "short public key then DEPLOYER_PK" "NEAR_PUBLIC_KEY=abc DEPLOYER_PK=0x$h2" "$h2"
one 1 "dotted public key with a pub:secret pair" "config.publicKey=$h:$h2" "$h2"
one 1 "slashed public key with a second hex value" "near/pubkey: $h, $h2" "$h2"
h63="${h:0:63}"
one 1 "63-hex first value then a 64-hex secret" "NEAR_PUBLIC_KEY=$h63:$h2" "$h2"
one 0 "64-hex public key then a 63-hex run stays exempt" "NEAR_PUBLIC_KEY=$h:${h2:0:63}"
one 0 "JSON 0x public key stays exempt" "{\"publicKey\": \"0x$h\"}"
# Typed public keys, and prose with one hash (security re-audit of ffaa5d7, L-1, L-4).
one 0 "typed public key stays exempt" "publicKey: string = \"$h\""
one 1 "public key typed as secret is flagged" "publicKey: secret = $h" "$h"
one 1 "prose naming a public key with one hash is flagged (intended)" "The public key for the rules hash: $h" "$h"
one 0 "prose with one public key hash and no hex character between passes" "The public key is $h"
# The rule works per match, not per line (security re-audit of d34f4a9, L-4).
one 0 "public key assignment after other code on the line" "const x = y; public_key = \"$h\"" 
one 0 "public key assignment followed by a comment" "public_key = $h # note"
one 1 "a digit between the mention and the hash is a hex character" "The public key 1 is $h" "$h"
# Fails closed when the scan can't run.
expect 2 "missing directory" "$(mktemp -d)/missing"
d=$(mktemp -d); expect 2 "not a repository" "$d"
# A broken pattern or a grep that can't run exits 2: run a copy of the scanner with the
# fault injected, so the real scanner needs no test hook (security re-audit of c57c6b0, L-2).
broken() { # broken <name> <old> <new> <expected stderr text>
  dir=$(mktemp -d); cp "$scan" "$dir/scan.sh"
  python3 -c "import sys;p=sys.argv[1];s=open(p).read();assert sys.argv[2] in s;open(p,'w').write(s.replace(sys.argv[2],sys.argv[3],1))" "$dir/scan.sh" "$2" "$3"
  r=$(new_repo); echo "x" > "$r/f.txt"; git -C "$r" add -A; git -C "$r" commit -qm f
  rc=0; err=$(bash "$dir/scan.sh" "$r" 2>&1 >/dev/null) || rc=$?
  # Exit 2 for the stated reason, so a syntax error or another path can't pass (re-audit of 6294065, L-2).
  if [ "$rc" -eq 2 ] && printf '%s' "$err" | grep -qF -- "$4"; then echo "ok   $1"; else echo "FAIL $1 (exit $rc, wanted 2 with '$4')"; fail=1; fi
  rm -rf "$dir" "$r"
}
broken "self-check fails on a pattern that matches nothing" 'tmp=$(mktemp)' "PATTERN='NEVER_MATCHES_XYZ'; tmp=\$(mktemp)" "secret scan: pattern self-check failed"
broken "self-check fails on an invalid pattern" 'tmp=$(mktemp)' "PATTERN='(unclosed'; tmp=\$(mktemp)" "secret scan: pattern self-check failed"
broken "keyword self-check fails on a keyword pattern that matches nothing" 'tmp=$(mktemp)' "PATTERN_I='NEVER_MATCHES_XYZ'; tmp=\$(mktemp)" "secret scan: keyword pattern self-check failed"
broken "keyword self-check fails on an invalid keyword pattern" 'tmp=$(mktemp)' "PATTERN_I='(unclosed'; tmp=\$(mktemp)" "secret scan: keyword pattern self-check failed"
# After the self-checks: a grep error on a blob exits 2, for each pattern.
broken "grep error on a blob exits 2 (main pattern)" 'found=0' "PATTERN='(unclosed'; found=0" "grep failed on blob"
broken "grep error on a blob exits 2 (keyword pattern)" 'found=0' "PATTERN_I='(unclosed'; found=0" "grep failed on blob"

exit "$fail"
