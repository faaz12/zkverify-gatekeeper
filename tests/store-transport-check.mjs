// One-off validation of the GitHub-file seen-set transport (store.js).
// Uses a throwaway file (STORE_FILE) so the production seen-set is untouched.
// Steps: load empty -> record one entry -> fresh store loads it back -> delete file.
// NOTE: env must be set BEFORE the store module loads. Static ESM imports
// are hoisted and evaluate first, so use a dynamic import here.
process.env.STORE_BACKEND = 'github';
process.env.STORE_FILE = 'data/seen-proofs-test.jsonl';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const { SeenStore } = await import('../src/store.js');

const execFileAsync = promisify(execFile);

const store = new SeenStore();
await store.load();
console.log('load 1: proofTxs =', store.proofTxs.size, '| persisted =', store.persisted);
if (store.proofTxs.size !== 0) throw new Error('expected empty seen-set on first load');

const resp = { decision: 'APPROVE', reason_code: 'VALID_CONDITION', proof_tx: '0xtest0001' };
await store.record('gk_store_test_001', '0xtest0001', resp);
console.log('recorded test entry, remote append returned');

const store2 = new SeenStore();
await store2.load();
console.log('load 2: proofTxs =', store2.proofTxs.size, '| hasProofTx =', store2.hasProofTx('0xTEST0001'), '| getResponse =', JSON.stringify(store2.getResponse('gk_store_test_001')));
if (!store2.hasProofTx('0xtest0001')) throw new Error('fresh store did NOT see the recorded proof_tx');
if (store2.getResponse('gk_store_test_001')?.decision !== 'APPROVE') throw new Error('fresh store did NOT see the recorded response');

// Clean up the throwaway file.
const { stdout } = await execFileAsync('gh', ['api', 'repos/faaz12/zkverify-gatekeeper/contents/data/seen-proofs-test.jsonl', '--jq', '.sha']);
const sha = stdout.trim();
await execFileAsync('gh', ['api', 'repos/faaz12/zkverify-gatekeeper/contents/data/seen-proofs-test.jsonl', '--method', 'DELETE', '-f', 'message=remove seen-set transport test file', '-f', `sha=${sha}`, '-f', 'branch=main']);
console.log('test file deleted');
console.log('STORE TRANSPORT: OK');
process.exit(0);
