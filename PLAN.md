# zkVerify Agent Games — Proof Gatekeeper: Build Plan

**Status (15 Nov 2026, ~17:35 WIB):** RESEARCH + PLAN ONLY. No registration by this agent, no sign-in, no spending.
Competition account **already registered by the parent (17:26–17:31 WIB)** via X `@nawijikk` (email goletupo@gmail.com, country Indonesia, ref `AB5GW2U7`). GitHub `faaz12` connected 17:33 WIB. Eligibility 4/5 — remaining only "at least one scored agent". Own referral code `9G42A6T4` (+15 pts/referral).
**Target: agent live + practice-tested before Round 04 opens Mon 16 Nov 17:30 WIB.** Round 03 is live now (15 Nov 17:30) and entries are locked during a round.

Prize: 100,000 VFY per track (1st 50,000 / 2nd 30,000 / 3rd 20,000). Entry free. All tracks close 21 Nov 2026 23:59 WIB; judging 22–30 Nov.

---

## 0. Corrections to the original brief — READ FIRST

The task brief described a different task than the real one. The public event page is authoritative; the brief's version is **wrong in three places**:

| Brief said | Reality (verified from public pages) |
|---|---|
| Agent receives `payment_request` + `risk_context` (amount_z_score, recipient_age_days, velocity_1h, …) and needs a risk scorer | Real task payload is a **deterministic on-chain condition check** (see §2): `registered_vk`, `proof_vk`, `minimum`, `public_balance`, `expiry_block`, `current_block`, `recipient`, `condition_recipient`, `amount`, `max_transfer`, `proof_tx`. No risk_context fields appear anywhere on the public pages. The decision is **7 trap checks**, not a risk score. |
| Scoring +20 correct / −10 wrong / −5 missed deadline / +20 per completed day / proof bonus +10 / +4 | Real scoring (event page + dashboard): **correct +12, wrong APPROVE −6, wrong REJECT −3, timeout −2, missing/invalid proof −2, reliability bonus +0 to +5** (pro-rated by share of provable tasks whose proof verified). |
| 8 rounds, 13–20 Nov | Event page: 8 rounds 13–20 Nov. **Dashboard says 9 rounds, 13–21 Nov.** Discrepancy unresolved — confirm in dashboard; plan for a possible Round 09 on 21 Nov. |
| zkey at `…/circuits/gatekeeper.zkey` | That URL **404s**. Correct URL is `…/circuits/gatekeeper_final.zkey` (per `/api/circuit-info`). |

**Design consequence:** build the agent as a **dual-mode** decider (§4): trap-check mode when the condition fields are present (the documented format), risk-score fallback when a `payment_request`/`risk_context` payload shows up instead, fail-closed otherwise.

---

## 1. Verified facts (all measured 15 Nov 2026, this VM)

### 1.1 Circuit artifacts — authentic, downloaded
- `~/workspace/zkverify/gatekeeper/circuits/gatekeeper.wasm` — 1,755,820 bytes, SHA-256 `be00aefe…92764f` ✓ matches the hash published by an independent participant.
- `~/workspace/zkverify/gatekeeper/circuits/gatekeeper_final.zkey` — 309,750 bytes, SHA-256 `adfe95a4…f80d` ✓ matches.
- `vk.json` exported from the zkey with snarkjs: protocol `groth16`, curve `bn128`, **nPublic = 13**, IC length 14.
- `/api/circuit-info` (live JSON): gatekeeper `vkHash = 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`, network `mainnet`. (Second circuit `vfyPolicy` is for Steal the VFY — not needed.)

### 1.2 Proof generation — VERIFIED WORKING on this VM
- `snarkjs@0.7.5` installed in `/tmp/snarktest` (Node v24.22.1). Test script: `tests/prove-valid.js`, output: `tests/proof-valid.json`.
- Valid scenario (balance 1460 ≥ min 1000, amount 500 ≤ cap 1000, recipient matches, expiry 8,430,000 > current 8,420,000, proofVk == registeredVk, decision=1): **`fullProve` OK in 1.1 s**, proof JSON 721 chars (~804-byte raw proof per independent reports), **`snarkjs groth16 verify` → OK**.
- Circuit template name (from wasm strings): `GatekeeperEvaluation_79`. A wrong decision fails witness generation with `Assert Failed. Error in template GatekeeperEvaluation_79 line: 102` — the circuit enforces `decision == correct(decision)`; a wrong decision cannot even produce a witness.
- **Quirk:** `fullProve` with missing/incomplete inputs **hangs indefinitely** (observed: killed after 3+ min) instead of erroring. Always validate inputs before proving. Also: after a successful prove, the Node process did not exit on its own (snarkjs keeps the loop alive) — irrelevant in a long-running server, but don't `await` proof generation in a one-shot script without `process.exit()`.
- Independent corroboration: two separate participants (Medium, 14–15 Nov) produced the same 804-byte proof and `verify OK` with snarkjs 0.7.6, and reverse-engineered the same 13 signal names.

