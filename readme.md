# promptc

Prompt compiler. Paste a rough prompt, pick a target model and an effort level, and get a detailed, structured, model-specific prompt back.

Zero dependencies. Node 18+ only. No build step.

```
tech stack     node http server · vanilla js/css frontend · json file registry
engine         local rule-based compiler (always works) + optional upstream llm (any openai-compatible api)
```

## folder structure

```
promptc/
├─ kernel.js              http server + api + static files          (start here)
├─ core/
│  ├─ forge.js            the compiler: analyze → structure → expand → render → verify
│  ├─ relay.js            async job queue (concurrency 2, shortest-job-first with aging)
│  ├─ prism.js            ai theme generator (local palette engine or upstream llm)
│  ├─ uplink.js           optional upstream llm client
│  └─ dock.js             atomic json read/write helpers
├─ registry/
│  ├─ grid.json           THE model registry (edit this to add a model by hand)
│  ├─ signals.json        new-model drafts waiting for your approval
│  └─ pulse.json          updater state: last run, status
├─ daemon/
│  ├─ sentinel.js         14-day model updater
│  └─ sources.json        where the updater looks (apis, changelog pages, prompting docs)
├─ ui/
│  ├─ index.html
│  ├─ css/chassis.css     layout + components, declares the @layer order (lock < skin < user)
│  ├─ css/skins.css       built-in themes (css variables only)
│  └─ js/
│     ├─ vault.js         localStorage (history, theme, css)
│     ├─ sandbox.js       css sanitizer + constructable stylesheets
│     ├─ glow.js          cursor-tracking shine
│     ├─ delta.js         word-level diff
│     └─ app.js           ui logic
├─ tools/
│  ├─ seal.js             signs authorship metadata
│  └─ selftest.js         offline tests
├─ .github/workflows/sentinel.yml   runs the updater on github
├─ meta.json  ledger.json  license  .env.example  package.json
```

File names are deliberately short, lowercase and not obvious: `forge` compiles, `relay` queues, `prism` makes themes, `dock` stores, `uplink` calls the llm, `vault` is browser storage, `delta` diffs, `glow` is the shine, `chassis`/`skins` are layout/looks, `sentinel` watches for new models, `grid` is the model table, `signals` are notifications, `pulse` is the updater heartbeat, `ledger` is the changelog, `kernel` is the server.

## guide: build and run it from zero

1. **Install node 18 or newer.** Check with `node -v`.
2. **Create the folder structure above** (or unzip/clone the repo). There is nothing to `npm install`.
3. **Sign it as yours.** `node tools/seal.js "Your Name" your-github-handle https://github.com/you/promptc`
This writes your name into `meta.json`, updates the `license` copyright line and the html author tag, and stores a sha-256 seal.
4. **Optional: configure.** `cp .env.example .env`. Leave it empty to use the built-in local compiler. To use a real llm for compiling and for the ai theme generator, set `PC\_UPSTREAM\_URL`, `PC\_UPSTREAM\_KEY`, `PC\_UPSTREAM\_MODEL` (any openai-compatible `/chat/completions` endpoint).
5. **Test.** `npm test` (or `node tools/selftest.js`). It should end with `15 passed`.
6. **Start.** `npm start`, then open http://127.0.0.1:4173
7. **Use it.** Type a rough prompt, choose a model and effort, press compile (ctrl/⌘ + enter). Queue several: finished ones appear instantly while others keep working. Use *Copy compiled prompt*, and the *Original vs optimized* / *Diff* tabs.
8. **Style it.** *Appearance* → pick a theme, open the *CSS editor*, or describe a vibe in *AI theme*. Export/import `.css` there too.
9. **Publish to github.**

```
   git init \&\& git add . \&\& git commit -m "promptc v1.0.0"
   git tag -s v1.0.0 -m "v1.0.0"      # signed tag = strong proof of authorship
   git remote add origin https://github.com/you/promptc.git \&\& git push -u origin main --tags
   ```

   In the repo settings add secrets `OPENAI\_API\_KEY`, `ANTHROPIC\_API\_KEY`, `GOOGLE\_API\_KEY`, `XAI\_API\_KEY`, `DEEPSEEK\_API\_KEY` (any subset) so the workflow can list new models.

