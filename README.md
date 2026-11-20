# NCP literature screening

This tool screens OpenAlex search results for relevance to one IPBES Nature's Contribution to People (NCP). Two models (Claude and an OpenAI model) screen every record independently, using the same rubric. Records they agree on are sorted automatically. Everything else goes to a human-review queue.

**Website:** https://berobinson.github.io/NCP/
**Try it without API keys:** https://berobinson.github.io/NCP/?demo=1 (random answers, no cost)

---

## Using the website

1. **API keys.** Paste the lab keys (shared privately; never post them anywhere). They are sent only to Anthropic and OpenAI, directly from your browser. Tick *Remember keys* only on your own computer.
2. **Rubric.** Choose the NCP. *Read the full prompt* shows exactly what the models are told.
3. **Records.** Load the OpenAlex CSV from the search runner. You can screen everything, a random sample, or the first N records.
4. **Screen.** Press *Start screening* and keep the tab open. 900 records with both models takes roughly 15–30 minutes. If the tab closes or some records fail, load the same file, choose the same rubric and press Start again: finished records are skipped.
5. **Results.** Download:
   - **results (.csv)**: every record, both models' decisions and rationales, and a `consensus` column. Records needing human review come first, with empty `human_decision` and `human_notes` columns to fill in. Opens in Excel.
   - **agreement report (.txt)**: counts, confusion matrix and Cohen's kappa.
   - **audit log (.jsonl)**: for each record and model, the model ID, rubric version, timestamp, raw output and token use. Keep this for the methods section.

Results are saved in your browser, per record, model and rubric version. Another computer or browser starts from zero.

### How a decision is made
The models rate three criteria, each as yes, partly or no (A: food/feed from nature is central; B: the paper has evidence on status, trends, drivers or impacts; C: its scope is informative for a global assessment). They also flag any exclusion code.

- **1 (relevant):** all three "yes", with no exclusion
- **2 (uncertain):** nothing is "no" but something is "partly", or too little information
- **0 (not relevant):** an exclusion applies, or any criterion is "no"

A record is included or excluded automatically only when both models give the same 0 or 1 **and** each decision matches that model's own ratings. Everything else goes to human review.

---

## Changing a rubric

Rubrics are the files in [`rubrics/`](rubrics/). To edit one, open it on GitHub, click the pencil icon, make the change and click *Commit changes*. About a minute later the website uses the new wording, under a new version code. Results saved under the old version are not reused, so nothing is silently mixed.

To add a rubric for another NCP, copy an existing file (e.g. `ncp11_energy.toml`), change `ncp_number`, and rewrite the definition, criteria, exclusions and categories. It appears in the website's dropdown automatically.

**If the site doesn't update:** open the repository's **Actions** tab. A red ✗ means the rubric file has a formatting error, and the message says which line. The live site keeps the previous working version until it's fixed. The usual mistake: plain `key = value` lines must sit **above** the first `[section]` header.

Default models and the number of parallel requests are in [`config.toml`](config.toml).

---

## For maintainers

**How it fits together.** The website is static (GitHub Pages) and has no server. On every push to `main`, the workflow in `.github/workflows/pages.yml` runs `tools/build_site.py`. That script validates every rubric, renders each one into its exact prompt, output schema and version code with the Python code in `src/ncp_screen/rubric.py`, and publishes the site. The browser code (`assets/app.js`) only sends those prompts, so the website and the command-line tool always use identical wording.

**Preview locally:**
```bash
python tools/build_site.py
python -m http.server 8000 -d _site     # open http://localhost:8000/?demo=1
```

**Key management.** The keys are shared with the team, so:
- set a monthly spending limit on both accounts (Anthropic Console → workspace limits; OpenAI → project budget);
- use a dedicated Anthropic workspace and OpenAI project for this work, so usage is separate and the keys can be revoked without affecting anything else;
- rotate the keys if someone leaves the project or a key is exposed.

**Command-line version (optional, for very large runs).** The same screening runs from a terminal and doesn't need a browser tab open. Install [uv](https://docs.astral.sh/uv/), copy `.env.example` to `.env` with the keys, then:
```bash
uv run ncp-screen check data/openalex_results.csv
uv run ncp-screen claude data/openalex_results.csv
uv run ncp-screen openai data/openalex_results.csv
uv run ncp-screen compare
```
Results go to `output/`. It reads the same `rubrics/` and `config.toml` as the website.
