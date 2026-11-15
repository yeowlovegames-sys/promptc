'use strict';
/** selftest.js — offline checks for the compiler, queue, theme generator, diff and css sandbox. node tools/selftest.js */
const assert = require('assert');
const dock = require('../core/dock');
const forge = require('../core/forge');
const prism = require('../core/prism');
const { Relay } = require('../core/relay');
const Delta = require('../ui/js/delta.js');
const Sandbox = require('../ui/js/sandbox.js');

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

(async () => {
  const grid = dock.readJson(dock.p('registry', 'grid.json'));
  const rough = 'write a python script that renames my photos by date';
  const withData = 'summarize this in 3 bullets for executives\n\nThe quarterly report shows revenue grew 12% to $4.1M driven by subscriptions while churn increased to 5.2 percent. Management expects margin pressure in Q4 because of hiring.';

  await test('every model x effort compiles', async () => {
    for (const m of grid.models) for (const e of Object.keys(forge.LEVELS)) {
      const r = await forge.compile({ prompt: rough, model: m, effort: e });
      assert(r.compiled.length > 40, `${m.id}/${e} empty`);
    }
  });

  await test('stage count matches labels for every effort', async () => {
    const model = grid.models[0];
    for (const e of Object.keys(forge.LEVELS)) {
      const seen = [];
      await forge.compile({ prompt: rough, model, effort: e, onStage: (l) => seen.push(l) });
      assert.deepStrictEqual(seen, forge.stageLabels(e, model), e);
    }
  });

  await test('more effort => longer prompt', async () => {
    const model = grid.models[0];
    const len = [];
    for (const e of ['low', 'medium', 'high', 'very_high']) len.push((await forge.compile({ prompt: rough, model, effort: e })).compiled.length);
    assert(len[0] < len[1] && len[1] < len[2] && len[2] < len[3], len.join(' < '));
  });

  await test('anthropic: data first, instructions last, balanced xml', async () => {
    const m = grid.models.find((x) => x.family === 'anthropic');
    const { compiled } = await forge.compile({ prompt: withData, model: m, effort: 'very_high' });
    assert(compiled.indexOf('<documents>') < compiled.indexOf('<role>'));
    assert(compiled.trimEnd().endsWith('</instructions>'));
    assert(compiled.includes('revenue grew 12%'));
  });

  await test('google: persona first, constraints early, data last', async () => {
    const m = grid.models.find((x) => x.family === 'google');
    const { compiled } = await forge.compile({ prompt: withData, model: m, effort: 'high' });
    assert(compiled.startsWith('### Persona'));
    assert(compiled.indexOf('### Non-Negotiable Constraints') < compiled.indexOf('### Task'));
    assert(compiled.indexOf('### Examples') < compiled.indexOf('### Input Data'));
    assert(compiled.indexOf('### Input Data') > compiled.length / 2);
  });

  await test('google: very high has two few-shot examples', async () => {
    const m = grid.models.find((x) => x.family === 'google');
    const { compiled } = await forge.compile({ prompt: rough, model: m, effort: 'very_high' });
    assert(compiled.includes('**Example 1**') && compiled.includes('**Example 2**'));
  });

  await test('openai: numbered steps, delimiters, negatives, schema', async () => {
    const m = grid.models.find((x) => x.family === 'openai');
    const { compiled } = await forge.compile({ prompt: rough, model: m, effort: 'high' });
    for (const s of ['### EXECUTION STEPS ###', '1. ', '2. ', '### DO NOT ###', '### OUTPUT SCHEMA ###']) assert(compiled.includes(s), s);
  });

  await test('signals: length/tone/audience become constraints', async () => {
    const m = grid.models.find((x) => x.family === 'open');
    const { compiled } = await forge.compile({ prompt: 'write a friendly email for managers in 120 words', model: m, effort: 'low' });
    assert(/Length: 120 words/.test(compiled) && /Tone: friendly/.test(compiled) && /Audience: managers/.test(compiled));
  });

  await test('extraction tasks get a json schema', async () => {
    const m = grid.models.find((x) => x.family === 'openai');
    const { compiled, info } = await forge.compile({ prompt: 'extract the names and dates from this text into json', model: m, effort: 'very_high' });
    assert.strictEqual(info.type, 'extract');
    assert(compiled.includes('"evidence"'));
  });

  await test('empty and oversized prompts are rejected', async () => {
    const m = grid.models[0];
    await assert.rejects(() => forge.compile({ prompt: '   ', model: m, effort: 'low' }), /empty/);
    await assert.rejects(() => forge.compile({ prompt: 'x'.repeat(forge.MAX_INPUT + 1), model: m, effort: 'low' }), /too long/);
  });

  await test('relay: quick jobs overtake heavy ones; failures are isolated', async () => {
    const order = [];
    const relay = new Relay({ concurrency: 1, worker: async (job) => { order.push(job.effort); if (job.prompt === 'boom') throw new Error('boom'); return { compiled: 'x', engine: 'test', info: {} }; } });
    relay.enqueue({ prompt: 'a', modelId: 'm', effort: 'very_high' });
    relay.enqueue({ prompt: 'boom', modelId: 'm', effort: 'high' });
    const last = relay.enqueue({ prompt: 'c', modelId: 'm', effort: 'low' });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepStrictEqual(order, ['low', 'high', 'very_high']);
    assert.strictEqual(relay.get(last.id).status, 'done');
    assert.strictEqual(relay.many([...relay.jobs.keys()]).filter((j) => j.status === 'error').length, 1);
  });

  await test('prism: local themes only contain whitelisted, safe values', async () => {
    for (const v of ['neon cyber terminal', 'paper minimal', 'calm forest glass', 'zzz qqq']) {
      const t = await prism.generate(v);
      assert(Object.keys(t.vars).length >= 20, v);
      assert.deepStrictEqual(prism.cleanVars(t.vars), t.vars, v);
    }
    assert.strictEqual((await prism.generate('paper minimal')).mode, 'light');
    assert.deepStrictEqual(prism.cleanVars({ '--bg': 'url(http://evil)', '--text': 'red; } body{display:none', '--accent': 'hsl(10 50% 50%)', '--nope': 'red' }), { '--accent': 'hsl(10 50% 50%)' });
  });

  await test('delta: word diff keeps original words and marks additions', () => {
    const ops = Delta.diff('fix my code', 'Please fix my broken code now');
    assert.strictEqual(ops.filter((o) => o.t === 'del').length, 0);
    assert(ops.some((o) => o.t === 'add' && /broken/.test(o.v)));
    assert.strictEqual(ops.filter((o) => o.t !== 'add').map((o) => o.v).join(''), 'fix my code');
    assert.strictEqual(Delta.diff('a b', 'a c').filter((o) => o.t === 'del')[0].v, 'b');
  });

  await test('sandbox: blocks url/import/escapes and brace break-outs', () => {
    const bad = [
      '@import "https://evil.test/x.css"; .a{color:red}',
      '.a{background:url(https://evil.test/p.png)}',
      '.a{background:u/**/rl(https://evil.test/p.png)}',
      '.a{background:\\75rl(https://evil.test/p.png)}',
      '.a{background:image-set("https://evil.test/p.png" 1x)}',
      '.a{width:expression(alert(1))}'
    ];
    for (const css of bad) {
      const r = Sandbox.sanitize(css);
      assert(!/url\(|@import|image-set\(|expression\(/i.test(r.css), css + ' => ' + r.css);
    }
    assert.strictEqual(Sandbox.sanitize('} body{display:none} @layer user{').ok, false);
    assert.strictEqual(Sandbox.sanitize('.a{content:"}"}').ok, true);
    const open = Sandbox.sanitize('.a{color:red');
    assert(open.ok && open.css.endsWith('}'));
    assert.strictEqual(Sandbox.sanitize('.card{border-radius:28px}').report.length, 0);
  });

  await test('seal: meta.json hash matches (run tools/seal.js after editing meta)', () => {
    const crypto = require('crypto');
    const m = dock.readJson(dock.p('meta.json'));
    const h = crypto.createHash('sha256').update([m.product, m.author, m.handle, m.year, m.license, m.repo].join('|')).digest('hex');
    assert.strictEqual(m.seal, h);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
