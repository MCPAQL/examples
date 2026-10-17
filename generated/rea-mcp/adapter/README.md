# Rea MCP

Generated MCP-AQL adapter package for REA (Reverse Engineer Anything), rea-agents 6.5.0: static analysis stage.

## Supported Endpoints

- READ: inspect_native_load_image, inspect_native_data_type, inspect_native_instruction, resolve_native_call_targets, address_name, comment, current_address, current_procedure, current_document, inline_comment, list_bookmarks, list_documents, list_names, list_procedures, list_segments, list_strings, next_address, prev_address, procedure_address, procedure_assembly, procedure_callees, procedure_callers, procedure_info, read_function_instructions, search_bytes, read_bytes, address_to_file_offset, procedure_references, procedure_pseudo_code, resolve_containing_procedure, search_procedures, search_strings, xrefs, inspect_native_dispatch_metadata, get_objc_classes, get_objc_protocols, batch_decompile, get_call_graph, analyze_swift_types, find_xrefs_to_name, binary_overview, analyze_function, inspect_native_api, trace_feature, trace_call_path, trace_native_ui_action, trace_native_values, inspect_macho, inspect_signature, inspect_plist, list_architectures, demangle_swift, inspect_pe_resources, inspect_binary_layout, inspect_recorded_crash, inspect_analysis_view, inspect_artifact, decode_interface_builder, inspect_keyed_archive, inspect_asset_catalog, trace_dylib_resolution, inspect_evm_interface, inspect_go_binary, inspect_rust_binary, inspect_wasm_artifact, compare_wasm_interfaces, inspect_sqlite_database, inspect_packet_fields, inspect_packet_capture, inspect_signal_decoders, decode_signal_recording, inspect_managed_artifact, inspect_managed_members, inspect_managed_native_boundaries, inspect_android_package, search_android_classes, inspect_android_class, inspect_android_method, trace_android_references, inspect_apktool_client, decode_android_resources, inspect_pcap_client, inspect_pcap_capture, identify_flutter_build, inspect_dart_aot, inspect_firmware_regions, compare_managed_members, verify_managed_native_boundaries, import_managed_reconstruction, project_managed_application_graph, compare_web_captures, compare_web_screenshots, analyze_javascript_application, reconcile_javascript_runtime, inspect_electron_fuses, trace_application_feature, trace_javascript_semantics, compare_application_versions, compare_source_to_bundle, compare_javascript_export_shapes, build_reconstruction_obligation_ledger, evaluate_reconstruction_coverage, project_android_application_graph, project_apple_application_graph, project_harmony_application_graph, trace_web_source_location, inspect_web_network_capture, binary_session, compare_process_captures, compare_artifacts, compare_functions, compare_bundles, find_changed_behavior, build_call_path, correlate_static_and_runtime, verify_reconstruction, list_unknowns, record_unknown, update_unknown, verify_unknown_resolution, get_evidence_bundle, get_navigation_context, inspect_address_context, inspect_with_objdump
- CREATE: extract_artifact, extract_firmware, export_web_scripts, recover_javascript_sources, open_binary, close_binary, export_evidence_bundle, import_evidence_bundle

## Running

Requires Node.js 20 or newer.

On the first call, this adapter starts its upstream MCP server as a child process and keeps it running:

```bash
npx -y rea-agents@6.5.0 mcp
```

The child receives a minimal environment (the MCP SDK default) plus only the variables listed below. Its stderr goes to the adapter's stderr.

- `REA_ANALYSIS_PROVIDER` (optional): passed through to the upstream process.
- `GHIDRA_INSTALL_DIR` (optional): passed through to the upstream process.
- `JAVA_HOME` (optional): passed through to the upstream process.
- `REA_GHIDRA_STARTUP_TIMEOUT_MS` (optional): passed through to the upstream process.
- `REA_HOPPER_STARTUP_TIMEOUT_MS` (optional): passed through to the upstream process.
- `REA_MCP_INPUT_SCHEMA_PROFILE` (optional): passed through to the upstream process.
- `REA_LOG_LEVEL` (optional): passed through to the upstream process.

```bash
npm install
npm run start
```

Upstream calls follow the caller's cancellation and forward upstream progress. Optional limits:

- `MCPAQL_UPSTREAM_TIMEOUT_MS` (default 60000): per-call deadline, reset by each upstream progress notification.
- `MCPAQL_UPSTREAM_MAX_TOTAL_TIMEOUT_MS`: hard cap per call, regardless of progress; the upstream call is cancelled when it is reached.
