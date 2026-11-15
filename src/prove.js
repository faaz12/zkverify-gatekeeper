// Groth16 proof generation for the gatekeeper circuit (PLAN §1.2–1.3).
//
// HARD RULES (learned from the verified local test):
//  1. VALIDATE every circuit input BEFORE calling fullProve — fullProve
//     with missing/incomplete inputs HANGS INDEFINITELY instead of erroring.
//  2. Never let proving block the decision past the 60 s platform
//     deadline — prove with a ~10 s internal budget, then answer anyway.
//  3. Always groth16.verify locally before including a proof in a
//     response — never send a proof that does not verify locally.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

export const PROVE_TIMEOUT_MS = Number(process.env.PROVE_TIMEOUT_MS || 10000);

// BN254 field prime (used only to sanity-bound the random salt).
const FIELD_PRIME = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');

function resolveCircuitDir() {
  const fromModule = path.dirname(fileURLToPath(new URL('../circuits/', import.meta.url)));
  if (fs.existsSync(path.join(fromModule, 'gatekeeper.wasm'))) return fromModule;
  const fromCwd = path.join(process.cwd(), 'circuits');
  if (fs.existsSync(path.join(fromCwd, 'gatekeeper.wasm'))) return fromCwd;
  return fromModule; // let the file read fail loudly with the module path
}

export const CIRCUIT_DIR = resolveCircuitDir();
const WASM_PATH = path.join(CIRCUIT_DIR, 'gatekeeper.wasm');
const ZKEY_PATH = path.join(CIRCUIT_DIR, 'gatekeeper_final.zkey');
const VK_PATH = path.join(CIRCUIT_DIR, 'vk.json');

let vkCache = null;
export function loadVk() {
  if (!vkCache) vkCache = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));
  return vkCache;
}

// taskId encoding — PLAN §9.1, RISK #1 (unverified against the platform).
// The platform recomputes the expected public signals from the task; if our
// encoding differs from theirs, the proof will not match. Candidates:
//   (a) decimal of the string's UTF-8 bytes as a big integer  <- USED HERE
//   (b) keccak256(string) as a field element
//   (c) numeric suffix of e.g. "gk_24_9d1"
//   (d) Poseidon hash
// Purely numeric taskIds (e.g. the "12345" used in the verified local test)
// pass through unchanged. Resolve the real encoding in practice mode.
export function encodeTaskId(taskId) {
  const s = String(taskId);
  if (/^\d+$/.test(s)) return s;
  return BigInt('0x' + Buffer.from(s, 'utf8').toString('hex')).toString();
}

function hexToDecimal(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`field ${field}: expected 0x hex string, got ${JSON.stringify(value)}`);
  }
  return BigInt(value).toString();
}

function numToDecimal(value, field) {
  try {
    return BigInt(typeof value === 'string' ? value.trim() : value).toString();
  } catch {
    throw new Error(`field ${field}: expected a number, got ${JSON.stringify(value)}`);
  }
}

// Build the 13-field circuit input. Throws on ANY missing / malformed
// field — callers must catch and treat it as "cannot prove", never as a
// reason to hang or to change the decision.
export function buildCircuitInput(input, decision, taskId) {
  const required = [
    'registered_vk', 'proof_vk', 'minimum', 'public_balance',
    'expiry_block', 'current_block', 'recipient', 'condition_recipient',
    'amount', 'max_transfer',
  ];
  for (const f of required) {
    if (input[f] === undefined || input[f] === null || input[f] === '') {
      throw new Error(`missing circuit input field: ${f}`);
    }
  }
  if (taskId === undefined || taskId === null || taskId === '') {
    throw new Error('missing circuit input field: taskId');
  }
  if (decision !== 'APPROVE' && decision !== 'REJECT') {
    throw new Error(`decision must be APPROVE or REJECT, got ${JSON.stringify(decision)}`);
  }
  return {
    registeredVkHash: hexToDecimal(input.registered_vk, 'registered_vk'),
    proofVkHash: hexToDecimal(input.proof_vk, 'proof_vk'),
    minimum: numToDecimal(input.minimum, 'minimum'),
    publicBalance: numToDecimal(input.public_balance, 'public_balance'),
    expiryBlock: numToDecimal(input.expiry_block, 'expiry_block'),
    currentBlock: numToDecimal(input.current_block, 'current_block'),
    recipient: hexToDecimal(input.recipient, 'recipient'),
    conditionRecipient: hexToDecimal(input.condition_recipient, 'condition_recipient'),
    amount: numToDecimal(input.amount, 'amount'),
    maxTransfer: numToDecimal(input.max_transfer, 'max_transfer'),
    decision: decision === 'APPROVE' ? '1' : '0',
    taskId: encodeTaskId(taskId),
    // Private, arbitrary per-proof randomness (160-bit, far below the field
    // prime). The platform cannot recompute anything involving it.
    salt: (BigInt('0x' + crypto.randomBytes(20).toString('hex')) % FIELD_PRIME).toString(),
  };
}

// Prove with an internal time budget. Returns:
//   { ok: true, proof, publicSignals, proveMs }
//   { ok: false, error }   (validation failure, timeout, witness assert, or
//                            local verify failure — the caller must still
//                            return the decision WITHOUT the proof)
export async function prove(input, decision, taskId, timeoutMs = PROVE_TIMEOUT_MS) {
  let circuitInput;
  try {
    circuitInput = buildCircuitInput(input, decision, taskId);
  } catch (e) {
    return { ok: false, error: `input validation: ${e.message}` };
  }

  const t0 = Date.now();
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  // NOTE: if fullProve hangs (the known incomplete-input quirk), the race
  // below still resolves on timeout, but the hung promise keeps the event
  // loop busy in the background. Validation above makes that path
  // unreachable for well-formed inputs; the timeout is a safety net.
  const work = snarkjs.groth16.fullProve(circuitInput, WASM_PATH, ZKEY_PATH)
    .then((r) => ({ ...r, timedOut: false }))
    .catch((e) => ({ error: e }));
  const result = await Promise.race([work, timeout]);
  clearTimeout(timeoutId);

  if (result.timedOut) return { ok: false, error: `prove timed out after ${timeoutMs} ms` };
  if (result.error) return { ok: false, error: `fullProve failed: ${String(result.error).slice(0, 300)}` };

  const { proof, publicSignals } = result;
  let verified = false;
  try {
    verified = await snarkjs.groth16.verify(loadVk(), publicSignals, proof);
  } catch (e) {
    return { ok: false, error: `local verify threw: ${String(e).slice(0, 200)}` };
  }
  if (!verified) return { ok: false, error: 'local groth16.verify returned false' };
  return { ok: true, proof, publicSignals, proveMs: Date.now() - t0 };
}
