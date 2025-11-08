// WebDollar-Future — 1M TPS prototype (simulation with stubs)
// Requirements: Node.js >= 18

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const crypto = require('crypto');

const TARGET_TPS = 1_000_000;     // target throughput
const BATCH_SIZE = 20_000;        // batch size per dispatch
const DISPATCHES_PER_SEC = Math.ceil(TARGET_TPS / BATCH_SIZE); // per second
const WORKERS = Math.max(4, Math.min(os.cpus().length, 16));   // worker pool size

// --- Worker code (as string) ---
const WORKER_CODE = `
const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

// Stub: "GPU" parallel verifications
function verifyBatch(messages) {
  // Simulate vectorized checks (very fast, no real crypto)
  return messages.map(() => true);
}

// Stub: apply transactions in memory
function applyBatch(state, txs) {
  // No conflicts; high-throughput apply
  state.count += txs.length;
  return { applied: txs.length, conflicts: 0 };
}

parentPort.on('message', ({ batchId, txs }) => {
  const msgs = txs.map(t => t.message);
  const ok = verifyBatch(msgs);
  // Filter invalid (none, in stub)
  const valid = txs; // ok.every(true)
  const res = applyBatch(workerData.state, valid);
  parentPort.postMessage({ batchId, processed: res.applied });
});
`;

// --- Worker pool ---
class WorkerPool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.busy = new Set();
    this.processed = 0;

    for (let i = 0; i < size; i++) {
      const w = new Worker(WORKER_CODE, { eval: true, workerData: { state: { count: 0 } } });
      w.on('message', ({ batchId, processed }) => {
        this.busy.delete(w);
        this.processed += processed;
        // next task if available
        if (this.queue.length) {
          const next = this.queue.shift();
          this.dispatch(w, next);
        }
      });
      w.on('error', (e) => {
        console.error('Worker error:', e.message);
        this.busy.delete(w);
      });
      this.workers.push(w);
    }
  }

  dispatch(worker, task) {
    this.busy.add(worker);
    worker.postMessage(task);
  }

  submit(task) {
    // find an idle worker
    const idle = this.workers.find(w => !this.busy.has(w));
    if (idle) this.dispatch(idle, task);
    else this.queue.push(task);
  }

  shutdown() {
    return Promise.all(this.workers.map(w => w.terminate()));
  }
}

// --- High-throughput generator ---
function generateBatch(count, shardId) {
  const txs = new Array(count);
  for (let i = 0; i < count; i++) {
    // Minimal payload to keep costs tiny
    txs[i] = {
      message: `tx-${shardId}-${Date.now()}-${i}`,
      signature: 'stub',
      pubKey: 'stub',
      nonce: i,
      account: { nonce: 0, balance: 10_000 },
      amount: 0.001,
      fee: 0.00001,
      targetShard: shardId
    };
  }
  return txs;
}

// --- Orchestrator: aims for 1M TPS ---
class MillionTPS {
  constructor({ pool, batchSize, dispatchesPerSec, shards = 8 }) {
    this.pool = pool;
    this.batchSize = batchSize;
    this.dispatchesPerSec = dispatchesPerSec;
    this.shards = shards;
    this.batchId = 0;
    this.tpsWindow = { last: Date.now(), processed: 0 };
  }

  start() {
    // schedule at ~1000ms cadence split into micro-slots
    const slots = Math.max(10, Math.min(100, this.dispatchesPerSec));
    const perSlot = Math.ceil(this.dispatchesPerSec / slots);
    const slotIntervalMs = Math.floor(1000 / slots);

    const timer = setInterval(() => {
      for (let s = 0; s < perSlot; s++) {
        for (let shard = 0; shard < this.shards; shard++) {
          this.pool.submit({
            batchId: this.batchId++,
            txs: generateBatch(this.batchSize, `s-${shard}`)
          });
        }
      }
      this.report();
    }, slotIntervalMs);

    // graceful stop after 10 seconds demo
    setTimeout(async () => {
      clearInterval(timer);
      await this.pool.shutdown();
      this.report(true);
      console.log('Demo finished.');
    }, 10_000);
  }

  report(final = false) {
    const now = Date.now();
    const elapsed = now - this.tpsWindow.last;
    const processed = this.pool.processed - this.tpsWindow.processed;
    if (elapsed >= 1000 || final) {
      const tps = Math.floor((processed / elapsed) * 1000);
      console.log(`[Metrics] TPS=${tps.toLocaleString()} | queue=${this.pool.queue.length} | workers_busy=${this.pool.busy.size}`);
      this.tpsWindow.last = now;
      this.tpsWindow.processed = this.pool.processed;
    }
  }
}

// --- Run demo ---
if (isMainThread) {
  console.log('Starting 1M TPS simulation (stubs, worker threads)...');
  const pool = new WorkerPool(WORKERS);
  const system = new MillionTPS({
    pool,
    batchSize: BATCH_SIZE,
    dispatchesPerSec: DISPATCHES_PER_SEC,
    shards: 8
  });
  system.start();
}
