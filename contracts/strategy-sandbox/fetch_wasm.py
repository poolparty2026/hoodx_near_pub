"""Fetches what the sandbox tests run, and refuses anything whose hash isn't pinned (wasm/README.md):
- the mainnet contract code, with view_code, checked against each account's base58 code_hash;
- the near-sandbox binary, checked by its SHA-256 (near-workspaces' own download has no check).
Run: python3 -I fetch_wasm.py (run.sh does)."""
import base64, hashlib, io, json, os, sys, tarfile, urllib.request

RPC = "https://free.rpc.fastnear.com"
PINNED = {
    "dclv2.wasm": ("dclv2.ref-labs.near", "3G34Nhjmir5JPYPtijaA9iCNnHDPR7h3wfC9H77woEGo"),
    "wrap.wasm": ("wrap.near", "DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1"),
    "usdc.wasm": ("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q"),
}
SANDBOX_URL = "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.14.0/near-sandbox.tar.gz"
SANDBOX_SHA256 = "797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
HERE = os.path.dirname(os.path.abspath(__file__))


def b58(b):
    n, s = int.from_bytes(b, "big"), ""
    while n:
        n, m = divmod(n, 58)
        s = B58[m] + s
    return s


def wasm():
    out = os.path.join(HERE, "wasm")
    for name, (account, want) in PINNED.items():
        path = os.path.join(out, name)
        if os.path.exists(path) and b58(hashlib.sha256(open(path, "rb").read()).digest()) == want:
            continue
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "query", "params": {"request_type": "view_code", "finality": "final", "account_id": account}}).encode()
        req = urllib.request.Request(RPC, body, {"content-type": "application/json"})
        code = base64.b64decode(json.load(urllib.request.urlopen(req, timeout=60))["result"]["code_base64"])
        got = b58(hashlib.sha256(code).digest())
        if got != want:
            sys.exit(f"{account}: code hash {got} isn't the pinned {want}; refusing")
        open(path, "wb").write(code)
        print(f"fetched {name} ({len(code)} bytes, {got})")


def sandbox():
    if os.uname().sysname != "Linux" or os.uname().machine != "x86_64":
        sys.exit("only Linux x86_64's near-sandbox binary is pinned")
    path = os.path.join(HERE, "..", "..", "target", "near-sandbox", "near-sandbox")
    if os.path.exists(path) and hashlib.sha256(open(path, "rb").read()).hexdigest() == SANDBOX_SHA256:
        return
    data = urllib.request.urlopen(SANDBOX_URL, timeout=300).read()
    # Only the one member's bytes are read; nothing is extracted by path.
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
        member = t.getmember("Linux-x86_64/near-sandbox")
        if not member.isfile():
            sys.exit("near-sandbox isn't a regular file in the archive; refusing")
        binary = t.extractfile(member).read()
    got = hashlib.sha256(binary).hexdigest()
    if got != SANDBOX_SHA256:
        sys.exit(f"near-sandbox sha256 {got} isn't the pinned {SANDBOX_SHA256}; refusing")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(binary)
    os.chmod(tmp, 0o755)
    os.replace(tmp, path)
    print(f"fetched near-sandbox 2.14.0 ({len(binary)} bytes, {got})")


wasm()
sandbox()
