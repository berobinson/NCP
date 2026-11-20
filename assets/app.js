/* NCP literature screening: browser app.
 *
 * The rubric JSON files (built from rubrics/*.toml at deploy time) carry the
 * exact system prompt, record template, output schema and version code, so
 * this file contains no screening wording of its own. It loads the CSV, calls
 * the two APIs directly from the browser, saves every result in IndexedDB
 * (so runs can resume), and builds the downloadable results.
 */
'use strict';

const DEMO = new URLSearchParams(location.search).has('demo');
const $ = (id) => document.getElementById(id);
const PROVIDERS = ['claude', 'openai'];
const LABEL = { claude: 'Claude', openai: 'OpenAI' };
const TOOL_NAME = 'record_screening_decision';

const state = {
  config: {},
  rubricIndex: [],
  rubric: null,
  parsed: null,        // { rows, fields }
  fileName: '',
  records: [],         // records for the chosen rubric's NCP, deduplicated
  selection: [],       // the subset to screen
  saved: new Map(),    // key -> saved entry
  running: false,
  stop: false,
  session: {},         // per-provider counters for this run
};

/* ------------------------------------------------------------------ storage */

const db = {
  handle: null,
  async open() {
    this.handle = await new Promise((resolve, reject) => {
      const req = indexedDB.open('ncp-screen', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('results', { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  tx(mode) { return this.handle.transaction('results', mode).objectStore('results'); },
  async all() {
    return new Promise((resolve, reject) => {
      const req = this.tx('readonly').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async put(entry) {
    return new Promise((resolve, reject) => {
      const req = this.tx('readwrite').put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  async clear() {
    return new Promise((resolve, reject) => {
      const req = this.tx('readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
};

const resultKey = (provider, model, version, id) => `${provider}|${model}|${version}|${id}`;

function defaultSettings() {
  const c = state.config;
  return {
    claudeModel: c.claude?.model || 'claude-opus-5-5',
    claudeTemperature: c.claude?.temperature ?? 0,
    claudeMaxTokens: c.claude?.max_tokens || 1024,
    openaiModel: c.openai?.model || 'gpt-5.6',
    openaiEffort: c.openai?.reasoning_effort || 'medium',
    openaiMaxTokens: c.openai?.max_output_tokens || 4000,
    workers: c.run?.workers || 4,
  };
}

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('ncp.settings') || '{}'); } catch { /* ignore */ }
  s = { ...defaultSettings(), ...s };
  $('claude-model').value = s.claudeModel;
  $('openai-model').value = s.openaiModel;
  $('openai-effort').value = s.openaiEffort;
  $('workers').value = s.workers;
  const remembered = localStorage.getItem('ncp.keys');
  const keys = JSON.parse(remembered || sessionStorage.getItem('ncp.keys') || '{}');
  $('key-anthropic').value = keys.anthropic || '';
  $('key-openai').value = keys.openai || '';
  $('remember-keys').checked = !!remembered;
}

function currentSettings() {
  const d = defaultSettings();
  return {
    ...d,
    claudeModel: $('claude-model').value.trim() || d.claudeModel,
    openaiModel: $('openai-model').value.trim() || d.openaiModel,
    openaiEffort: $('openai-effort').value,
    workers: Math.max(1, Math.min(16, parseInt($('workers').value, 10) || d.workers)),
  };
}

function saveSettings() {
  const s = currentSettings();
  localStorage.setItem('ncp.settings', JSON.stringify({
    claudeModel: s.claudeModel, openaiModel: s.openaiModel,
    openaiEffort: s.openaiEffort, workers: s.workers,
  }));
  const keys = JSON.stringify({ anthropic: $('key-anthropic').value.trim(),
                                openai: $('key-openai').value.trim() });
  if ($('remember-keys').checked) {
    localStorage.setItem('ncp.keys', keys);
    sessionStorage.removeItem('ncp.keys');
  } else {
    sessionStorage.setItem('ncp.keys', keys);  // survives a reload of this tab only
    localStorage.removeItem('ncp.keys');
  }
}

/* ------------------------------------------------------------------ rubrics */

function repoInfo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (m) {
    const first = location.pathname.split('/').filter(Boolean)[0];
    return { owner: m[1], repo: first || `${m[1]}.github.io` };
  }
  const r = state.config.site?.repository;
  if (r && r.includes('/')) { const [owner, repo] = r.split('/'); return { owner, repo }; }
  return null;
}

async function loadRubric(jsonName) {
  const resp = await fetch(`rubrics/${jsonName}`, { cache: 'no-cache' });
  if (!resp.ok) throw new Error(`Could not load rubric ${jsonName}`);
  state.rubric = await resp.json();
  const r = state.rubric;
  $('rubric-meta').innerHTML =
    `NCP <b>${r.ncp_number}</b> · <b>${esc(r.ncp_name)}</b> · version <code>${r.version}</code> · file <code>${esc(r.file)}</code><br>` +
    `A: ${esc(r.criteria.A)} · B: ${esc(r.criteria.B)} · C: ${esc(r.criteria.C)}`;
  $('rubric-prompt').textContent = r.system_prompt;
  const info = repoInfo();
  const link = $('rubric-edit-link');
  if (info) link.href = `https://github.com/${info.owner}/${info.repo}/edit/main/rubrics/${r.file}`;
  else link.removeAttribute('href');
  prepareRecords();
}

/* ------------------------------------------------------------------ records */

function parseCsv(file, encoding) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true, skipEmptyLines: 'greedy', encoding,
      transformHeader: (h) => h.replace(/^﻿/, '').trim(),
      complete: (res) => resolve(res), error: reject,
    });
  });
}

async function onFile(file) {
  if (!file) return;
  $('data-meta').textContent = 'Reading…';
  let res = await parseCsv(file, 'UTF-8');
  const sample = JSON.stringify(res.data.slice(0, 300));
  if (sample.includes('�')) res = await parseCsv(file, 'windows-1252');  // re-saved by Excel
  const fields = res.meta.fields || [];
  const missing = ['id', 'title', 'abstract'].filter((f) => !fields.includes(f));
  if (missing.length) {
    $('data-meta').innerHTML = `<span class="error">This file has no ${missing.join(', ')} column. Use the OpenAlex export produced by the search runner.</span>`;
    state.parsed = null; prepareRecords(); return;
  }
  state.parsed = { rows: res.data, fields };
  state.fileName = file.name;
  prepareRecords();
}

function prepareRecords() {
  state.records = [];
  if (!state.parsed || !state.rubric) { updateSelection(); return; }
  const { rows, fields } = state.parsed;
  const hasNcp = fields.includes('ncp_number');
  const nonBlank = rows.filter((r) => (r.id || '').trim());
  const forNcp = hasNcp ? nonBlank.filter((r) => Number(r.ncp_number) === state.rubric.ncp_number) : nonBlank;
  const seen = new Set();
  for (const r of forNcp) {
    const id = r.id.trim();
    if (!seen.has(id)) { seen.add(id); state.records.push({ ...r, id }); }
  }
  const withAbs = state.records.filter((r) => (r.abstract || '').trim()).length;
  let html = `<b>${esc(state.fileName)}</b>: ${rows.length} rows → ${nonBlank.length} non-blank` +
    (hasNcp ? ` → ${forNcp.length} for NCP ${state.rubric.ncp_number}` : '') +
    ` → <b>${state.records.length}</b> unique records (${withAbs} with abstracts).`;
  if (hasNcp && forNcp.length === 0 && nonBlank.length) {
    const present = [...new Set(nonBlank.map((r) => Number(r.ncp_number)))].sort((a, b) => a - b);
    html += `<br><span class="error">No records for NCP ${state.rubric.ncp_number}. This file contains NCP ${present.join(', ')}: choose the matching rubric.</span>`;
  }
  $('data-meta').innerHTML = html;
  updateSelection();
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function updateSelection() {
  const mode = $('subset').value;
  $('n-wrap').hidden = mode === 'all';
  $('seed-wrap').hidden = mode !== 'sample';
  const n = Math.max(1, parseInt($('subset-n').value, 10) || 1);
  let sel = state.records;
  if (mode === 'first') sel = sel.slice(0, n);
  if (mode === 'sample') {
    const rnd = mulberry32(parseInt($('seed').value, 10) || 0);
    const arr = sel.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    sel = arr.slice(0, n);
  }
  state.selection = sel;
  refreshRunButton();
  refreshResults();
}

function refreshRunButton() {
  const any = PROVIDERS.some((p) => $(`use-${p}`).checked);
  $('btn-run').disabled = state.running || !state.rubric || !state.selection.length || !any;
  $('btn-stop').disabled = !state.running;
  if (!state.running) {
    $('run-msg').textContent = state.selection.length
      ? `${state.selection.length} records selected.` : 'Load a CSV to begin.';
  }
}

/* -------------------------------------------------------- prompt and checks */

function clean(v, dflt = 'not provided') {
  if (v === null || v === undefined) return dflt;
  const s = String(v).trim();
  return s || dflt;
}

function buildUserMessage(rubric, row) {
  let abstract = clean(row.abstract, 'NO ABSTRACT AVAILABLE');
  const cps = Array.from(abstract);
  if (cps.length > rubric.max_abstract_chars) {
    abstract = cps.slice(0, rubric.max_abstract_chars).join('') + ' [...truncated]';
  }
  const y = parseFloat(row.year);
  const vals = {
    ncp_number: rubric.ncp_number, ncp_name: rubric.ncp_name,
    title: clean(row.title), type: clean(row.type), source: clean(row.source),
    year: Number.isFinite(y) ? Math.trunc(y) : 'not provided',
    topic: clean(row.topic), keywords: clean(row.keywords), abstract,
  };
  return rubric.user_template.replace(/\{(\w+)\}/g, (m, k) => (k in vals ? vals[k] : m));
}

function validateResult(rubric, r) {
  if (!r || typeof r !== 'object') throw new Error('output is not an object');
  const missing = rubric.schema.required.filter((k) => !(k in r));
  if (missing.length) throw new Error(`missing keys: ${missing.join(', ')}`);
  for (const [k, spec] of Object.entries(rubric.schema.properties)) {
    const v = r[k];
    if (spec.enum && !spec.enum.includes(v)) throw new Error(`${k}=${JSON.stringify(v)} not allowed`);
    if (spec.type === 'array') {
      if (!Array.isArray(v)) throw new Error(`${k} is not a list`);
      const bad = v.filter((x) => !spec.items.enum.includes(x));
      if (bad.length) throw new Error(`${k} has invalid values ${bad.join(', ')}`);
    }
  }
}

function ruleDecision(r) {
  const crit = [r.criterion_A, r.criterion_B, r.criterion_C];
  if (r.exclusion_code !== 'none') return 0;
  if (crit.every((c) => c === 'yes')) return 1;
  if (crit.includes('no')) return 0;
  return 2;
}

/* -------------------------------------------------------------- API calls */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const FATAL_STATUS = new Set([400, 401, 403, 404]);

async function postJson(url, headers, body) {
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    let resp = null; let netErr = null;
    try {
      resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) { netErr = e; }
    if (resp && resp.ok) return resp.json();

    const status = resp ? resp.status : 0;
    let detail = netErr ? 'network error (offline, or the request was blocked)' : '';
    if (resp) {
      const text = await resp.text().catch(() => '');
      try { detail = JSON.parse(text).error?.message || text; } catch { detail = text; }
    }
    const maxAttempts = resp ? 7 : 3;
    if (!(netErr || RETRY_STATUS.has(status)) || attempt >= maxAttempts || state.stop) {
      const err = new Error(`${status ? 'HTTP ' + status + ': ' : ''}${String(detail).slice(0, 300)}`);
      err.fatal = FATAL_STATUS.has(status);
      throw err;
    }
    let wait = delay * (0.75 + Math.random() * 0.5);
    const ra = resp && Number(resp.headers.get('retry-after'));
    if (ra) wait = Math.max(wait, ra * 1000);
    await sleep(Math.min(wait, 60000));
    delay *= 2;
  }
}

async function callClaude(rubric, s, key, userMessage) {
  const body = {
    model: s.claudeModel,
    max_tokens: s.claudeMaxTokens,
    system: [{ type: 'text', text: rubric.system_prompt, cache_control: { type: 'ephemeral' } }],
    tools: [{ name: TOOL_NAME, description: 'Record the structured screening decision for one record.',
              input_schema: rubric.schema }],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: userMessage }],
  };
  if (s.claudeTemperature !== null && s.claudeTemperature !== undefined) body.temperature = s.claudeTemperature;
  const data = await postJson('https://api.anthropic.com/v1/messages', {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  }, body);
  const block = (data.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error(`no structured output (stop_reason=${data.stop_reason})`);
  const u = data.usage || {};
  return { result: block.input, usage: { input: u.input_tokens || 0, output: u.output_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0 } };
}

async function callOpenAI(rubric, s, key, userMessage) {
  const body = {
    model: s.openaiModel,
    instructions: rubric.system_prompt,
    input: userMessage,
    text: { format: { type: 'json_schema', name: 'screening_decision', schema: rubric.schema, strict: true } },
    max_output_tokens: s.openaiMaxTokens,
    store: false,
  };
  if (s.openaiEffort && s.openaiEffort !== 'none') body.reasoning = { effort: s.openaiEffort };
  const data = await postJson('https://api.openai.com/v1/responses', {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
  }, body);
  if (data.status !== 'completed') {
    throw new Error(`status=${data.status} ${JSON.stringify(data.incomplete_details || '')}`);
  }
  const msg = (data.output || []).find((o) => o.type === 'message');
  const part = msg && msg.content.find((c) => c.type === 'output_text' || c.type === 'refusal');
  if (!part) throw new Error('no output text');
  if (part.type === 'refusal') throw new Error(`refusal: ${part.refusal}`);
  const u = data.usage || {};
  return { result: JSON.parse(part.text), usage: { input: u.input_tokens || 0,
    output: u.output_tokens || 0, cache_read: u.input_tokens_details?.cached_tokens || 0 } };
}

async function callDemo(rubric) {
  await sleep(80 + Math.random() * 250);
  if (Math.random() < 0.03) throw new Error('simulated temporary error');
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const P = rubric.schema.properties;
  const t = () => pick(['yes', 'yes', 'partly', 'no', 'no']);
  const r = {
    criterion_A: t(), criterion_B: t(), criterion_C: t(),
    exclusion_code: Math.random() < 0.6 ? 'none' : pick(P.exclusion_code.enum.slice(1)),
    confidence: pick(P.confidence.enum), ncp_dimension: pick(P.ncp_dimension.enum),
    subject_category: [pick(P.subject_category.items.enum)],
    spatial_scale: pick(P.spatial_scale.enum), ipbes_region: pick(P.ipbes_region.enum),
    temporal_coverage: pick(P.temporal_coverage.enum), evidence_type: pick(P.evidence_type.enum),
    rationale: 'Demo answer (random).',
  };
  r.decision = Math.random() < 0.05 ? pick([0, 1, 2]) : ruleDecision(r);
  return { result: r, usage: { input: 1800, output: 150, cache_read: 1500 } };
}

/* ------------------------------------------------------------------ runner */

function modelFor(provider, s) { return provider === 'claude' ? s.claudeModel : s.openaiModel; }

async function runProvider(provider, s) {
  const rubric = state.rubric;
  const model = modelFor(provider, s);
  const key = provider === 'claude' ? $('key-anthropic').value.trim() : $('key-openai').value.trim();
  const sess = state.session[provider] = { total: state.selection.length, done: 0, errors: 0,
    input: 0, output: 0, fatal: null, model, lastError: '' };
  const todo = [];
  for (const row of state.selection) {
    const e = state.saved.get(resultKey(provider, model, rubric.version, row.id));
    if (e && e.status === 'ok') sess.done++; else todo.push(row);
  }
  drawProgress();
  let next = 0;
  const worker = async () => {
    while (!state.stop && !sess.fatal && next < todo.length) {
      const row = todo[next++];
      const entry = { key: resultKey(provider, model, rubric.version, row.id), id: row.id, provider,
        model, rubric_file: rubric.file, prompt_version: rubric.version,
        timestamp: new Date().toISOString() };
      try {
        const msg = buildUserMessage(rubric, row);
        const out = DEMO ? await callDemo(rubric)
          : provider === 'claude' ? await callClaude(rubric, s, key, msg)
            : await callOpenAI(rubric, s, key, msg);
        validateResult(rubric, out.result);
        Object.assign(entry, { status: 'ok', result: out.result, usage: out.usage });
        sess.done++; sess.input += out.usage.input; sess.output += out.usage.output;
      } catch (e) {
        Object.assign(entry, { status: 'error', error: e.message });
        sess.errors++; sess.lastError = e.message;
        if (e.fatal) sess.fatal = e.message;
      }
      const prev = state.saved.get(entry.key);
      if (!(prev && prev.status === 'ok')) {
        state.saved.set(entry.key, entry);
        await db.put(entry);
      }
      drawProgress();
    }
  };
  await Promise.all(Array.from({ length: s.workers }, worker));
  drawProgress();
}

function drawProgress() {
  const box = $('progress');
  box.innerHTML = '';
  for (const p of PROVIDERS) {
    const s = state.session[p];
    if (!s) continue;
    const pct = s.total ? (100 * s.done) / s.total : 0;
    const tok = s.input ? ` · ${fmt(s.input)} input / ${fmt(s.output)} output tokens this run` : '';
    let status = '';
    if (s.fatal) status = `<div class="error">Stopped: ${esc(s.fatal)}</div>`;
    else if (s.errors) status = `<div class="warn">${s.errors} failed (press Start again to retry them). Last error: ${esc(s.lastError)}</div>`;
    box.insertAdjacentHTML('beforeend', `<div class="prog">
      <div class="prog-head"><span><b>${LABEL[p]}</b> <code>${esc(s.model)}</code></span>
      <span>${s.done} / ${s.total}${tok}</span></div>
      <div class="bar"><div style="width:${pct.toFixed(1)}%"></div></div>${status}</div>`);
  }
}

async function startRun() {
  const s = currentSettings();
  saveSettings();
  const providers = PROVIDERS.filter((p) => $(`use-${p}`).checked);
  if (!DEMO) {
    const missing = providers.filter((p) => !(p === 'claude' ? $('key-anthropic') : $('key-openai')).value.trim());
    if (missing.length) {
      $('run-msg').innerHTML = `<span class="error">Add the ${missing.map((p) => LABEL[p]).join(' and ')} key in step 1.</span>`;
      return;
    }
  }
  state.running = true; state.stop = false; state.session = {};
  refreshRunButton();
  $('run-msg').textContent = 'Screening…';
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
  const timer = setInterval(refreshResults, 3000);
  try {
    await Promise.all(providers.map((p) => runProvider(p, s)));
  } finally {
    clearInterval(timer);
    try { await wakeLock?.release(); } catch { /* ignore */ }
    state.running = false;
    refreshRunButton();
    const failed = providers.some((p) => state.session[p].errors || state.session[p].fatal);
    $('run-msg').textContent = state.stop ? 'Stopped. Press Start to continue.'
      : failed ? 'Finished with some failures. Press Start again to retry them.' : 'Finished.';
    refreshResults();
  }
}

/* ----------------------------------------------------------------- results */

function okEntry(provider, model, id) {
  const e = state.saved.get(resultKey(provider, model, state.rubric.version, id));
  return e && e.status === 'ok' ? e : null;
}

function kappa(a, b, labels) {
  const n = a.length;
  if (!n) return NaN;
  let agree = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) agree++;
  const po = agree / n;
  let pe = 0;
  for (const k of labels) {
    pe += (a.filter((x) => x === k).length / n) * (b.filter((x) => x === k).length / n);
  }
  return pe < 1 ? (po - pe) / (1 - pe) : NaN;
}

function buildResults() {
  if (!state.rubric || !state.selection.length) return null;
  const s = currentSettings();
  const provs = PROVIDERS.filter((p) => $(`use-${p}`).checked);
  const fieldOrder = Object.keys(state.rubric.schema.properties);
  const rows = [];
  for (const rec of state.selection) {
    const row = { ...rec };
    const dec = {}; const consistent = {};
    for (const p of provs) {
      const e = okEntry(p, modelFor(p, s), rec.id);
      if (!e) continue;
      for (const k of fieldOrder) {
        const v = e.result[k];
        row[`${p}_${k}`] = Array.isArray(v) ? v.join('; ') : v;
      }
      consistent[p] = ruleDecision(e.result) === e.result.decision;
      row[`${p}_rule_consistent`] = consistent[p];
      row[`${p}_model`] = e.model;
      row[`${p}_prompt_version`] = e.prompt_version;
      row[`${p}_timestamp`] = e.timestamp;
      dec[p] = e.result.decision;
    }
    let consensus = 'not_screened'; let reason = '';
    const have = provs.filter((p) => p in dec);
    if (have.length === provs.length) {
      const vals = provs.map((p) => dec[p]);
      const allConsistent = provs.every((p) => consistent[p]);
      const same = vals.every((v) => v === vals[0]);
      if (same && vals[0] !== 2 && allConsistent) consensus = vals[0] === 1 ? 'include' : 'exclude';
      else {
        consensus = 'human_review';
        reason = !same ? 'models disagree' : vals[0] === 2
          ? (provs.length > 1 ? 'both uncertain' : 'uncertain') : 'decision inconsistent with criteria';
      }
    }
    row.consensus = consensus; row.review_reason = reason;
    row.human_decision = ''; row.human_notes = '';
    row.rubric_file = state.rubric.file; row.rubric_version = state.rubric.version;
    rows.push(row);
  }
  const rank = { human_review: 0, include: 1, exclude: 2, not_screened: 3 };
  rows.sort((a, b) => rank[a.consensus] - rank[b.consensus]);

  const front = ['consensus', 'review_reason', 'human_decision', 'human_notes',
    ...provs.map((p) => `${p}_decision`), 'title', 'abstract',
    ...provs.map((p) => `${p}_rationale`), ...provs.map((p) => `${p}_exclusion_code`), 'doi', 'id'];
  const original = state.parsed.fields.filter((f) => !front.includes(f));
  const provCols = [];
  for (const p of provs) {
    for (const k of [...fieldOrder, 'rule_consistent', 'model', 'prompt_version', 'timestamp']) {
      const c = `${p}_${k}`;
      if (!front.includes(c)) provCols.push(c);
    }
  }
  const columns = [...front, ...original, ...provCols, 'rubric_file', 'rubric_version'];
  return { rows, columns, provs, s };
}

function counts(rows, field) {
  const c = { 1: 0, 2: 0, 0: 0, none: 0 };
  for (const r of rows) {
    const v = r[field];
    if (v === 0 || v === 1 || v === 2) c[v]++; else c.none++;
  }
  return c;
}

function refreshResults() {
  const res = buildResults();
  const box = $('results-summary');
  const anyDone = res && res.rows.some((r) => res.provs.some((p) => r[`${p}_decision`] !== undefined));
  for (const id of ['btn-dl-csv', 'btn-dl-report', 'btn-dl-log']) $(id).disabled = !anyDone;
  if (!anyDone) {
    box.textContent = 'Results appear here once screening has started.';
    state.lastReport = '';
    return;
  }
  const { rows, provs, s } = res;
  const lines = [];
  let html = '<table><tr><th>Model</th><th>Relevant (1)</th><th>Uncertain (2)</th><th>Not relevant (0)</th><th>Not screened yet</th></tr>';
  lines.push(`NCP screening report: ${new Date().toISOString()}`,
    `File: ${state.fileName}  |  records in selection: ${rows.length}`,
    `Rubric: ${state.rubric.file}  (NCP ${state.rubric.ncp_number}: ${state.rubric.ncp_name}, version ${state.rubric.version})`, '');
  for (const p of provs) {
    const c = counts(rows, `${p}_decision`);
    html += `<tr><td>${LABEL[p]} <code>${esc(modelFor(p, s))}</code></td><td>${c[1]}</td><td>${c[2]}</td><td>${c[0]}</td><td>${c.none}</td></tr>`;
    lines.push(`${LABEL[p]} (${modelFor(p, s)}): relevant ${c[1]}, uncertain ${c[2]}, not relevant ${c[0]}, not screened ${c.none}`);
  }
  html += '</table>';

  if (provs.length === 2) {
    const both = rows.filter((r) => r.claude_decision !== undefined && r.openai_decision !== undefined);
    const a = both.map((r) => r.claude_decision); const b = both.map((r) => r.openai_decision);
    if (both.length) {
      html += `<p class="meta">Screened by both models: <b>${both.length}</b></p>`;
      html += '<table><tr><th>Claude ↓ / OpenAI →</th><th>0</th><th>1</th><th>2</th></tr>';
      lines.push('', `Screened by both models: ${both.length}`, '', 'Confusion matrix (rows = Claude, columns = OpenAI):', '         0     1     2');
      for (const i of [0, 1, 2]) {
        const cells = [0, 1, 2].map((j) => both.filter((r) => r.claude_decision === i && r.openai_decision === j).length);
        html += `<tr><th>${i}</th>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
        lines.push(`  ${i}  ${cells.map((c) => String(c).padStart(5)).join(' ')}`);
      }
      html += '</table>';
      const agree = a.filter((x, i) => x === b[i]).length / a.length;
      const k3 = kappa(a, b, [0, 1, 2]);
      const k2 = kappa(a.map((x) => +(x === 1)), b.map((x) => +(x === 1)), [0, 1]);
      html += `<p class="meta">Agreement <b>${agree.toFixed(3)}</b> · Cohen's kappa (0/1/2) <b>${fmtK(k3)}</b> · kappa (include vs not) <b>${fmtK(k2)}</b></p>`;
      lines.push('', `Raw agreement (0/1/2):          ${agree.toFixed(3)}`,
        `Cohen's kappa (0/1/2):          ${fmtK(k3)}`, `Cohen's kappa (include vs not): ${fmtK(k2)}`);
      for (const c of ['A', 'B', 'C']) {
        const ag = both.filter((r) => r[`claude_criterion_${c}`] === r[`openai_criterion_${c}`]).length / both.length;
        lines.push(`Agreement on criterion ${c}:      ${ag.toFixed(3)}`);
      }
    }
  }
  const cons = {};
  for (const r of rows) cons[r.consensus] = (cons[r.consensus] || 0) + 1;
  const reasons = {};
  for (const r of rows) if (r.review_reason) reasons[r.review_reason] = (reasons[r.review_reason] || 0) + 1;
  html += `<p class="meta">Consensus: ${['include', 'exclude', 'human_review', 'not_screened']
    .filter((k) => cons[k]).map((k) => `${k.replace('_', ' ')} <b>${cons[k]}</b>`).join(' · ')}</p>`;
  lines.push('', 'Consensus:', ...Object.entries(cons).map(([k, v]) => `  ${k}: ${v}`));
  if (Object.keys(reasons).length) {
    lines.push('', 'Reasons for human review:', ...Object.entries(reasons).map(([k, v]) => `  ${k}: ${v}`));
  }
  box.innerHTML = html;
  state.lastReport = lines.join('\n') + '\n';
}

function stamp() {
  return `ncp${state.rubric.ncp_number}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadCsv() {
  const res = buildResults();
  const csv = Papa.unparse({ fields: res.columns, data: res.rows.map((r) => res.columns.map((c) => r[c] ?? '')) });
  download(`${stamp()}_screening.csv`, '﻿' + csv, 'text/csv;charset=utf-8');  // BOM: Excel-friendly
}

function downloadLog() {
  const s = currentSettings();
  const provs = PROVIDERS.filter((p) => $(`use-${p}`).checked);
  const out = [];
  for (const rec of state.selection) {
    for (const p of provs) {
      const e = state.saved.get(resultKey(p, modelFor(p, s), state.rubric.version, rec.id));
      if (e) { const { key, ...rest } = e; out.push(JSON.stringify(rest)); }
    }
  }
  download(`${stamp()}_audit_log.jsonl`, out.join('\n') + '\n', 'application/x-ndjson');
}

/* -------------------------------------------------------------------- misc */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n));
const fmtK = (k) => (Number.isFinite(k) ? k.toFixed(3) : 'n/a');

async function init() {
  if (DEMO) $('demo-banner').hidden = false;
  try {
    const [cfg, idx] = await Promise.all([
      fetch('config.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})),
      fetch('rubrics/index.json', { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error('rubrics/index.json not found. Was the site built with tools/build_site.py?');
        return r.json();
      }),
    ]);
    state.config = cfg; state.rubricIndex = idx;
  } catch (e) {
    document.querySelector('main').insertAdjacentHTML('afterbegin',
      `<section class="card error">Could not load the site configuration: ${esc(e.message)}</section>`);
    return;
  }
  await db.open();
  for (const e of await db.all()) state.saved.set(e.key, e);
  loadSettings();

  const sel = $('rubric-select');
  for (const r of state.rubricIndex) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(r.json)}">NCP ${r.ncp_number}: ${esc(r.ncp_name)} (${esc(r.toml)})</option>`);
  }
  const last = localStorage.getItem('ncp.rubric');
  if (last && state.rubricIndex.some((r) => r.json === last)) sel.value = last;
  await loadRubric(sel.value);

  const info = repoInfo();
  $('footer-text').innerHTML = info
    ? `Rubrics and code: <a href="https://github.com/${info.owner}/${info.repo}">github.com/${info.owner}/${info.repo}</a>`
    : '';

  sel.addEventListener('change', async () => { localStorage.setItem('ncp.rubric', sel.value); await loadRubric(sel.value); });
  $('csv-file').addEventListener('change', (e) => onFile(e.target.files[0]));
  for (const id of ['subset', 'subset-n', 'seed']) $(id).addEventListener('input', updateSelection);
  for (const p of PROVIDERS) $(`use-${p}`).addEventListener('change', () => { refreshRunButton(); refreshResults(); });
  for (const id of ['key-anthropic', 'key-openai', 'remember-keys', 'claude-model', 'openai-model', 'openai-effort', 'workers']) {
    $(id).addEventListener('change', () => { saveSettings(); refreshResults(); });
  }
  $('reset-settings').addEventListener('click', () => {
    localStorage.removeItem('ncp.settings'); loadSettings(); saveSettings(); refreshResults();
  });
  $('btn-run').addEventListener('click', startRun);
  $('btn-stop').addEventListener('click', () => { state.stop = true; $('run-msg').textContent = 'Stopping after the requests in progress…'; });
  $('btn-dl-csv').addEventListener('click', downloadCsv);
  $('btn-dl-report').addEventListener('click', () => download(`${stamp()}_agreement_report.txt`, state.lastReport, 'text/plain;charset=utf-8'));
  $('btn-dl-log').addEventListener('click', downloadLog);
  $('btn-clear').addEventListener('click', async () => {
    if (state.running) return;
    if (!window.confirm('Delete all saved screening results from this browser?')) return;
    await db.clear(); state.saved.clear(); refreshResults();
  });
  window.addEventListener('beforeunload', (e) => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });
  refreshRunButton();
}

init();
