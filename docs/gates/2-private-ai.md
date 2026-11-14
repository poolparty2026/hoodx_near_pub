# Gate 2: does NEAR's private AI fit this agent?

**Owner:** Agent. **Due:** 7 November 2026.

## Question

Can the agent's decisions run on NEAR's private AI, with an attestation for each action that a stranger can check later on the check page? If not, decisions stay deterministic with a hashed log, and the brief's target falls from 5.00 to 4.80.

## Evidence

Primary source: `@nearai/inference-sdk` 0.2.1 on npm (published 29 October 2026), including its bundled `docs/verification-guide.md` and `docs/api-reference.md`. Secondary sources: NEAR AI's site and blog via web search. `docs.near.ai` and `cloud-api.near.ai` were blocked from this session, so no live call was made.

What the SDK documents:

- **The API.** NEAR AI Cloud is OpenAI-compatible, and also offers Responses, Anthropic-style Messages and "System One" structured decisions. It needs an API key (`NEARAI_API_KEY`).
- **Attestation.** The client verifies the Gateway's TEE evidence and, for supported models, the model deployment's TEE evidence (Intel TDX quote plus NVIDIA GPU evidence through NVIDIA's NRAS) before sending a request.
- **Per-response signatures.** `verifyResponse(id)` checks a signature over the **exact request and response bytes**. A `provider_tee` signature is made by a key inside the attested model TEE. A `gateway` signature only proves the Gateway saw those bytes, not which model ran.
- **Manual verification.** `AttestationClient` exposes `fetchGatewayAttestation`, `fetchModelAttestations` and `fetchCompletionSignature`, plus standalone `verifyGatewayAttestation`, `verifyModelAttestation`, `verifyModelResponse` and `verifyGatewayResponse`. So we can store the evidence ourselves and re-check it later.
- **Structured decisions.** `client.systemone.create({ model, state, questions })` returns a structured answer with a `decisionId` that can be verified the same way. This matches "the agent decides an action from a state" closely.
- **Retention.** The SDK keeps request and response bytes in memory for 60 minutes by default. After that, `verifyResponse` returns `api.completion_not_found`. For the check page, the agent must save the bytes, the signature and the attestation evidence when it makes each decision.
- **Runtime.** The SDK needs Node 24.22.1 or later. The architecture assumed Node 22, so `apps/agent` moves to Node 24.

## Answer so far

**It looks like a fit, but the gate hasn't passed.** The SDK supports what the architecture needs. Each decision can carry a signature from a key inside an attested model TEE over the exact request and response, and a third party can re-check that signature from stored evidence.

How it would plug in (architecture section 7):

1. Before each decision, the agent verifies the Gateway and model attestation (cached for up to 60 minutes) and saves the evidence.
2. It sends the market state and rules as a System One request or chat completion, with no keys or secrets in the prompt.
3. It verifies the response signature, and requires `signatureKind === "provider_tee"`, because a Gateway-only signature doesn't prove which model ran.
4. It saves the exact request bytes, response bytes, signature and attestation evidence as the decision record, and puts `sha256` of the record on-chain as `decision_hash`. The attestation hash goes in `attestation_hash`.
5. The proposed action still goes through `withinRules` and the contract's limits, so the model can't widen anything.
6. At close, the check page re-verifies each signature against the stored attestation, which it can do in the browser with the SDK's standalone functions.

## Still open

- [ ] **Get a NEAR AI Cloud API key** and make one attested decision with a model that supports model attestation. Save the full record and verify it in a fresh process, offline from the original client. This is the pass test.
- [ ] **Check re-verification after time passes.** NVIDIA's NRAS token has an expiry. Confirm what a stranger can still verify days later: the response signature against a stored attestation, the Intel quote, or both. Ask NEAR if unclear.
- [ ] **Pick the model** and record its id, `providerType` and `attestationSupported` from `fetchModelMetadata`.
- [ ] **Ask NEAR** (as the brief says): does private inference fit an always-on agent loop of about one decision per minute, and what does it cost at that rate?
- [ ] **Decide** whether the brief's "attested decisions" claim is made. It can only be made if the pass test works.

If any of the first two fail, take the brief's fallback: deterministic decisions with a hashed log, and no attestation claim.

**Sign-off:** _pending_
