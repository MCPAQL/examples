# Polling sources and interpretation

The adapter uses [electoral-vote.com](https://www.electoral-vote.com/) for polling evidence and [Electoral Vote Map](https://electoralvotemap.com/) for clickable maps. All four polling operations use `mcp_aql_read`: they retrieve or calculate data without changing a saved map or browser.

## Source catalog

`list_poll_datasets` independently probes these verified download locations and returns each dataset's availability, race IDs, record counts by kind, source URL and retrieval timestamp. A failed request is an explicit unavailable source, not an empty polling dataset.

| Dataset ID | Office / cycle | Source |
|------------|----------------|--------|
| `president_2024` | President, 2024 | [CSV](https://www.electoral-vote.com/evp2024/Pres/pres_polls.csv) |
| `senate_2024` | Senate, 2024 | [CSV](https://www.electoral-vote.com/evp2024/Senate/senate_polls.csv) |
| `senate_2026` | Senate, 2026 | [CSV](https://www.electoral-vote.com/evp2026/Senate/senate_polls.csv) |

These are an explicit supported catalog, not a claim that a 2028 presidential dataset exists. Future datasets need a reviewed catalog entry and format verification. Each download is bounded to 2 MiB and 10,000 records, with a 15-second timeout, redirect rejection, request coalescing, a five-minute success cache and a 30-second failure cooldown. No caller-supplied network address is accepted.

## What a record means

The same file can change meaning during an election cycle. The November 14, 2026 inspection found historical polls mixed with election results in the 2024 files, while the current 2026 Senate file contained election calls and an uncalled race.

| Record kind | Recognition / treatment |
|-------------|------------------------|
| `poll` | A pollster-labeled observation; eligible for averaging only when both D/R shares are present |
| `historical_result` | An `Election YEAR` label; its referenced year can differ from the dataset cycle; excluded from polling averages |
| `election_call` | A `Called for ...` label; a reported call, not a fresh poll or certification; excluded from averages |
| `uncalled` | An explicit uncalled/too-close label; excluded from averages |
| `unknown` | A non-poll estimate/forecast/result-like label; retained for inspection and excluded from averages |

Classification precedence is source-specific: exact `Election YEAR`, `Called for ...`, and uncalled markers come first. The exact labels `Election Data Services` and `Primary Source Research` are reviewed keyword-collision exceptions; they are label interpretations, not independent certification of organizations or surveys. Remaining result/call/aggregate/forecast/exit-poll/primary-like labels stay `unknown`. Other ordinary pollster labels follow the source's pollster convention. Each record preserves `raw_label`, normalized `label`, `classification_reason` and `classification_confidence` (`source_label`, `label_only` or `unresolved`). Unknown exclusions include up to 100 diagnostic entries with row/group references, a truncation flag, and the full kind counts.

### Invalid rows and incomplete evidence

`row_policy` defaults to `strict`: any invalid data row rejects the dataset. Explicit `quarantine` accepts valid rows while reporting `quality.coverage: "partial"`, accepted/rejected/total source-row counts, known affected races, unknown-race rejection counts, and the first 100 rejected row references with machine-readable reasons. More rejections set `rejections_truncated`. Structural errors (CSV quoting/width, header drift, empty files), invalid UTF-8 downloads and size/count limits always reject the whole file. Files are never repaired by guessing.

Unknown state/race identities make selected-race coverage `uncertain`; no empty partial result proves a race has no polls. Rejected rows are not date-filtered because their date fields may themselves be invalid. The partial-dataset warning therefore persists across cutoffs. Strict and quarantine requests share one cached source download.

`get_state_polls` can inspect quarantined evidence directly. `get_poll_average` requires explicit `incomplete_policy: "use_accepted"` to average it; the default `error` rejects incomplete datasets. `build_polling_scenario` accepts `error`, `use_accepted`, `keep`, or `toss_up`. Keep/toss policies withhold averages and applied margins, then retain or mark every requested state as toss-up; they do not use a partial average. These conservative policies apply to the whole partial dataset, even for a race with no known rejected row. Source quality and the selected policies remain in each map's evidence.

```json
{
  "operation": "get_poll_average",
  "params": {
    "dataset_id": "senate_2024",
    "race_id": "PA",
    "as_of": "2024-11-02",
    "row_policy": "quarantine",
    "incomplete_policy": "use_accepted",
    "duplicate_policy": "collapse_indistinguishable"
  }
}
```

Blank percentage fields remain null. In particular, an absent independent share is not treated as zero. The CSV does not identify candidate matchups, sample sizes or margins of error. Those fields remain null. D/R are the source column labels, not verified candidate party or caucus identities; independently verify Senate independents and changes in presidential nominees before making substantive party predictions. Source-era electoral-vote counts are not reused when generating a map.

## Dates, phases and freshness

Every record query, average and generated polling scenario requires an explicit `as_of` date in UTC (`YYYY-MM-DD`). Data with a source/fieldwork end date after that cutoff is excluded. Calendar phase is reported separately as `pre_election`, `election_day` or `post_election`, using the federal general-election date for the dataset cycle. A post-election phase does not imply certification or that every race has been called.

The files do not provide publication timestamps or previous revisions. An as-of query filters dates in the file retrieved today; it is **not a reconstruction of exactly what was publicly available on that historical date**. Result-row dates are source markers, not authoritative election or certification dates. Polls ending before a cutoff may have been released afterward. A result-only replacement file cannot reconstruct polling observations it no longer contains.

Source end dates are interpreted in the dataset's cycle year. Fieldwork may begin in December of the previous year and end in early January; midpoint days of zero or below are accepted when consistent with the supplied duration and end date. The averaging window remains continuous across New Year. The parser does not guess an alternative year for an end date whose year is absent from the source.

`get_poll_average` reproduces the site's [documented method](https://www.electoral-vote.com/evp2026/Info/map-algorithm.html): select the latest eligible poll by its fieldwork midpoint, then equally average distinct poll rows whose midpoints lie within the preceding seven days, inclusive. The latest midpoint anchors the window even when that cluster is old. By default, indistinguishable rows are collapsed and counted; different observations from the same pollster retain equal weight. The [polling FAQ](https://www.electoral-vote.com/evp2026/Info/polling-faq.html) identifies the fieldwork midpoint, rather than release date, as the ordering date.

Freshness is independent: `age_days` is the difference between `as_of` and the latest included fieldwork end. `max_age_days` defaults to 30. Results report `fresh`, `stale` or `no_usable_polls`, the exact contributing records, unknown labels excluded by the classifier, other record counts, and the kinds on the latest visible source date. A polls-only summary can coexist with a later election result; it is not presented as the current election outcome.

### Duplicate provenance and weighting

`duplicate_policy` defaults to `collapse_indistinguishable`, preserving the original one-weight-per-published-field-group behavior. `keep_all` gives every accepted CSV source row equal weight. Neither policy verifies survey identity: the source supplies no unique survey IDs, and two genuine surveys can have indistinguishable published fields.

Collapsed records preserve every `source_rows` reference and each row's original label in `source_labels` (`{source_row, raw_label}`). The collapsed record's top-level `raw_label` belongs to its first row. Under keep-all, each observation restores its own raw label and row references, while `duplicate_groups` retains the full group references and labels. This includes labels that normalize alike but differ in whitespace or duration suffix. `source_group_id` is local to this download and is not a stable upstream survey ID. Row references count CSV records including the header and blank records; quoted multiline fields remain one record.

`dataset_indistinguishable_rows` counts all extra repeated rows in the dataset, `race_duplicate_rows` counts those for the selected race/cutoff, and `included_duplicate_rows` counts those inside the actual averaging window. `dataset_duplicate_rows_removed` reports actual dataset-wide removals under the chosen policy (zero for keep-all). Map evidence carries the policy, groups, and exact contributing observations. Regular and special races always stay separate.

```json
{
  "operation": "get_poll_average",
  "params": {
    "dataset_id": "president_2024",
    "race_id": "PA",
    "as_of": "2024-11-04",
    "max_age_days": 30
  }
}
```

## Polling scenarios

`build_polling_scenario` takes a base scenario or map URL and the selected race IDs. Only one race per state may be selected. It uses actual poll averages, with **no automatic substitution of calls, historical results or older-election baselines**. The separate research-to-map operation remains available for explicitly sourced congressional-result scenarios.

Required policies:

- `comparison_mode`: `same_race_year` requires presidential polls from the map's year. A different year or Senate source requires `hypothetical_cross_election` and is labeled hypothetical in the output.
- `stale_policy`: `error`, `keep`, `toss_up`, or explicit `use` of stale polls.
- `unavailable_policy`: `error`, `keep`, or `toss_up` when usable polls are absent, including result-only datasets.
- `district_policy`: `preserve_districts` changes only statewide Maine/Nebraska units; `state_sweep` also assigns their districts by the same hypothetical rating.
- `rating_thresholds`: numeric `{toss_up_below, likely_from, safe_from}` satisfying `0 <= toss_up_below < likely_from < safe_from <= 100`. These are scenario display rules, not claimed to be either site's forecasting model.

The Democratic-minus-Republican margin receives an optional `swing_points` adjustment: positive favors Democrats and negative favors Republicans. A tie is always a toss-up. Otherwise an absolute margin below `toss_up_below` is a toss-up, below `likely_from` is Lean, below `safe_from` is Likely, and at or above `safe_from` is Safe. These shades encode the requested scenario rule, **not calibrated winning probabilities**.

```json
{
  "operation": "build_polling_scenario",
  "params": {
    "scenario_id": "current",
    "dataset_id": "president_2024",
    "as_of": "2024-11-04",
    "race_ids": ["PA", "MI", "WI"],
    "comparison_mode": "hypothetical_cross_election",
    "rating_thresholds": {"toss_up_below": 2, "likely_from": 5, "safe_from": 10},
    "swing_points": -3,
    "stale_policy": "error",
    "unavailable_policy": "error",
    "district_policy": "preserve_districts"
  }
}
```

The response carries each average, source timestamp, selected policy, applied margin and rating, plus the resulting map URL. States outside the requested scope retain the base map. Explicit keep/toss decisions never report a nonexistent applied polling margin. The URL carries only ratings and electoral allocation; retain the response to preserve evidence and assumptions.

## Verification

```sh
npm test
npm run smoke:polling
node scripts/check-schemas.js /path/to/MCPAQL/spec/schemas
```

Deterministic tests use synthetic data, covering election phases, result/call exclusion, old result years, regular/special races, blank shares, exact duplicates, seven-day boundaries, future dates, missing metadata, stale-data decisions, map policies and source failures. The MCP transport test also exercises a polling average. The live smoke test probes all three downloads, checks their record distinctions and a historical polling summary, generates a hypothetical map, and round-trips its URL.

The initial polling extension run is recorded in [polling validation](validation/polling-checks.json), including dataset counts, source timestamps, generated map and schema/tool check results. Recorded counts are point-in-time snapshots and may drift as the live files change. The original map-only evidence in the main README remains a record of version 0.1.0; rerun validation commands for current results.
