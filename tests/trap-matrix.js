// Trap-matrix test harness (PLAN §8 step 2).
//
// Starts the local server in-process (in-memory seen-set — no GitHub
// writes), runs all 13 cases from trap-matrix.json, and checks decisions
// AND proofs. Extra plumbing checks: preflight GETs, HMAC 401s, idempotent
// dedupe, Mode B fallback, Mode C fail-closed.
//
// Exit 0 = everything passed. Exit 1 = any failure (names printed).
process.env.STORE_BACKEND = 'memory';

// NOTE: env above must take effect BEFORE the src modules load. Static ESM
// imports are hoisted and evaluate first, so the src modules are loaded
// with dynamic imports here (a static import would silently pick up the
// default GitHub backend and write test entries to the production
// seen-set file — this exact bug happened on 15 Nov 2026 and polluted
// data/seen-proofs.jsonl with trap-matrix proof_tx values).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const { createServer } = await import('../src/server.js');
const { SeenStore } = await import('../src/store.js');
const { prove, loadVk } = await import('../src/prove.js');

const dir = path.dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(fs.readFileSync(path.join(dir, 'trap-matrix.json'), 'utf8'));
const HMAC_SECRET = 'test-hmac-secret-123';
const results = [];
let failures = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function hmacHex(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function main() {
  const store = new SeenStore();
  await store.load();
  const server = createServer({ hmacSecret: HMAC_SECRET, store });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const vk = loadVk();

  try {
    // --- preflight -------------------------------------------------------
    for (const p of ['/', '/health', '/api/health']) {
      const res = await fetch(base + p);
      const body = await res.json();
      record(`GET ${p} preflight`, res.status === 200 && body.ok === true && body.protocolVersion === 'v1', JSON.stringify(body));
    }

    // --- HMAC failures ---------------------------------------------------
    const unsignedBody = JSON.stringify({ type: 'agent-games.proof-gatekeeper.v1', task_id: 'gk_noauth_001', mode: 'competition', input: matrix.cases[0].input });
    let res = await fetch(base + '/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: unsignedBody });
    record('POST unsigned -> 401', res.status === 401, `status=${res.status}`);
    res = await fetch(base + '/api/task', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-games-signature': hmacHex('wrong-secret', unsignedBody) }, body: unsignedBody });
    record('POST wrong signature -> 401', res.status === 401, `status=${res.status}`);

    // --- Mode C: unknown payload -----------------------------------------
    const garbage = JSON.stringify({ type: 'agent-games.proof-gatekeeper.v1', task_id: 'gk_unknown_001', mode: 'competition', input: { nonsense: true } });
    res = await fetch(base + '/api/task', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-games-signature': hmacHex(HMAC_SECRET, garbage) }, body: garbage });
    let body = await res.json();
    record('Mode C unknown format -> REJECT/UNKNOWN_FORMAT, no proof', res.status === 200 && body.decision === 'REJECT' && body.reason_code === 'UNKNOWN_FORMAT' && !body.proof, JSON.stringify(body));

    // --- Mode B: risk-context fallback ------------------------------------
    const modeB = JSON.stringify({
      type: 'agent-games.proof-gatekeeper.v1', task_id: 'gk_modeb_001', mode: 'competition',
      payment_request: { amount: '500', currency: 'USDC', recipient: '0xabc', memo: 'urgent gift' },
      risk_context: { amount_z_score: 4.2, recipient_age_days: 2, recipient_tx_count: 0, recipient_reputation: 0.2, velocity_1h: 7, velocity_24h: 25, unusual_hour: true, sender_country: 'ID', recipient_country: 'XX' },
    });
    res = await fetch(base + '/api/task', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-games-signature': hmacHex(HMAC_SECRET, modeB) }, body: modeB });
    body = await res.json();
    record('Mode B high-risk payload -> REJECT, no proof', res.status === 200 && body.decision === 'REJECT' && !body.proof, JSON.stringify(body));

    // --- HTTP trap cases 1-7 (in file order; case 4 depends on case 1) ----
    const proveLatencies = [];
    let firstResponseRaw = null;
    for (const c of matrix.cases.filter((x) => x.via === 'http')) {
      const envelope = { type: 'agent-games.proof-gatekeeper.v1', task_id: c.task_id, mode: 'competition', issued_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 60000).toISOString(), input: c.input };
      const raw = JSON.stringify(envelope);
      const t0 = Date.now();
      res = await fetch(base + '/api/task', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-games-signature': hmacHex(HMAC_SECRET, raw) }, body: raw });
      const ms = Date.now() - t0;
      const rawText = await res.text();
      body = JSON.parse(rawText);
      if (c.name === 'valid-approve') firstResponseRaw = rawText;

      const decisionOk = body.decision === c.expectedDecision && body.reason_code === c.expectedReason;
      let proofOk = false;
      let proofDetail = '';
      if (c.expectProof) {
        if (body.proof && body.publicSignals && body.publicSignals.length === 13) {
          try {
            proofOk = await snarkjs.groth16.verify(vk, body.publicSignals, body.proof);
            proofDetail = proofOk ? `proof verifies locally (${ms} ms)` : 'proof FAILED local verify';
          } catch (e) {
            proofDetail = `local verify threw: ${String(e).slice(0, 120)}`;
          }
        } else {
          proofDetail = 'proof/publicSignals missing from response';
        }
      } else {
        // Expected unprovable (e.g. PROOF_REUSED): the response must carry
        // the correct decision and NO proof.
        proofOk = !body.proof && !body.publicSignals;
        proofDetail = proofOk ? 'correctly no proof (unprovable trap)' : 'unexpected proof present';
      }
      // Response signature must verify against the raw response body.
      const sigOk = res.headers.get('x-agent-games-signature') === hmacHex(HMAC_SECRET, rawText);
      proveLatencies.push(ms);
      record(`trap ${c.name}: ${c.expectedDecision}/${c.expectedReason}`, res.status === 200 && decisionOk && proofOk && sigOk, `${proofDetail}; sig=${sigOk ? 'ok' : 'BAD'}; ${ms} ms`);
    }

    // --- Idempotency: re-send case 1, expect the byte-identical response --
    const dupEnvelope = { type: 'agent-games.proof-gatekeeper.v1', task_id: 'gk_valid_001', mode: 'competition', input: matrix.cases[0].input };
    const dupRaw = JSON.stringify(dupEnvelope);
    res = await fetch(base + '/api/task', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-games-signature': hmacHex(HMAC_SECRET, dupRaw) }, body: dupRaw });
    const dupText = await res.text();
    record('dedupe: same task_id returns stored response', dupText === firstResponseRaw, 'response bytes identical to first answer');

    // --- Wrong-decision variants 8-13: must FAIL to prove ----------------
    for (const c of matrix.cases.filter((x) => x.via === 'prove-direct')) {
      const t0 = Date.now();
      const pr = await prove(c.input, c.forceDecision, c.task_id);
      const ms = Date.now() - t0;
      record(`wrong-decision ${c.name} must fail to prove`, pr.ok === false, pr.ok ? 'PROVED (BAD — circuit allowed a wrong decision!)' : `failed as expected in ${ms} ms: ${String(pr.error).slice(0, 120)}`);
    }

    console.log(`\nprove latencies (HTTP cases, incl. fullProve): min ${Math.min(...proveLatencies)} ms, max ${Math.max(...proveLatencies)} ms, mean ${Math.round(proveLatencies.reduce((a, b) => a + b, 0) / proveLatencies.length)} ms`);
  } finally {
    server.close();
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS CRASHED:', e); process.exit(1); });
