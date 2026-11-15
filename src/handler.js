// Shared task-handling flow (PLAN §8 step 2), used by both the local
// plain-Node server (scripts/local-server.js) and the Vercel entry (api/task.js).
//
// Flow:
//   1. raw body -> verify HMAC -> 401 if bad (no work, no seen-set poison)
//   2. parse JSON
//   3. dedupe by task_id -> return the stored response if already answered
//   4. decide (Mode A / B / C)
//   5. prove (Mode A only, ~10 s budget, local verify) — on ANY proof
//      failure, still return the decision WITHOUT the proof. Never let
//      proving block the decision past the 60 s platform deadline.
//   6. respond {decision, reason_code, proof_tx, proof?, publicSignals?}
//      signed with x-agent-games-signature
//   7. record proof_tx in the seen-set (after the decision; the remote
//      append runs in the background and never blocks the response)
import { verifyHmac, signHmac } from './hmac.js';
import { decide } from './decide.js';
import { prove } from './prove.js';

export const PREFLIGHT = { ok: true, protocolVersion: 'v1' };

function log(msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'handler', msg, ...extra }));
}

export function createHandler({ hmacSecret, store }) {
  if (!hmacSecret) {
    throw new Error('HMAC_SECRET is not set — refusing to start (fail closed)');
  }

  async function handleTask(rawBody, headers) {
    const signature = headers['x-agent-games-signature'] || headers['X-Agent-Games-Signature'];
    if (!verifyHmac(hmacSecret, rawBody, signature)) {
      log('hmac verification failed', { signaturePresent: Boolean(signature) });
      return { status: 401, body: { error: 'invalid signature' } };
    }

    let envelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8'));
    } catch {
      log('invalid JSON body');
      return { status: 400, body: { error: 'invalid JSON' } };
    }

    const taskId = envelope.task_id || envelope.taskId;
    if (!taskId) {
      log('missing task_id');
      return { status: 400, body: { error: 'missing task_id' } };
    }

    // Idempotency: the platform may retry after a network failure. Return
    // the exact stored response; do not re-decide and do not re-prove.
    const stored = store.getResponse(String(taskId));
    if (stored) {
      log('duplicate task_id, returning stored response', { taskId });
      return { status: 200, body: stored, signature: signHmac(hmacSecret, Buffer.from(JSON.stringify(stored))) };
    }

    const t0 = Date.now();
    const result = decide(envelope, store);
    log('decision', {
      taskId, mode: result.mode, decision: result.decision,
      reason_code: result.reason_code, failures: result.failures,
      decideMs: Date.now() - t0,
    });

    const response = {
      decision: result.decision,
      reason_code: result.reason_code,
      proof_tx: result.input?.input?.proof_tx || result.input?.proof_tx || envelope?.input?.proof_tx || null,
    };

    // Prove in Mode A only. The circuit asserts decision correctness, so a
    // correct decision always proves; a proof failure here means either a
    // decision-logic bug or a proving problem — log it loudly, but the
    // decision still goes out (correct decision without proof scores
    // +12 -2 = +10; a timeout scores -2).
    if (result.mode === 'A') {
      const pr = await prove(result.input, result.decision, taskId);
      if (pr.ok) {
        response.proof = pr.proof;
        response.publicSignals = pr.publicSignals;
        log('proof generated + locally verified', { taskId, proveMs: pr.proveMs });
      } else {
        log('WARNING: proof not generated, returning decision without proof', { taskId, error: pr.error });
      }
    } else {
      log('no proof for this mode', { taskId, mode: result.mode });
    }

    // Record BEFORE responding. The seen-set write must be durable before
    // the response goes out: Vercel freezes a function right after it
    // responds, so a fire-and-forget append can be killed mid-retry (and a
    // lost write means a reused proof_tx is not caught next time). The
    // write takes ~1s and retries are bounded, far inside the 60s deadline.
    if (response.proof_tx) {
      await store.record(String(taskId), response.proof_tx, response).catch(() => {});
    }

    const bodyStr = JSON.stringify(response);
    return { status: 200, body: response, signature: signHmac(hmacSecret, Buffer.from(bodyStr)) };
  }

  return { handleTask };
}
