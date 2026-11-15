// Seen-set persistence (PLAN §5.4).
//
// PROOF_REUSED detection needs the set of answered proof_tx values to
// survive restarts and (on Vercel) cold starts, so it is persisted as one
// JSON line per answered task in a file in the agent repo:
//
//   data/seen-proofs.jsonl   (default; override with STORE_FILE)
//
// Transports, in order:
//   1. GITHUB_TOKEN env var  -> GitHub REST API via fetch (Vercel path)
//   2. `gh` CLI auth         -> `gh api` (local dev path, faaz12)
//   3. neither               -> in-memory only, with a warning logged
//
// A task that fails HMAC verification must NOT poison the set: appends only
// happen from the task handler AFTER verification, never before. Appends are
// serialised through a promise chain so concurrent tasks cannot clobber the
// read-modify-write cycle within one process (cross-instance races on
// Vercel remain possible at this volume — ≤ 8 tasks/round — and are logged).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO = process.env.STORE_REPO || 'faaz12/zkverify-gatekeeper';
const FILE = process.env.STORE_FILE || 'data/seen-proofs.jsonl';
const BACKEND = process.env.STORE_BACKEND || 'github'; // 'github' | 'memory'
const BRANCH = process.env.STORE_BRANCH || 'main';

function log(msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'store', msg, ...extra }));
}

async function ghCli(args) {
  const { stdout } = await execFileAsync('gh', args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function ghApiFetch(method, path, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'zkverify-gatekeeper',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const err = new Error(`GitHub API ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Returns { content (utf8 string), sha } or null if the file does not exist.
async function readFile() {
  if (process.env.GITHUB_TOKEN) {
    try {
      const data = await ghApiFetch('GET', `/repos/${REPO}/contents/${FILE}?ref=${BRANCH}`);
      return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
  try {
    const out = await ghCli(['api', `repos/${REPO}/contents/${FILE}`, '--jq', '{content: .content, sha: .sha}']);
    const data = JSON.parse(out);
    return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
  } catch (e) {
    if (/404|Not Found/i.test(e.message || String(e.stderr || ''))) return null;
    throw e;
  }
}

async function writeFile(content, sha) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  if (process.env.GITHUB_TOKEN) {
    await ghApiFetch('PUT', `/repos/${REPO}/contents/${FILE}`, {
      message: `seen-set: append proof_tx (${new Date().toISOString()})`,
      content: b64,
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    });
    return;
  }
  const args = ['api', `repos/${REPO}/contents/${FILE}`, '--method', 'PUT',
    '-f', `message=seen-set: append proof_tx (${new Date().toISOString()})`,
    '-f', `content=${b64}`, '-f', `branch=${BRANCH}`];
  if (sha) args.push('-f', `sha=${sha}`);
  await ghCli(args);
}

export class SeenStore {
  constructor() {
    this.proofTxs = new Set(); // lowercased proof_tx
    this.responses = new Map(); // task_id -> stored response object
    this.loaded = false;
    this.persisted = false;
    this._queue = Promise.resolve();
  }

  async load() {
    if (BACKEND === 'memory') {
      log('backend=memory (STORE_BACKEND=memory), no remote persistence');
      this.loaded = true;
      return;
    }
    try {
      const file = await readFile();
      if (!file) {
        log('no remote seen-set file yet, starting empty', { repo: REPO, file: FILE });
      } else {
        let n = 0;
        for (const line of file.content.split('\n')) {
          const l = line.trim();
          if (!l) continue;
          try {
            const e = JSON.parse(l);
            if (e.proof_tx) this.proofTxs.add(String(e.proof_tx).toLowerCase());
            if (e.task_id && e.response) this.responses.set(e.task_id, e.response);
            n++;
          } catch { /* skip a corrupt line, keep the rest */ }
        }
        log('loaded remote seen-set', { entries: n, proofTxs: this.proofTxs.size, responses: this.responses.size });
      }
      this.persisted = true;
    } catch (e) {
      log('WARNING: could not load remote seen-set, continuing in-memory only', { error: String(e).slice(0, 200) });
    }
    this.loaded = true;
  }

  hasProofTx(proofTx) {
    return this.proofTxs.has(String(proofTx).toLowerCase());
  }

  getResponse(taskId) {
    return this.responses.get(taskId);
  }

  // Record an answered task. Must be called ONLY after HMAC verification.
  // Updates memory immediately; the remote append is queued and awaited by
  // the caller only if it wants durability before responding (the handler
  // does not block the response on it — see handler.js).
  record(taskId, proofTx, response) {
    if (proofTx) this.proofTxs.add(String(proofTx).toLowerCase());
    this.responses.set(taskId, response);
    if (BACKEND === 'memory' || !this.persisted) return Promise.resolve(false);
    const line = JSON.stringify({
      task_id: taskId,
      proof_tx: proofTx || null,
      decision: response.decision,
      reason_code: response.reason_code,
      response,
      ts: new Date().toISOString(),
    });
    this._queue = this._queue.then(async () => {
      // Retry the read-modify-write on a sha conflict (409): two Vercel
      // instances can write concurrently, and the second PUT fails on a
      // stale sha. Re-read fresh and try again (max 3 attempts).
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const file = await readFile();
          const next = (file ? file.content.replace(/\n$/, '') + '\n' : '') + line + '\n';
          await writeFile(next, file ? file.sha : undefined);
          return true;
        } catch (e) {
          const conflict = e.status === 409 || /409|sha|conflict/i.test(String(e.message || ''));
          if (conflict && attempt < 2) continue;
          log('WARNING: remote seen-set append failed (in-memory copy kept)', { error: String(e).slice(0, 200) });
          return false;
        }
      }
      return false;
    });
    return this._queue;
  }
}
