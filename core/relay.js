'use strict';
/**
 * relay.js — asynchronous job queue.
 *
 * - Non-blocking: enqueue() returns immediately; the UI polls for status.
 * - Concurrency-limited worker pool.
 * - Shortest-job-first with aging: cheap `low` jobs are not stuck behind a
 *   `very_high` job, but old jobs gradually gain priority so nothing starves.
 */
const crypto = require('crypto');

const WEIGHT = { low: 1, medium: 2, high: 4, very_high: 6 };
const AGE_BONUS_PER_SEC = 120; // ms of priority gained per second of waiting

class Relay {
  /**
   * @param {{concurrency?:number, keep?:number, worker:(job:object,onStage:Function)=>Promise<object>}} opts
   */
  constructor({ concurrency = 2, keep = 400, worker }) {
    this.concurrency = concurrency;
    this.keep = keep;
    this.worker = worker;
    this.jobs = new Map();
    this.waiting = [];
    this.active = 0;
  }

  /** @param {{prompt:string, modelId:string, effort:string, engine?:object|null, owner?:string}} p */
  enqueue({ prompt, modelId, effort, engine = null, owner = '' }) {
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      prompt,
      modelId,
      effort,
      engine, // user's api key lives here, in memory only, and is wiped when the job ends
      owner,
      status: 'queued',
      stage: 'Queued',
      progress: 0,
      result: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null
    };
    this.jobs.set(job.id, job);
    this.waiting.push(job);
    this._prune();
    setImmediate(() => this._pump());
    return this.view(job);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return false;
    this.waiting = this.waiting.filter((j) => j !== job);
    job.engine = null;
    job.status = 'error';
    job.error = 'Cancelled';
    job.finishedAt = Date.now();
    return true;
  }

  /** jobs that are queued or running for one owner (used for a per-ip cap) */
  openCount(owner) {
    let n = 0;
    for (const j of this.jobs.values()) if (j.owner === owner && (j.status === 'queued' || j.status === 'running')) n++;
    return n;
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? this.view(job) : null;
  }

  many(ids) {
    return ids.map((id) => this.get(id)).filter(Boolean);
  }

  view(job) {
    const out = {
      id: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      effort: job.effort,
      modelId: job.modelId,
      position: job.status === 'queued' ? this._position(job) : 0,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      error: job.error
    };
    if (job.result) {
      out.result = job.result.compiled;
      out.engine = job.result.engine;
      out.info = job.result.info;
    }
    return out;
  }

  _score(job, now) {
    return WEIGHT[job.effort] * 8000 - ((now - job.createdAt) / 1000) * AGE_BONUS_PER_SEC;
  }

  _ordered() {
    const now = Date.now();
    return [...this.waiting].sort((a, b) => this._score(a, now) - this._score(b, now));
  }

  _position(job) {
    return this._ordered().indexOf(job) + 1;
  }

  _pump() {
    while (this.active < this.concurrency && this.waiting.length) {
      const job = this._ordered()[0];
      this.waiting = this.waiting.filter((j) => j !== job);
      this._run(job);
    }
  }

  async _run(job) {
    this.active++;
    job.status = 'running';
    job.startedAt = Date.now();
    try {
      job.result = await this.worker(job, (stage, index, total) => {
        job.stage = stage;
        job.progress = total ? Math.min(0.98, index / total) : 0;
      });
      job.status = 'done';
      job.stage = 'Done';
      job.progress = 1;
    } catch (err) {
      job.status = 'error';
      job.error = err && err.message ? err.message : String(err);
    } finally {
      job.engine = null; // never keep a user's key longer than the job
      job.finishedAt = Date.now();
      this.active--;
      setImmediate(() => this._pump());
    }
  }

  _prune() {
    if (this.jobs.size <= this.keep) return;
    const finished = [...this.jobs.values()]
      .filter((j) => j.status === 'done' || j.status === 'error')
      .sort((a, b) => a.finishedAt - b.finishedAt);
    while (this.jobs.size > this.keep && finished.length) this.jobs.delete(finished.shift().id);
  }
}

module.exports = { Relay, WEIGHT };
