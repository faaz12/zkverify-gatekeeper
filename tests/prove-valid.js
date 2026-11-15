// Proof-path smoke test (verified working 15 Nov 2026, snarkjs@0.7.5).
// Same scenario as the original CJS version, converted to ESM.
// Writes the proof to tests/proof-valid.json next to this file.
import * as snarkjs from 'snarkjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const circuits = path.join(dir, '..', 'circuits');

const t0 = Date.now();
const input = {
  registeredVkHash: BigInt('0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0').toString(),
  proofVkHash: BigInt('0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0').toString(),
  minimum: '1000',
  publicBalance: '1460',
  expiryBlock: '8430000',
  currentBlock: '8420000',
  recipient: BigInt('0xde42000000000000000000000000000000009f01').toString(),
  conditionRecipient: BigInt('0xde42000000000000000000000000000000009f01').toString(),
  amount: '500',
  maxTransfer: '1000',
  decision: '1',
  taskId: '12345',
  salt: '98765432109876543210',
};
console.log('proving valid scenario (decision=1)...');
const { proof, publicSignals } = await snarkjs.groth16.fullProve(
  input,
  path.join(circuits, 'gatekeeper.wasm'),
  path.join(circuits, 'gatekeeper_final.zkey'),
);
console.log('fullProve OK in', ((Date.now() - t0) / 1000).toFixed(1), 's');
console.log('proof bytes:', JSON.stringify(proof).length);
console.log('publicSignals (n=' + publicSignals.length + '):', JSON.stringify(publicSignals));
const vk = JSON.parse(fs.readFileSync(path.join(circuits, 'vk.json'), 'utf8'));
const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
console.log('snarkjs groth16 verify:', ok ? 'OK' : 'FAILED');
if (!ok) process.exit(1);
fs.writeFileSync(path.join(dir, 'proof-valid.json'), JSON.stringify({ proof, publicSignals }, null, 2));
console.log('wrote tests/proof-valid.json');
process.exit(0);