### 1.3 Circuit input signals (13) — confirmed by local proof test
`registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient, amount, maxTransfer, decision, taskId, salt`

Encoding used in the verified test (all as decimal strings — snarkjs accepts decimal strings for field elements):
- vk hashes: `BigInt("0x6b79…").toString()` (fits in the BN254 field: value ≈ 4.9e76 < p ≈ 2.19e77).
- addresses: `BigInt("0x…").toString()` (160-bit → field element).
- numbers (minimum, balances, blocks, amounts): plain decimal strings.
- `decision`: `"1"` = APPROVE, `"0"` = REJECT.
- `taskId`: used `"12345"` (numeric guess) — worked locally. **The platform's canonical encoding of the real taskId string (e.g. `"gk_24_9d1"`) is UNKNOWN — see §10, risk #1.**
- `salt`: used `"98765432109876543210"` (arbitrary private field element) — worked locally. Salt is private; the platform cannot recompute anything involving it.

Public signals returned (n=13), in order:
`[derivedHash, registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient, amount, maxTransfer, decision, taskId]`
- `publicSignals[0]` is a **derived value** (not one of my inputs): `20317616490590918393469746441004286467973510518657607402423228086115369439811`. Most likely a hash/commitment over the task fields (Poseidon/keccak — unconfirmed). The platform must recompute the expected public signals from the task; if our `taskId` encoding differs from theirs, the proof will not match. **Resolve in practice mode (§9 step 6).**

### 1.4 The field is weak on plumbing (leaderboard snapshot 15 Nov ~09:30 WIB, per a participant article)
- Proof Gatekeeper Round 1: 112 tasks issued, 65 answered, **only 3 verified**. Round 2: 272 issued, 129 answered, **0 verified**. Top: #1 at 87.9, then 20 agents tied at 80.0.
- Implication: an agent that actually answers on time with valid proofs has a lot of room. The reliability bonus (+0–5) is almost entirely unclaimed.

