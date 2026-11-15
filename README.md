# zkVerify Agent Games — Proof Gatekeeper agent

An autonomous payment gatekeeper for the [zkVerify Agent Games](https://agentgames.zkverify.io) Proof Gatekeeper track. It receives signed task requests, decides APPROVE/REJECT by checking the on-chain condition (7 trap checks), and attaches a Groth16 proof (snarkjs, BN128) generated from the official `gatekeeper` circuit.

- Entry is free; the agent runs on the Vercel free Hobby tier.
- Scoring: correct +12, wrong APPROVE −6, wrong REJECT −3, timeout −2, missing/invalid proof −2, reliability bonus +0–5/round.
- 8 tasks/agent/round, rounds 13–21 Nov 2026 (nightly 17:30–03:30 WIB).

## How it decides

**Mode A — condition format (the real task format).** Seven deterministic
trap checks, evaluated in order, all failures logged, first failure reported:

| Check | Fail → reason_code |
|---|---|
| `proof_vk == registered_vk` (case-insensitive) | `VK_SUBSTITUTION` |
| `public_balance >= minimum` (BigInt) | `THRESHOLD_MISMATCH` |
| `proof_tx` not in the seen-set | `PROOF_REUSED` |
| `current_block <= expiry_block` | `EXPIRED_CONDITION` |
| `recipient == condition_recipient` (case-insensitive) | `RECIPIENT_MISMATCH` |
| `amount <= max_transfer` (BigInt) | `AMOUNT_OVERFLOW` |
| all pass | `VALID_CONDITION` → APPROVE |

**Mode B — risk-context fallback** (only if a `payment_request`/`risk_context`
payload arrives): deterministic 0–100 scorer, REJECT at ≥ 60. No Groth16
proof exists for this mode — the decision goes out without one.

**Mode C — anything else:** fail closed, REJECT / `UNKNOWN_FORMAT`.

**Known limitation: a correct REJECT on `PROOF_REUSED` is unprovable by
construction.** The circuit has no seen-set input, so for a reused-proof task
(all other fields valid) the circuit's correct decision is APPROVE; a
decision=0 proof fails the witness assert. The agent returns the correct
REJECT without a proof for this trap type (correct decision +12, possibly
−2 for the missing proof — still far better than a wrong APPROVE at −6).

## Request flow

`POST /api/task` (or `/task` locally):
1. Read the raw body → verify `x-agent-games-signature` (hex HMAC-SHA256) → 401 if bad. A failed-HMAC task never touches the seen-set.
2. Parse JSON → dedupe by `task_id` (idempotency key): an already-answered `task_id` returns the exact stored response.
3. Decide (Mode A/B/C).
4. Mode A: generate the Groth16 proof with a ~10 s internal budget, verify it locally with `groth16.verify`, and include `proof` + `publicSignals` (13 values) in the response. On ANY proof failure the decision still goes out without the proof — proving never blocks the decision past the 60 s deadline.
5. Respond `{decision, reason_code, proof_tx, proof?, publicSignals?}` signed with `x-agent-games-signature`.
6. Record `proof_tx` in the seen-set (in-memory + GitHub file, see below).

`GET /`, `GET /health`, `GET /api/health` → `{"ok":true,"protocolVersion":"v1"}` (platform preflight).

## Seen-set persistence

Vercel serverless is stateless, so the answered-`proof_tx` set is persisted
as one JSON line per task in `data/seen-proofs.jsonl` in this repo, loaded at
startup. Transports: `GITHUB_TOKEN` env (GitHub REST API, Vercel path) or
the `gh` CLI auth (local dev). Set `STORE_BACKEND=memory` to run in-memory
only (used by the test harness). A task that fails HMAC verification never
poisons the set.

## Run locally

```bash
npm install
cp .env.example .env        # put the dashboard-issued HMAC_SECRET in .env
npm start                   # plain-Node server on :3000
# or: HMAC_SECRET=test-secret STORE_BACKEND=memory npm start
```

## Test

```bash
npm run prove   # proof-path smoke test (fullProve ~1 s, verify OK)
npm test        # full trap matrix: 13 cases + preflight/HMAC/dedupe/Mode B/C
                # 21/21 checks passed (15 Nov 2026); prove latency 87–909 ms
```

## Deploy (Vercel, free Hobby)

Prerequisites: a Vercel account (sign up with GitHub), `vercel login`
(once, in a browser), and the agent registered in the zkVerify dashboard —
the HMAC secret is shown exactly once at registration.

```bash
vercel --prod                          # first run links the project
vercel env add HMAC_SECRET production  # paste the dashboard secret (never in the repo)
vercel env add GITHUB_TOKEN production # GitHub PAT (repo scope) for the seen-set file
curl https://<project>.vercel.app/api/health   # must return {"ok":true,"protocolVersion":"v1"}
```

Register the endpoint in the dashboard as the agent's HTTPS endpoint (full
path, e.g. `https://<project>.vercel.app/api/task`), run ≥ 1 practice task,
and confirm the proof verifies on the platform side before the first scored
round.

## Open questions (unverifiable until practice mode)

- **`taskId` encoding.** The platform recomputes the expected public
  signals; our encoding is decimal-of-UTF-8-bytes (numeric ids pass
  through unchanged, matching the verified local test). If the platform
  rejects proofs in practice mode, try keccak256 / Poseidon / numeric
  suffix — see `src/prove.js:encodeTaskId`.
- **HMAC scheme variant.** Assumed hex HMAC-SHA256. If preflight fails,
  set `HMAC_SCHEME=base64` (see `src/hmac.js`).
- **APPROVE `reason_code`.** Assumed `"VALID_CONDITION"` (only a REJECT
  example is published).
- **Response proof field shape.** Assumed `proof` (snarkjs object) +
  `publicSignals` (13 decimal strings).

## Files

```
api/task.js          Vercel entry: POST /api/task, GET preflight
api/health.js        GET /api/health preflight
api/index.js         GET / preflight
src/server.js        plain-Node HTTP server (local dev / Tailscale fallback)
src/handler.js       shared task flow (HMAC -> dedupe -> decide -> prove -> sign)
src/decide.js        Mode A trap checks + Mode B scorer + Mode C fail-closed
src/prove.js         snarkjs fullProve wrapper (validate first, 10 s budget, local verify)
src/hmac.js          HMAC-SHA256 verify/sign (scheme in one place)
src/store.js         seen-set: in-memory + GitHub-file persistence
circuits/            gatekeeper.wasm + gatekeeper_final.zkey + vk.json (SHA-256 verified)
tests/               prove-valid.js, trap-matrix.json (13 cases), trap-matrix.js
```

## License

MIT.
