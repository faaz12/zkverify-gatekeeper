// Decision logic for the Proof Gatekeeper agent (PLAN §3).
//
// Three modes, detected from the payload shape:
//   A — documented condition format (registered_vk / proof_vk / minimum /
//       public_balance / expiry_block / current_block / recipient /
//       condition_recipient / amount / max_transfer / proof_tx):
//       7 deterministic trap checks, BigInt compares, case-insensitive hex.
//   B — risk-context fallback (payment_request / risk_context): deterministic
//       0-100 risk scorer, REJECT at >= 60. No Groth16 proof exists for it.
//   C — anything else: fail closed, REJECT / UNKNOWN_FORMAT.
//
// The decision is what the circuit enforces: a correct decision always
// proves, a wrong decision fails witness generation (PLAN §1.2). The
// prove step therefore double-checks the decision logic.

const MEMO_KEYWORDS = ['urgent', 'gift', 'investment', 'crypto', 'double', 'refund', 'prize', 'winner'];

const CONDITION_FIELDS = [
  'registered_vk', 'proof_vk', 'minimum', 'public_balance',
  'expiry_block', 'current_block', 'recipient', 'condition_recipient',
  'amount', 'max_transfer', 'proof_tx',
];

function hexEq(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

// seenProofs is either a Set (tests) or the SeenStore (server) — both
// answer "have we seen this proof_tx?" via .has() / .hasProofTx().
function seenHas(seenProofs, tx) {
  if (!seenProofs) return false;
  if (typeof seenProofs.has === 'function') return seenProofs.has(tx);
  if (typeof seenProofs.hasProofTx === 'function') return seenProofs.hasProofTx(tx);
  return false;
}

function toBigInt(v) {
  // Accepts decimal strings, numbers, and 0x-prefixed hex strings.
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v.trim());
  throw new Error(`not a number: ${String(v)}`);
}

// ---------------------------------------------------------------- Mode A
function decideModeA(input, seenProofs) {
  const failures = [];
  const check = (ok, code) => { if (!ok) failures.push(code); };

  // Deterministic check order (PLAN §3.1): VK → THRESHOLD → PROOF_REUSED →
  // EXPIRED → RECIPIENT → AMOUNT. All are evaluated; the first failure is
  // reported, every failure is logged.
  check(hexEq(input.proof_vk, input.registered_vk), 'VK_SUBSTITUTION');
  check(toBigInt(input.public_balance) >= toBigInt(input.minimum), 'THRESHOLD_MISMATCH');
  check(!seenHas(seenProofs, String(input.proof_tx).toLowerCase()), 'PROOF_REUSED');
  check(toBigInt(input.current_block) <= toBigInt(input.expiry_block), 'EXPIRED_CONDITION');
  check(hexEq(input.recipient, input.condition_recipient), 'RECIPIENT_MISMATCH');
  check(toBigInt(input.amount) <= toBigInt(input.max_transfer), 'AMOUNT_OVERFLOW');

  if (failures.length === 0) {
    return { mode: 'A', decision: 'APPROVE', reason_code: 'VALID_CONDITION', failures, input };
  }
  return { mode: 'A', decision: 'REJECT', reason_code: failures[0], failures, input };
}

// ---------------------------------------------------------------- Mode B
function decideModeB(envelope) {
  const rc = envelope.risk_context || {};
  const pr = envelope.payment_request || {};
  let score = 0;
  const reasons = [];
  const add = (n, code) => { score += n; reasons.push(code); };

  const z = Number(rc.amount_z_score);
  if (!Number.isNaN(z)) {
    if (z > 3) add(35, 'HIGH_AMOUNT_ZSCORE');
    else if (z > 2) add(20, 'HIGH_AMOUNT_ZSCORE');
  }
  const age = Number(rc.recipient_age_days);
  if (!Number.isNaN(age)) {
    if (age < 7) add(25, 'NEW_RECIPIENT');
    else if (age < 30) add(12, 'NEW_RECIPIENT');
  }
  const txCount = Number(rc.recipient_tx_count);
  if (!Number.isNaN(txCount)) {
    if (txCount === 0) add(20, 'NEW_RECIPIENT');
    else if (txCount < 5) add(10, 'NEW_RECIPIENT');
  }
  const rep = Number(rc.recipient_reputation);
  if (!Number.isNaN(rep)) {
    if (rep < 0.3) add(25, 'LOW_REPUTATION');
    else if (rep < 0.5) add(12, 'LOW_REPUTATION');
  }
  if (Number(rc.velocity_1h) >= 5) add(15, 'VELOCITY_SPIKE');
  if (Number(rc.velocity_24h) >= 20) add(15, 'VELOCITY_SPIKE');
  if (rc.unusual_hour === true) add(8, 'UNUSUAL_HOUR');
  const memo = String(pr.memo || rc.memo || '').toLowerCase();
  if (MEMO_KEYWORDS.some((k) => memo.includes(k))) add(12, 'SUSPICIOUS_MEMO');
  if (rc.sender_country && rc.recipient_country && rc.sender_country !== rc.recipient_country) add(8, 'CROSS_BORDER');

  score = Math.min(100, score);
  const confidence = Math.min(0.95, Math.max(0.05, 1 - Math.abs(score - 60) / 60));
  const decision = score >= 60 ? 'REJECT' : 'APPROVE';
  return {
    mode: 'B',
    decision,
    reason_code: decision === 'REJECT' ? (reasons[0] || 'HIGH_RISK') : 'OK',
    failures: reasons,
    riskScore: score,
    confidence,
    input: envelope,
  };
}

// ---------------------------------------------------------------- dispatch
export function decide(envelope, seenProofs) {
  const input = envelope && typeof envelope === 'object' ? envelope.input : undefined;
  if (input && typeof input === 'object' && CONDITION_FIELDS.every((f) => input[f] !== undefined && input[f] !== null && input[f] !== '')) {
    try {
      return decideModeA(input, seenProofs);
    } catch (e) {
      // A field that cannot be compared (e.g. unparseable number) is not a
      // valid condition payload — fail closed instead of crashing.
      return { mode: 'C', decision: 'REJECT', reason_code: 'UNKNOWN_FORMAT', failures: [`PARSE_ERROR:${e.message}`], input: envelope };
    }
  }
  if (envelope && typeof envelope === 'object' && (envelope.payment_request || envelope.risk_context)) {
    return decideModeB(envelope);
  }
  return { mode: 'C', decision: 'REJECT', reason_code: 'UNKNOWN_FORMAT', failures: ['UNKNOWN_FORMAT'], input: envelope };
}