### 1.5 VM network — public endpoint CANNOT be created from this VM via free no-account tunnels (measured twice today)
- Local IPv4 `198.19.0.2/30` (CGNAT `198.18.0.0/15`), local IPv6 `fd8b:4f84:7d32:99::2` (ULA). Neither is publicly routable. All egress goes through an authenticated proxy (`hatch-egress-proxy:3128`).
- Measured 15 Nov ~10:32 WIB (this VM, re-tested after the dev.to author's 10:07 WIB test gave the same results):
  - `api.trycloudflare.com/tunnel` → **HTTP 403**; live `cloudflared tunnel --url …` → `failed to request quick Tunnel: … tls: first record does not look like a TLS handshake` (proxy intercepts it).
  - `server.localtunnel.me` → curl 000 (unreachable).
  - `bore.pub` → curl 000 (timeout).
  - `tunnel.ngrok.com` → curl 000 (and ngrok needs an account + authtoken anyway).
- **Conclusion: Cloudflare Tunnel / localtunnel / bore / ngrok from this VM are DEAD. Do not waste more time on them.** See §6 for the routes that remain.

---

## 2. Agent interface (from `/build` + `/events/proof-gatekeeper` + `/rules`)

### 2.1 Incoming task envelope
- `POST` JSON to the registered endpoint. **Verify the HMAC signature (`x-agent-games-signature` header) against the RAW body before parsing or processing.** (Exact HMAC scheme — hex vs base64, `sha256=` prefix — is NOT documented publicly; assume hex HMAC-SHA256, verify against preflight in §9 step 5.)
- Hard deadline: **60 seconds** (late = timeout, −2). HTTPS only. Public registered endpoint, no localhost / private IP / custom ports (i.e. port 443).
- Task IDs are **idempotency keys** — the platform may retry after a network failure. Dedupe by `task_id`: if a `task_id` was already answered, return the same stored response, do not re-prove.
- **Fail closed:** reject on timeout or uncertainty.

Sample task payload (from the event page):
```json
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "gk_24_9d1",
  "mode": "competition",
  "issued_at": "<issued-at>",
  "deadline_at": "<deadline-at>",
  "input": {
    "registered_vk": "0x7d3a...f291",
    "proof_vk": "0xa4c1...b8ff",
    "minimum": "1000",
    "public_balance": "1460",
    "expiry_block": 19842201,
    "current_block": 19832000,
    "recipient": "0xDe42...9f01",
    "condition_recipient": "0xDe42...9f01",
    "amount": "500",
    "max_transfer": "1000",
    "proof_tx": "0xa4c1...8ff1"
  }
}
```
Note: the `registered_vk`/`proof_vk` in real tasks are full hashes (the sample is truncated with `…`). In the valid case `proof_vk` equals the registered vkHash `0x6b79c6…d77b0` from `/api/circuit-info`.

### 2.2 Expected response
Sample from the event page (REJECT example — abbreviated, no proof field shown):
```json
{ "decision": "REJECT", "reason_code": "VK_SUBSTITUTION", "proof_tx": "0xa4c1...8ff1" }
```
The build guide says **"generate proofs locally with snarkjs, and include the proof in your response"**, and independent builders report **"return the proof and its public signals in the signed response"**. So the real response must also carry the proof. Implement:
```json
{
  "decision": "APPROVE",
  "reason_code": "VALID_CONDITION",
  "proof_tx": "<echo input proof_tx>",
  "proof": { "pi_a": ["…","…","1"], "pi_b": [[…],[…],["1","0"]], "pi_c": ["…","…","1"], "protocol": "groth16", "curve": "bn128" },
  "publicSignals": ["…13 values…"]
}
```
- Every response is **signed with `x-agent-games-signature` over the raw response body** (HMAC with the platform-issued secret).
- For APPROVE the reason code is presumably `"VALID_CONDITION"` (unverified — the page only shows a REJECT example; confirm in practice mode).
- Extra fields are presumably ignored if unneeded; missing proof costs −2 and forfeits the reliability bonus, so always include it when it can be generated.
- If proof generation fails (wrong-decision assert, timeout): still return the decision without the proof (correct decision without proof = +12 −2 = +10, better than timing out at −2). **Never let proof generation block the decision past the 60 s deadline — prove with a ~10 s internal budget, then answer.**

### 2.3 Registration-time requirements (dashboard, per parent's 17:26–17:31 exploration)
- Agent registration fields: name, tracks, personal GitHub repo, HTTPS endpoint **full path**, 60 s deadline.
- HMAC secret: 32-byte random, **shown exactly once** — store immediately in the hosting env (never in the repo).
- Preflight must pass: `{ok: true, protocolVersion: "v1"}` — implement `GET /` and `GET /health` returning exactly that JSON.
- **≥1 practice task required** before scored rounds.
- Up to 3 agents per participant, one per automated event (dashboard text).

---

## 3. Decision logic

### 3.1 Mode A — trap checks (the documented format; expected for all real tasks)
Run all 7 checks on `input`. Each task is exactly one of the 7 types (shares sum to 100%), so at most one check should fail; still, evaluate all and log every failure.

| # | Check | Fail → reason_code | Share |
|---|---|---|---|
| 1 | `proof_vk == registered_vk` (case-insensitive hex compare) | `VK_SUBSTITUTION` | ~13% |
| 2 | `public_balance >= minimum` (BigInt compare) | `THRESHOLD_MISMATCH` | ~8% |
| 3 | `proof_tx` not in local seen-set | `PROOF_REUSED` | ~11% |
| 4 | `current_block <= expiry_block` | `EXPIRED_CONDITION` | ~6% |
| 5 | `recipient == condition_recipient` (case-insensitive) | `RECIPIENT_MISMATCH` | ~6% |
| 6 | `amount <= max_transfer` (BigInt compare) | `AMOUNT_OVERFLOW` | ~6% |
| 7 | all pass | `VALID_CONDITION` → APPROVE | ~50% |

- Add `proof_tx` to the seen-set **only after** a decision is made on it (a task that fails HMAC verification must not poison the set). Persist the seen-set (§6.3) — a reused proof arriving after a cold start must still be caught.
- Deterministic check order for the (shouldn't-happen) multi-failure case: VK → THRESHOLD → PROOF_REUSED → EXPIRED → RECIPIENT → AMOUNT. Log all failures; report the first.
- **On-chain confirmation:** the event-page checklist says "Call zkVerifyJS to confirm the proof is on-chain and its VK matches the registered condition VK". zkVerifyJS `verify()` submits a transaction and needs a funded account + seed phrase — **do NOT put a seed phrase on the server**. Judgment call (document it): the payload fields alone determine the correct decision for all 7 trap types, and the platform is the task issuer — so the decision comes from the payload. Attempt a **read-only** confirmation of `proof_tx` (public explorer/RPC read, no signing) best-effort for logging only; it must never override the payload decision. If no public read endpoint exists, skip it and note it in the log.

### 3.2 Mode B — risk-score fallback (only if a `payment_request`/`risk_context` payload arrives)
The parent's brief described this format; it appears nowhere on the public pages, but the agent must not crash on it. Sensible, deterministic scorer (0–100 risk score; reject if score ≥ 60; approve otherwise; fail closed on missing fields):
- `amount_z_score > 3` → +35; `> 2` → +20.
- `recipient_age_days < 7` → +25; `< 30` → +12.
- `recipient_tx_count == 0` → +20; `< 5` → +10.
- `recipient_reputation` (0–1, lower is worse): `< 0.3` → +25; `< 0.5` → +12.
- `velocity_1h >= 5` → +15; `velocity_24h >= 20` → +15.
- `unusual_hour == true` → +8.
- `memo_keywords` containing any of `urgent, gift, investment, crypto, double, refund, prize, winner` → +12.
- `sender_country != recipient_country` → +8.
- Confidence = `1 − |score − 60| / 60` clamped to [0.05, 0.95]; reason codes e.g. `HIGH_AMOUNT_ZSCORE`, `NEW_RECIPIENT`, `VELOCITY_SPIKE`, `LOW_REPUTATION`, `SUSPICIOUS_MEMO`, `OK`.
- No Groth16 proof exists for this mode (the gatekeeper circuit doesn't cover it) — return the decision without a proof and log the mode. (If this mode ever actually fires, the proof path for it is a separate research task.)

### 3.3 Mode C — anything else → fail closed
Unknown payload shape → `REJECT` with reason `UNKNOWN_FORMAT` (no proof). Log the raw envelope (redact nothing — there are no secrets in a task envelope).

---

## 4. Scoring (verified: event page + dashboard)

| Outcome | Points |
|---|---|
| Correct APPROVE (verified) | +12 |
| Correct REJECT (verified) | +12 |
| Incorrect APPROVE | −6 |
| Incorrect REJECT | −3 |
| Delivery timeout (>60 s) | −2 |
| Missing / invalid proof on a provable task | −2 |
| Reliability bonus (pro-rated by share of provable tasks whose proof verified) | +0 to +5 per round |

- 8 tasks per agent per round; scores cumulative across rounds (Rounds 04–08 remaining, possibly 09 on 21 Nov).
- Expected value of the deterministic trap checker: if it is correct on all 7 types, a round is 8×(+12) = +96 plus up to +5 reliability = **up to +101/round**. The only ways to lose points are plumbing failures (timeout, missing proof, wrong `reason_code` on a multi-trap task, `taskId` encoding mismatch killing proof verification).
- Wrong APPROVE (−6) is punished twice as hard as wrong REJECT (−3): when genuinely uncertain between the two, prefer REJECT.

---

## 5. Deployment — the decision

### 5.1 PRIMARY: Vercel (serverless, free Hobby tier) — PROVEN by a live competitor
- Evidence: participant Andruu21 (BAOK-GK) runs a live gatekeeper on Vercel: platform preflight "Healthy, 579 ms", practice 4/4 correct, one finalized proof on zkVerify mainnet with published tx hash.
- Why it fits: Node.js serverless function; bundle = server (~10 KB) + snarkjs (~2 MB) + `gatekeeper.wasm` (1.76 MB) + `gatekeeper_final.zkey` (310 KB) — far under Vercel's 250 MB limit. Proof generation measured 1.1 s; cold start ~1–2 s; total well inside the 60 s deadline.
- Caveats: (a) Vercel Hobby serverless max duration is 10 s by default (Pro: 60 s) — verify the actual limit at deploy time; 1.1 s prove + ~2 s cold start leaves headroom, but a slow cold start + slow prove could approach it. Set `maxDuration: 10` explicitly in `vercel.json` and measure p95 latency in practice. (b) Serverless is stateless — the seen-set needs external persistence (§6.3). (c) Needs a Vercel account (free Hobby, sign up with GitHub `faaz12`) and `vercel login` — the parent must do this in the device browser; the CLI is already installed at `/opt/hatch/bin/vercel`.
- Steps: `cd ~/workspace/zkverify/gatekeeper && npx vercel --prod` (first deploy links the project), set env `HMAC_SECRET` in the Vercel dashboard (never in the repo), deploy, note the `https://<project>.vercel.app` URL, register that full URL (+ path, e.g. `/task`) as the agent endpoint.

### 5.2 FALLBACK: Tailscale Funnel
- `tailscale` binary is present (`/opt/hatch/bin/tailscale`, status: **Not connected**, login server `controlplane.tailscale.com`). A Tailscale connector exists in the parent's tooling.
- Route: connect this VM to the user's tailnet, run the Node server locally, expose it with `tailscale funnel 443` (or `tailscale serve`) → public `https://<machine>.<tailnet>.ts.net` on port 443 with valid TLS. Keeps the seen-set on local disk (persistent across restarts if the VM survives; VM restarts wipe `/tmp` but `~/workspace` persists).
- Needs: the user to approve the VM joining their tailnet + enable Funnel. This is a user decision — ask the parent if Vercel fails.
- Risk: the VM is replaced/restarted periodically (uptime was 14 min at 10:26 WIB today); a restart kills the server and the funnel until someone restarts them. A `tmux` session + a small watchdog cron (restart server + funnel if down) mitigates it, but a restart mid-round still forfeits tasks until the watchdog fires.

### 5.3 DEAD routes (measured, do not retry)
| Route | Result (15 Nov, this VM) |
|---|---|
| Cloudflare Tunnel / trycloudflare | HTTP 403 from `api.trycloudflare.com`; live run fails TLS handshake (egress proxy blocks it) |
| localtunnel | server unreachable (curl 000) |
| bore.pub | unreachable (curl 000) |
| ngrok | unreachable (curl 000); also needs account + authtoken |
| Direct hosting on VM | no public IP (CGNAT 198.19.0.2, ULA IPv6); inbound impossible |

### 5.4 Seen-set persistence (PROOF_REUSED needs it)
- Problem: Vercel serverless is stateless; an in-memory `Set` dies on every cold start. A reused `proof_tx` after a cold start would be wrongly APPROVEd (−6).
- Solution: persist the seen-set to **Upstash Redis free tier** (10k requests/day, email signup — needs a parent/user account decision) with in-memory cache in front; on startup, load the set. Fallback if no Redis: append each `proof_tx` to a GitHub repo file via the GitHub API (token already exists for `faaz12` until Nov 2027) — hacky but free and durable; read it at startup. Either way, also keep the in-memory set as the fast path.
- Expected volume: ≤ 8 tasks/round × 5–6 rounds ≈ 40–48 entries. Trivial size.

### 5.5 Kurier (optional, background only — never on the critical path)
- The build guide's recommended verification path: REST API at `https://api.kurier.xyz/api/v1`, needs an **API key from kurier.xyz signup** (free tier / cost unverified — resolve at build time; do NOT pay). Flow: `POST /register-vk/{key}` once with our `vk.json` (returns the vkHash — should equal `0x6b79…d77b0`), then per proof `POST /submit-proof/{key}` with `{proofType:"groth16", vkRegistered:true, proofOptions:{library:"snarkjs",curve:"bn128"}, proofData:{proof, publicSignals, vk}}`, poll `GET /job-status/{key}/{jobId}` until `Finalized` (~15–30 s in their example).
- Use it **asynchronously, after responding**: submit the proof in the background and log the jobId/txHash. It is a belt-and-braces on-chain proof reference; the platform re-verifies the proof from the response itself, so the response must not wait for Kurier finalization.
- **Never use zkVerifyJS** (`Volta` session) — it needs a seed phrase + tVFY. No seed phrase ever goes on a server.

---

## 6. Wildcard + Creator — can one account enter both? (task Q4)

**YES.** One competition account can enter Proof Gatekeeper AND Wildcard, and the SAME agent (same repo + same endpoint) can be submitted to Wildcard while its endpoint plays Gatekeeper.

Exact rule text (from `/rules`, §1.5 "One agent, one owner"):
> "One GitHub account per competition account. One competition account per person or team. Running multiple accounts to enter the same event is immediate disqualification."
> "Teams must designate a single competition account. All prize correspondence goes to the registered wallet on that account."

And from `/events/proof-gatekeeper` (entry requirements):
> "One agent per owner in this event; entries lock while a round is open"

What these rules forbid is **multiple accounts / multiple agents per person** — not multiple events per agent. Nothing in the rules or the Wildcard page forbids entering several tracks with one account; the register flow itself says "Enter events" (plural), and the dashboard allows up to 3 agents per participant, one per automated event (dashboard text, per parent's exploration). The Wildcard page only asks for:
> "A public HTTPS endpoint for your agent, as requested in the submission form" + "A public repository, demo, or write-up showing the agent you built."

So the Wildcard submission is essentially free once Gatekeeper is live: same public repo + same Vercel endpoint + a short write-up. Wildcard form fields (dashboard): title, repo, what-it-does ≤ 2000 chars; optional endpoint / proof ref / links / message ≤ 1000 chars. Judging is by a human panel (30% usefulness, 30% creativity/originality, 20% zkVerify verification quality, 20% technical execution) — a live gatekeeper with valid on-chain proofs scores on all four.

Creator Track form (dashboard): category THREAD / VIDEO / ARTICLE / OTHER, title, links, context ≤ 1000 chars; content must include `#AgentGames` + tag `@ZKVProtocol` on X. (Separate content work; not part of this build.)

---

## 7. File layout (under `~/workspace/zkverify/gatekeeper/`)

```
~/workspace/zkverify/gatekeeper/
├── PLAN.md                  # this file
├── README.md                # run + deploy instructions (write during build)
├── package.json             # deps: snarkjs@0.7.5 (verified working; 0.7.6 also verified by others)
├── vercel.json              # { "functions": { "api/task.js": { "maxDuration": 10 } }, "includeFiles": "circuits/*" }
├── .env.example             # HMAC_SECRET=… / KURIER_API_KEY=… (optional) — NEVER commit real secrets
├── .gitignore               # .env, node_modules, seen-set local file
├── circuits/
│   ├── gatekeeper.wasm      # ✓ downloaded (SHA-256 verified)
│   ├── gatekeeper_final.zkey# ✓ downloaded (SHA-256 verified)
│   └── vk.json              # ✓ exported from zkey (groth16, bn128, nPublic 13)
├── api/
│   └── task.js              # Vercel serverless entry: POST /api/task (+ GET /api/health)
├── src/
│   └── (moved: scripts/local-server.js — plain-Node HTTP server, local dev + Tailscale fallback)
│   ├── hmac.js              # verify x-agent-games-signature (incoming) / sign responses (outgoing)
│   ├── decide.js            # Mode A trap checks + Mode B risk scorer + Mode C fail-closed
│   ├── prove.js             # snarkjs fullProve wrapper (input validation FIRST, ~10 s budget) + verify
│   ├── kurier.js            # optional background submit-proof + job-status poll (never blocks response)
│   └── store.js             # seen-set: in-memory + Upstash/GitHub persistence (§5.4)
└── tests/
    ├── prove-valid.js       # ✓ verified working (1.1 s, verify OK)
    ├── proof-valid.json     # ✓ output of the verified test
    └── trap-matrix.json     # 13 cases: 7 trap types × APPROVE/REJECT variants (write during build)
```

---

## 8. Build order + exact commands

**Target: live + practice-tested before Round 04, Mon 16 Nov 17:30 WIB.**

### Step 0 — Decisions needed from the parent/user (before building)
1. **Deployment route: Vercel (primary) or Tailscale Funnel (fallback)?** Vercel needs a free Hobby account (GitHub `faaz12` login in the device browser) + `vercel login`. Tailscale needs the VM joined to the user's tailnet + Funnel enabled.
2. **Upstash Redis free tier** (or GitHub-file fallback) for the seen-set — needs an account decision.
3. **Kurier API key** — free signup at kurier.xyz; confirm the free tier covers our volume (≤ ~50 proofs) before relying on it. (Optional — the response proof is primary; Kurier is background-only.)

### Step 1 — Scaffold (local, this VM)
```bash
cd ~/workspace/zkverify/gatekeeper
npm init -y && npm pkg set type=module
npm install snarkjs@0.7.5   # verified working; do NOT upgrade without re-running tests/prove-valid.js
cp /tmp/snarktest/prove-valid.js tests/prove-valid.js   # already copied
node tests/prove-valid.js   # must print "fullProve OK" + "verify: OK" (note: process may not exit on its own — add process.exit(0))
```

### Step 2 — Server + decision logic (no framework, plain Node `http`)
- `src/decide.js`: implement §3.1 (BigInt compares, case-insensitive hex compares) + §3.2 fallback + §3.3.
- `src/hmac.js`: `verifyHmac(secret, rawBody, signature)` and `signHmac(secret, rawBody)` — hex HMAC-SHA256; keep the scheme in one place so the variant can be swapped after preflight.
- `src/prove.js`: build the 13-field circuit input from the task (see §1.3 encoding), validate all fields present, `fullProve` with a 10 s budget (race against a timeout), then `groth16.verify` locally before including the proof (defense: never send a proof that doesn't verify locally).
- `src/store.js`: seen-set with in-memory Map + persistence (§5.4).
- `api/task.js` / `scripts/local-server.js`: request flow —
  1. read raw body → 2. verify HMAC → 401 if bad (log, no work) → 3. parse JSON → 4. dedupe by `task_id` (return stored response if seen) → 5. decide (Mode A/B/C) → 6. if APPROVE or REJECT-with-checks-passed… actually: generate the proof for the decision in all Mode A cases (the circuit asserts decision correctness, so a correct decision always proves; a wrong decision fails to prove — which is itself a signal to re-check the decision logic) → 7. respond `{decision, reason_code, proof_tx, proof, publicSignals}` signed with `x-agent-games-signature` → 8. background: Kurier submit (if configured) + append `proof_tx` to seen-set + write a JSON log line.
- `GET /` and `GET /health` → `{ok: true, protocolVersion: "v1"}`.
- Trap-matrix test: 13 cases in `tests/trap-matrix.json` (valid ×2 decisions, each trap × correct reject, each trap × wrong approve → must fail to prove). All must behave as specified before deploying.

### Step 3 — Deploy to Vercel
```bash
cd ~/workspace/zkverify/gatekeeper
vercel --prod            # first run links the project; follow the CLI prompts
vercel env add HMAC_SECRET production   # paste the secret from agent registration (Step 4) — never in the repo
curl -s https://<project>.vercel.app/api/health   # must return {"ok":true,"protocolVersion":"v1"}
```

### Step 4 — Register the agent endpoint (dashboard, device browser — parent)
- Fields: name, tracks = Proof Gatekeeper, personal GitHub repo (public, e.g. `faaz12/zkverify-gatekeeper`), HTTPS endpoint **full path** (`https://<project>.vercel.app/api/task`), 60 s deadline.
- **Save the HMAC secret immediately** (shown once) → into Vercel env (`vercel env add`) and `~/.zkverify/hmac-secret` (mode 600, never in the repo/chat).
- Preflight must return `{ok:true, protocolVersion:"v1"}`.

### Step 5 — Practice mode (mandatory, ≥1 task)
- Fire practice tasks from the dashboard; verify: (a) decisions correct per the trap matrix, (b) proofs accepted by the platform, (c) HMAC format accepted, (d) **taskId encoding matches** (if the platform rejects the proof, try alternate `taskId` encodings: keccak256 of the string, Poseidon hash, numeric suffix of `gk_24_9d1` — see §10 risk #1).
- Fix, re-deploy, re-practice until a practice round is fully correct with verified proofs.

### Step 6 — Wildcard submission (same repo + endpoint, after Gatekeeper is live)
- Dashboard Wildcard form: title, repo URL, what-it-does (≤2000 chars), endpoint URL, proof reference (Kurier jobId/txHash if available), links, message (≤1000 chars).
- No extra code needed.

### Step 7 — Operate Rounds 04–08 (16–20 Nov, possibly 09 on 21 Nov)
- Arena window nightly 17:30–03:30 WIB; 8 tasks/agent/round. Keep the endpoint up; watch the Vercel logs + the dashboard after each round; if the tunnel/endpoint dies mid-round, tasks are forfeited — no recovery within that round.

---

## 9. Open questions (could NOT be verified from public sources)

1. **`taskId` canonical encoding.** Local test used `"12345"`; real taskIds look like `"gk_24_9d1"`. The platform recomputes expected public signals — if our encoding differs, proofs fail verification. Candidates to try in practice mode, in order: (a) decimal of the string's UTF-8 bytes as a big integer; (b) keccak256(string) as field element; (c) numeric suffix (`24_9d1` → ?); (d) Poseidon hash. **Resolution: practice mode verdict.**
2. **HMAC scheme variant.** Assume hex HMAC-SHA256 over the raw body, header `x-agent-games-signature`. If preflight fails, try base64 and `sha256=`-prefixed hex. **Resolution: preflight.**
3. **Response proof field name/shape.** Event page sample omits it; build guide + builders say "include the proof in the response". Assume `proof` (snarkjs object) + `publicSignals` (array of decimal strings). **Resolution: practice mode.**
4. **APPROVE `reason_code`.** Presumably `"VALID_CONDITION"`; only a REJECT example is published. **Resolution: practice mode.**
5. **Vercel Hobby max function duration.** Believed 10 s; prove latency 1.1 s + cold start leaves headroom, but measure p95 in practice. If it is a problem, Tailscale Funnel (no duration cap) is the fallback.
6. **Kurier free tier.** Signup is free; whether the free tier covers ~50 proof submissions is unverified. Kurier is background-only, so a failure here costs nothing except the on-chain reference.
7. **Public read endpoint for `proof_tx` on-chain confirmation.** None found publicly. The decision does not depend on it (§3.1), but if one exists (zkVerify explorer API), wire it in as logging-only confirmation.
8. **8 vs 9 rounds.** Event page: 8 rounds 13–20 Nov. Dashboard: 9 rounds 13–21 Nov. Confirm in dashboard; keep the agent up through 21 Nov either way.
9. **Risk-context payload format.** The parent's brief described `payment_request`/`risk_context` fields that appear nowhere publicly. Mode B (§3.2) covers it defensively; if live tasks actually use it, the circuit proof path for that mode is undefined (the gatekeeper circuit only covers the condition format).

---

## 10. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `taskId` encoding mismatch → all proofs rejected | −2/task + no reliability bonus (decisions still score +12) | Practice-mode test with alternate encodings (§9.1) before Round 04 |
| Vercel cold start + 10 s Hobby cap → timeout | −2/task | Keep the function warm (no traffic needed — 8 tasks/round arrive within the window; measure p95 in practice; fallback to Tailscale Funnel) |
| VM restart kills nothing (Vercel) — but seen-set lost | PROOF_REUSED missed → −6 | External persistence (§5.4) |
| HMAC secret lost (shown once) | Agent cannot authenticate; must rotate in dashboard | Store immediately in Vercel env + `~/.zkverify/hmac-secret` (600) |
| Wrong `reason_code` on a multi-trap task | REJECT still correct, but "trap not correctly identified" may cost the +12 | Log all failed checks; single-trap design (shares sum to 100%) makes this unlikely |
| Kurier API key signup paywalled | Lose only the background on-chain reference | Response proof is primary; Kurier is optional |
| Round 03 already live; build slips past Round 04 | Lose a round's points (up to +101) | Rounds 05–08 (and possibly 09) remain; the build is ~1 focused session |

---

## Sources

- https://agentgames.zkverify.io/build (Builder Field Guide)
- https://agentgames.zkverify.io/events/proof-gatekeeper (task format, traps, scoring, schedule)
- https://agentgames.zkverify.io/events/wildcard (submission requirements, judging)
- https://agentgames.zkverify.io/rules (§1.1–1.7, incl. "One agent, one owner")
- https://agentgames.zkverify.io/api/circuit-info (vkHash + artifact URLs)
- https://docs.zkverify.io/handbook/quickstart (Kurier vs zkVerifyJS)
- https://docs.zkverify.io/overview/getting-started/kurier (register-vk / submit-proof / job-status)
- https://docs.zkverify.io/architecture/supported_proofs (Groth16/BN128, max 64 public inputs)
- Independent participant write-ups (Medium, 14–15 Nov): circuit signal names, 804-byte proof, ~3 s prove time, SHA-256 hashes of artifacts — all re-verified locally where possible (hashes ✓, proof ✓, latency 1.1 s on this VM).
- Tunnel measurements: this VM, 15 Nov 10:07 WIB (participant article) and 10:32 WIB (this research) — identical results.

---

## 11. Build notes (15 Nov 2026, ~18:00 WIB — implemented, local test only)

Built per this plan under `~/workspace/zkverify/gatekeeper/`, repo `faaz12/zkverify-gatekeeper` (public, MIT). No deploy, no registration, no spending.

### What was built
- `package.json`: snarkjs pinned to exact `0.7.5` (no caret), `type: module`.
- `src/decide.js`: Mode A 7 trap checks (BigInt compares, case-insensitive hex), Mode B risk scorer, Mode C fail-closed.
- `src/hmac.js`: hex HMAC-SHA256 verify/sign, scheme in one place (`HMAC_SCHEME` env switches to base64).
- `src/prove.js`: 13-field input builder with validation FIRST, `encodeTaskId` (numeric passthrough; otherwise decimal of UTF-8 bytes — candidate (a) from §9.1), `fullProve` with 10 s race, local `groth16.verify` before including any proof.
- `src/store.js`: seen-set, in-memory + GitHub-file (`data/seen-proofs.jsonl`), transports `GITHUB_TOKEN` (fetch) or `gh` CLI; `STORE_BACKEND=memory` for tests. Appends serialised; HMAC-failed tasks never reach it.
- `src/handler.js` (shared flow) + `scripts/local-server.js` (plain-Node, GET `/`/`/health`/`/api/health` → preflight, POST `/task`+`/api/task`) + `api/task.js` (Vercel, `bodyParser: false` for raw-body HMAC), `api/health.js`, `api/index.js` (GET `/` preflight cover).
- `vercel.json`: `maxDuration: 10`, `includeFiles` placed **inside** the per-function config (the plan's §7 layout showed it top-level; Vercel documents it per-function).
- `tests/trap-matrix.json`: 13 cases. `tests/trap-matrix.js` harness: 21/21 checks passed (preflight ×3, HMAC 401 ×2, Mode B, Mode C, 7 HTTP trap cases with locally-verified proofs, dedupe, 6 wrong-decision prove failures). Prove latency 87–909 ms (mean 477 ms). `tests/prove-valid.js` re-run (ESM): fullProve 0.9 s, verify OK.

### Deviations / findings (do NOT silently work around — recorded here)
1. **BUG FOUND + FIXED — `decide()` received the SeenStore, not a Set.** `decideModeA` called `seenProofs.has(...)`; the store exposes `hasProofTx()`. Every Mode A task fell through to Mode C `UNKNOWN_FORMAT`. Fixed with a duck-typed `seenHas()` in `src/decide.js` (accepts Set or store). Caught by the trap matrix, not by inspection.
2. **PLAN ASSUMPTION WRONG — a correct REJECT on `PROOF_REUSED` is UNPROVABLE.** The circuit has no seen-set input: for a reused-proof task (all other fields valid) the circuit's correct decision is APPROVE(1), so a decision=0 proof fails the witness assert (verified: `wrong-reject-valid-input` fails at line 102, and the PROOF_REUSED HTTP case returns no proof). The agent correctly returns the REJECT without a proof (+12, possibly −2 for missing proof). The plan's §8 step 2 ("generate the proof for the decision in all Mode A cases") does not hold for this one trap type. The trap-matrix case for it now asserts `expectProof: false`.
3. **Trap-matrix composition adjusted (still 13 cases).** The original case 10 ("wrong-approve-proof-reused") was untestable at the circuit layer for the same reason as (2) — it PROVED, correctly, because the input is genuinely valid. Replaced with "wrong-reject-valid-input" (valid input forced to REJECT must fail to prove). PROOF_REUSED remains covered at the HTTP layer (case 4).
4. **snarkjs 0.7.5 has no default ESM export.** `import * as snarkjs` used in `src/prove.js` and `tests/prove-valid.js` (which was converted from CJS to ESM).
5. **`fullProve` failure mode confirmed fast:** wrong decisions fail the witness assert in 42–138 ms (not a hang). The hang quirk applies to incomplete inputs only — validation-first prevents it.
6. **Vercel `includeFiles` placement** — see above.
7. **No Kurier integration** (per parent decision — SKIP for v1). No `src/kurier.js` was written.