10. **Release a new version.** Bump `version` in `package.json`, add an entry at the top of `ledger.json` (it feeds the *What's changed* window), commit, tag.

## effort levels

|level|what the compiler adds|
|-|-|
|low|persona, 1 constraint, 1 negative, minimal output format|
|medium|persona, context, 4–5 reasoning steps, constraints, negatives, section structure|
|high|everything above fuller, 2 edge cases, self-check, 1 few-shot example, ordered sections, private reasoning|
|very high|all steps, all constraints and edge cases, 2 few-shot examples, strict schema ("exactly these headings, nothing else")|

## model families (registry `family` field)

|family|format|
|-|-|
|`anthropic`|semantic XML tags; reference data first in `<documents>`, instructions last in `<instructions>`|
|`google`|`###` markdown; persona and strictest constraints on top, few-shot examples, raw data at the bottom|
|`openai`|`### SECTIONS ###`, numbered execution steps, triple-quoted data, explicit negatives, strict output schema|
|`open`|short rules, `Step n:` reasoning chain, output template|

### add a model by hand

Add one object to `registry/grid.json`. No code changes, it shows up in the selector on reload:

```json
{ "id": "my-model", "label": "My Model", "provider": "Other", "family": "open",
  "tweaks": { "thinking": "prompted" }, "notes": \[], "added": "2026-11-15", "source": "manual" }
```

`thinking: "native"` marks models that reason internally (the template then says "reason internally, show only the result").

### add a new format family

Write a `renderXxx(plan)` function in `core/forge.js`, register it in `RENDERERS`, add a line to `FAMILY\_RULES`, then use `"family": "xxx"` in the registry.

## model updater (every 14 days)

`daemon/sentinel.js` compares provider model lists to `registry/grid.json`:

* **api sources** (accurate, need that provider's key in the environment) list the provider's real model ids.
* **page sources** scrape public changelog pages with a regex (no key, low confidence).
* It fetches each provider's prompting-guide page and keeps up to 6 formatting tips as the draft profile's `notes`.
* New models become *drafts* in `registry/signals.json`; the app shows a dot on the ⟳ button. Nothing enters the model list until you press **Adopt**. Adopted notes are fed to the upstream llm when you use one.

Three ways to run it (pick one):

|how|command|
|-|-|
|built into the server|automatic: checked 5 s after start and every 6 h, runs when 14 days have passed (`PC\_SENTINEL=off` disables)|
|own process|`npm run sentinel:daemon`|
|github actions|`.github/workflows/sentinel.yml` runs daily, does real work every 14 days, commits `registry/`|
|cron|`0 4 \* \* \* cd /path/promptc \&\& node daemon/sentinel.js --once --if-due`|

Run it right now: `npm run sentinel` or *Model updates → Check now*. Edit `daemon/sources.json` to add providers or doc pages.

## css sandbox: why the editor cannot break the app

1. **Layers.** `chassis.css` declares `@layer lock, skin, user;`. User css is wrapped in `@layer user`. Structure (grid, modals, drawer, toasts, authorship bar, hidden state) sits in `lock` with `!important`. For `!important` rules the earlier layer wins, so user css can never override it.
2. **No injection.** User css is applied through `CSSStyleSheet.replaceSync`, never through a `<style>` tag.
3. **Sanitizer** (`ui/js/sandbox.js`) removes `@import`, `@font-face`, every resource-loading function (`url()`, `image-set()` …), `expression`, `behavior`, backslash escapes, and rejects css with a stray `}` that would break out of its layer.
4. **AI theme output** is limited to 22 whitelisted css variables with character-checked values, on the server and again in the browser.

## ownership and license: what it proves and what it does not

* `license` (MIT) carries your copyright line. `meta.json` holds the authorship record and a sha-256 seal.
* The page shows a seal bar. The browser recomputes the hash; if the attribution text or the seal is edited, it shows a red alert. A watchdog re-checks every 5 s that the bar is still visible. The bar is also protected in the `lock` css layer.
* **This is tamper-evident, not tamper-proof.** Anyone can fork the repo, edit the code, and re-seal under their name. No client-side code can prevent that, and the MIT license allows forks as long as your copyright notice stays.
* **Real proof of authorship** is your git history: commit early and often, use signed commits and signed tags, keep the repo public from day one, and optionally record the first release with a dated artifact (GitHub release, Zenodo DOI, or a copyright registration). If you want to restrict copying, pick a different license than MIT (e.g. source-available).

## api

|method|path||
|-|-|-|
|GET|`/api/meta` `/api/models` `/api/changelog` `/api/health`||
|POST|`/api/jobs` `{prompt, modelId, effort}`|returns a job id immediately (202)|
|GET|`/api/jobs?ids=a,b`|poll status / result|
|POST|`/api/jobs/:id/cancel`|cancels a queued job|
|POST|`/api/theme` `{vibe}`|ai theme generator|
|GET|`/api/signals`|pending model drafts|
|POST|`/api/signals/:id/adopt` or `/dismiss`||
|POST|`/api/sentinel/run`|run the updater now|

## notes

* The local engine is rule-based: it understands common task types (translate, extract, summarize, code, plan, analyze, explain, brainstorm, write) and falls back to a general template. It does not "understand" your prompt like an llm. For the best expansion connect an upstream llm; the local engine stays as automatic fallback.
* The model names are taken from your brief. The updater will not find a model that provider APIs do not list, and page scraping is best-effort.
* Prompt history is stored only in your browser's localStorage. The server keeps jobs in memory (last 400).

\## contact



Discord: lyn\_lyaaaaaaaaa

GitHub: https://github.com/yeowlovegames-sys

MIT license. See `license`.

