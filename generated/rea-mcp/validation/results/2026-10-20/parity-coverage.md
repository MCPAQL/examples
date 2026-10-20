# REA adapter parity coverage (2026-10-20)

The stage-1 REA adapter against raw REA 6.5.0 (Ghidra 12.1.4), on the same calls, in an isolated macOS VM. This extends the 2026-10-18 run, which exercised 23 operations, to 119 of the adapter's 131. The suite, fixtures and method are in [`../../README.md`](../../README.md) and [`../../parity-suite.mjs`](../../parity-suite.mjs).

- `parity-report.json`: native profile. `parity-report-app.json`: app-bundle profile, which covers 5 operations.
- `parity-sessions.json`: what setup compared across arms.
- `parity-operations.tsv`: one row per operation, with its group, profile, result and note.

Local paths are shortened to `~`.

## Results

| Group | IDENTICAL | STRUCTURAL_PARITY | Same in session | SAME_ERROR | Skipped | Total |
|---|---|---|---|---|---|---|
| Native session | 49 | 1 | | 9 | | 59 |
| File formats | 11 | | | 6 | | 17 |
| fake-device (recorded fixture) | 2 | | | 4 | | 6 |
| Compare and compose | 11 | | | 2 | | 13 |
| Bundles and unknowns | 6 | | | 1 | | 7 |
| Client discovery | 1 | | | 4 | | 5 |
| App bundle | 4 | 1 | | | | 5 |
| CREATE (sandboxed) | 3 | | | 3 | | 6 |
| Session | | | 1 | | 1 | 2 |
| Not run | | | | | 11 | 11 |
| **All** | **87** | **2** | **1** | **29** | **12** | **131** |

There were no `DIVERGENT` results and no one-sided errors.

- **`STRUCTURAL_PARITY`**:
  - `binary_session` reports each REA process's own pid, start time and connected client, which here is the harness on one arm and the adapter on the other.
  - `extract_artifact` names a fresh random output directory.
  - Both match once those keys are masked.
- **Same in session:** `open_binary` is called on both arms in setup, and its results match (`parity-sessions.json`).
  - The two Evidence bundles each arm exported in setup are byte-identical across arms.
  - `close_binary` is called in teardown but not compared.
- **fake-device** marks the capture-style fixtures: a HAR, a pcap, a sigrok recording, an ELF core, and REA's own browser-scenario schema example. They are hand-built stand-ins. Nothing was captured from a device, so these are not real-device parity results.
- **CREATE** operations wrote only into a per-arm sandbox that the suite deletes. A check after the run found no new files outside the VM's evaluation directory.

## SAME_ERROR

Both arms failed, and the adapter passed REA's own error through unchanged. This shows faithful error passthrough, not that the operation works, so it is counted separately from `IDENTICAL`.

| Cause | Ops | Operations |
|---|---|---|
| The Ghidra provider does not declare the operation | 9 | `comment`, `inline_comment`, `list_bookmarks`, `current_address`, `current_procedure`, `current_document`, `next_address`, `prev_address`, `get_navigation_context` |
| A decoder that needs Linux | 10 | TShark (`inspect_packet_capture`, `inspect_packet_fields`), sigrok (`decode_signal_recording`, `inspect_signal_decoders`), Binwalk or Unblob (`inspect_firmware_regions`, `extract_firmware`), Wakaru on Linux x64 (`recover_javascript_sources`), pwntools on Linux x64 (`inspect_binary_layout`, `inspect_recorded_crash`), the EVM profile on Linux x64 (`inspect_evm_interface`) |
| A tool that is not installed | 4 | WABT (`inspect_wasm_artifact`), TShark and capinfos (`inspect_pcap_client`, `inspect_pcap_capture`), apktool (`inspect_apktool_client`) |
| Negative input or a schema example REA rejects | 6 | `inspect_dart_aot` and `identify_flutter_build` (a Go ELF, not an APK), `project_android_application_graph` and `project_harmony_application_graph` (a Mach-O inventory), `export_web_scripts` (a HAR, not a browser capture), `trace_web_source_location` (the example's manifest path does not exist) |

## Not run

| Operations | Needs |
|---|---|
| `inspect_android_package`, `search_android_classes`, `inspect_android_class`, `inspect_android_method`, `trace_android_references` | An APK fixture and the jadx-headless-mcp 0.7.1 JAR |
| `decode_android_resources` | An APK fixture and apktool |
| `compare_wasm_interfaces` | Two `inspect_wasm_artifact` records, so WABT |
| `import_managed_reconstruction` | A managed (.NET) assembly and decompiler output |
| `reconcile_javascript_runtime`, `compare_process_captures`, `correlate_static_and_runtime` | Evidence from browser, Electron or process-capture tools, all of which stage 1 excludes |

## Found along the way

- **`TMPDIR`**: the adapter did not pass it through, so REA under the adapter wrote its byte snapshots under `/tmp`. It showed up as a codesign output difference in `inspect_signature` and was fixed in #62.
- **Harness**: `SAME_ERROR` and suite-level volatile keys were added to `mcpaql-parity` in MCPAQL/tools#48.
