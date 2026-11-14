# Design audit: `docs/INTERFACE.md` draft (39c56be)

One fresh `security-auditor` on the diff (D52). Built items all matched the code. Critical 0, High 0, Medium 3, Low 8. Fixed in the next commit:

| Finding | Resolution |
|---|---|
| M-1: event provenance unspecified; a forged `poolside` event from another contract could make a deliverer seal to an attacker's key, or raise false alerts (unlisted threat) | **Fixed:** section 1 states clients trust an event only from a successful receipt executed by the strategy account, read through both providers, and use events only as triggers; the deliverer seals only to the key-sale view's `buyer_pubkey`. New threat T74; EC-K06 and EC-N04 for the deliverer and alerter tests |
| M-2: `get_deploy_block()` is self-reported state, which earlier code could have written (EC-W16) | **Fixed:** marked a hint only; the page takes the creation block from chain data and a mismatch is never matching; EC-W29 |
| M-3: `get_config()` "as given to `new`" contradicts `set_agent` | **Fixed:** `agent` changes on `set_agent`; clients read it at each sampled height; EC-W29 |
| L-1: input strictness claimed but not built | **Fixed (doc):** outputs strict, inputs Open until the strict newtypes and the M1 parsing test |
| L-2: `STATE:` prefix and unprefixed failures | **Fixed:** `STATE:` removed; unprefixed failures are "can't check" |
| L-3: `Refused(reason)` naming | **Fixed:** snake_case fixed set listed; unknown reason is "can't check" |
| L-4: holdings with one block per token; settle window as an object | **Fixed:** per-read blocks (proposed shape); the object shape marked proposed |
| L-5: status labels | **Fixed:** "Built, growing" for `get_lock` and `resolve_stale`; unlisted names marked Proposed |
| L-6: missing views and constants | **Fixed:** `is_paused()`, `get_near_owed(account)` proposed; `adopt_window_s` and `max_swaps_per_run` added to `get_constants` |
| L-7: decision hash without a parsing rule | **Fixed:** one helper in `packages/rules` with the chain link; `strictParse` only, duplicate-key vector |
| L-8: `ft_on_transfer` row understated the funding rules | **Fixed:** full rules stated |
