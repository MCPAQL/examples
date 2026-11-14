# Polling sources and interpretation

The adapter uses [electoral-vote.com](https://www.electoral-vote.com/) for polling evidence and [Electoral Vote Map](https://electoralvotemap.com/) for clickable maps. All four polling operations use `mcp_aql_read`: they retrieve or calculate data without changing a saved map or browser.

## Source catalog

`list_poll_datasets` independently probes these verified download locations and returns each dataset's availability, race IDs, record counts by kind, source URL and retrieval timestamp. A failed request is an explicit unavailable source, not an empty polling dataset.

| Dataset ID | Office / cycle | Source |
|------------|----------------|--------|
| `president_2024` | President, 2024 | [CSV](https://www.electoral-vote.com/evp2024/Pres/pres_polls.csv) |
| `senate_2024` | Senate, 2024 | [CSV](https://www.electoral-vote.com/evp2024/Senate/senate_polls.csv) |
| `senate_2026` | Senate, 2026 | [CSV](https://www.electoral-vote.com/evp2026/Senate/senate_polls.csv) |

These are an explicit supported catalog, not a claim that a 2028 presidential dataset exists. Future datasets need a reviewed catalog entry and format verification. Each download is bounded to 2 MiB and 10,000 records, with a 15-second timeout, redirect rejection, request coalescing and a five-minute cache. No caller-supplied network address is accepted.

## What a record means

The same file can change meaning during an election cycle. The November 14, 2026 inspection found historical polls mixed with election results in the 2024 files, while the current 2026 Senate file contained election calls and an uncalled race.

| Record kind | Recognition / treatment |
|-------------|------------------------|
| `poll` | A pollster-labeled observation; eligible for averaging only when both D/R shares are present |
| `historical_result` | An `Election YEAR` label; its referenced year can differ from the dataset cycle; excluded from polling averages |
| `election_call` | A `Called for ...` label; a reported call, not a fresh poll or certification; excluded from averages |
| `uncalled` | An explicit uncalled/too-close label; excluded from averages |
| `unknown` | A non-poll estimate/forecast/result-like label; retained for inspection and excluded from averages |

The classifier follows the source's label conventions, not independent pollster certification. Unrecognized ordinary pollster names retain `poll` classification; the exact label remains inspectable. Header or structural drift is rejected rather than guessed.

Regular and special Senate races retain separate IDs, such as `NE` and `NE-special`. They never enter the same average. Missing records mean `no_records_as_of`, not proof that a state had no election. Election calls, prior results and unknown rows remain available through `get_state_polls`.

Blank percentage fields remain null. In particular, an absent independent share is not treated as zero. The CSV does not identify candidate matchups, sample sizes or margins of error. Those fields remain null. D/R are the source column labels, not verified candidate party or caucus identities; independently verify Senate independents and changes in presidential nominees before making substantive party predictions. Source-era electoral-vote counts are not reused when generating a map.

## Dates, phases and freshness

Every record query, average and generated polling scenario requires an explicit `as_of` date in UTC (`YYYY-MM-DD`). Data with a source/fieldwork end date after that cutoff is excluded. Calendar phase is reported separately as `pre_election`, `election_day` or `post_election`, using the federal general-election date for the dataset cycle. A post-election phase does not imply certification or that every race has been called.

The files do not provide publication timestamps or previous revisions. An as-of query filters dates in the file retrieved today; it is **not a reconstruction of exactly what was publicly available on that historical date**. Result-row dates are source markers, not authoritative election or certification dates. Polls ending before a cutoff may have been released afterward. A result-only replacement file cannot reconstruct polling observations it no longer contains.

`get_poll_average` reproduces the site's [documented method](https://www.electoral-vote.com/evp2026/Info/map-algorithm.html): select the latest eligible poll by its fieldwork midpoint, then equally average distinct poll rows whose midpoints lie within the preceding seven days, inclusive. The latest midpoint anchors the window even when that cluster is old. Exact duplicate rows are removed and counted; different observations from the same pollster retain equal weight. The [polling FAQ](https://www.electoral-vote.com/evp2026/Info/polling-faq.html) identifies the fieldwork midpoint, rather than release date, as the ordering date.

Freshness is independent: `age_days` is the difference between `as_of` and the latest included fieldwork end. `max_age_days` defaults to 30. Results report `fresh`, `stale` or `no_usable_polls`, the exact contributing records, other record counts, and the kinds on the latest visible source date. A polls-only summary can coexist with a later election result; it is not presented as the current election outcome.

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

The initial polling extension run is recorded in [polling validation](validation/polling-checks.json), including dataset counts, source timestamps, generated map and schema/tool check results. The original map-only evidence in the main README remains a record of version 0.1.0; rerun validation commands for current results.
