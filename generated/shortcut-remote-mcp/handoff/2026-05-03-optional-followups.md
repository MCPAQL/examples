# Optional follow-ups (only if you want them)

Three things that *could* be done in the next session but aren't required to make the brightness binding work. None of these block anything; pick whichever feels right.

---

## 1. Maybe: stage and commit the 2026-05-02 → 03 changes

Today's session made substantial uncommitted changes on `feature/shortcut-remote-jit-adapter`. If you want a clean commit boundary before doing more work, here's the diff summary you'd capture in the message.

### What changed

**Architecture** (one-process consolidation)
- Sidecar (`sidecar/index.js`) retired — keystroke synthesis + shell dispatch + Open-HUD now live in `adapter/src/server.js`. Sidecar source kept in repo as historical reference; not wired.
- Sidecar launchd plist booted out and renamed `~/Library/LaunchAgents/org.mcpaql.shortcut-remote-sidecar.plist.retired-2026-05-02`.
- Menu-bar Kill Switch app (`~/Applications/Shortcut Remote Kill Switch.app`) functionally replaced by HUD's Server panel; still on disk, not running, can be deleted.

**MCP transport**
- stdio → streamable HTTP (stateful sessions, `randomUUID` per session). Multiple Claude Code sessions can connect concurrently.
- New endpoint mounted at `POST /mcp` on the existing HUD HTTP server.
- `~/.claude.json` updated: `shortcut-remote: { type: "http", url: "http://127.0.0.1:47832/mcp" }` (backup at `~/.claude.json.bak-*`).

**State + ops added to the adapter**
- Layer state (1–4) advanced by K2; broadcast as `layer_change`. New ops: `get_current_layer`, `set_current_layer`.
- Wheel state (signed counter) updated by CW/CCW ticks; broadcast as `wheel_state`. New ops: `get_wheel_value`, `set_wheel_value`, `reset_wheel_value`.
- Wheel binding (mutable; `null` = AI mode); broadcast as `wheel_binding_change`. New ops: `get_wheel_binding`, `set_wheel_binding`. Accepts three action shapes: `{mac_code, modifiers, label}`, `{applescript, label}`, `{command, args, label}`.
- Annotation overlay broadcast (`annotation` event). New op: `post_annotation`.
- Voice command pipeline: `POST /voice-command` HTTP endpoint, `submit_voice_command` MCP op, `voice_command_received` / `voice_command_done` events. Spawns `claude -p <prompt> --allowedTools "mcp__shortcut-remote__mcpaql_read mcp__shortcut-remote__mcpaql_update"`.
- Server controls: `POST /control/{restart,stop,disable}` and `GET /control/status`.
- SuperWhisper recordings-folder watcher (`startSuperWhisperWatcher()`) — replaces the per-mode `script` field SuperWhisper 2.13 dropped. Filters on `modeName === "Shortcut Remote command"`. Polls `meta.json` for up to 30s for `rawResult` to populate.

**HUD**
- Stable-height key cards (no jitter when layer changes binding text).
- Layer banner with flash-on-change.
- K1/K2/K7/K8/K11 rendered as "special" (pinned-purple or layer-action-blue) with hardwired labels regardless of layer.
- "AI Dial" panel: wheel value display, binding label (clears or shows current), annotation overlay, voice-command test input.
- Server panel: Restart / Stop / Stop & disable buttons, focus-notifications opt-in.
- Reload-on-K1 (when HUD already open, K1 sends `hud_focus` event over WS instead of opening a duplicate tab).

**New files**
- `tools/k11-voice-trigger.sh` — start/stop toggle for SuperWhisper voice-command mode (uses `superwhisper://` URL scheme + `Opt+Cmd+3` keystroke for stop).
- `tools/wheel-brightness-step.sh` — *(planned, not yet written; see `2026-05-03-next-brightness-via-betterdisplay.md`)*.
- `~/Library/LaunchAgents/org.mcpaql.shortcut-remote.plist` — launchd job for the adapter.
- `handoff/` folder with this and other handoff notes.

**Hardwired actions**
- K1: open / focus HUD (uses `hud_focus` WS broadcast if a HUD tab is connected, else `open URL`).
- K2: advance layer.
- K7: SuperWhisper default mode (Opt+Cmd+3).
- K8: Escape.
- K11: triggers `tools/k11-voice-trigger.sh` for the voice-command pipeline.

**Defensive fixes**
- `synthesizeKey` defaults `modifiers` to `[]` when missing (an LLM-issued binding without modifiers crashed the daemon mid-session via the HID event handler).
- `performAction` wrapped in try/catch; wheel-binding dispatch self-heals (clears the binding + annotates the HUD) on dispatch error.
- Process-level `uncaughtException` and `unhandledRejection` handlers — log loudly but stay alive so the HID handle isn't repeatedly grabbed and released by launchd respawns.

**Memory (in `~/.claude/projects/-Users-mick-Developer-Organizations/memory/`)**
- `mcpaql_adapter_philosophy.md` — adapters are capable layers, not dumb dongles
- `hotkey_convention_f_keys_above_f15.md` — claim F16-F20 for global hotkeys

### Suggested commit shape

If you're going to commit, probably worth splitting into a few logical commits rather than one giant one:

1. Streamable-HTTP transport + sidecar inlining + launchd plist + control endpoints
2. Layer + wheel state + bindings + annotation broadcast (the LLM input/output surface)
3. Voice command pipeline (HTTP endpoint, claude-p spawn, allowedTools)
4. SuperWhisper recordings-folder watcher (replaces 2.13's removed script field)
5. K11 trigger script + helper tools
6. HUD overhaul (stable height, special keys, AI Dial panel, server controls, focus notifications)
7. Defensive hardening (modifiers default, try/catch, uncaught handlers)
8. Handoff docs

Or, if a single commit is fine for your taste, lean on `git diff --stat` + the bullet list above.

---

## 2. Maybe: file the unfinished vision as design issues

Several things were discussed during today's session but never built. They aren't blockers for anything, but they're meaningful enough that having them as tracked issues would prevent re-deriving them later. None require code right now — just well-written GitHub issues.

### Configuration-tool redesign (rename + scope)

The "Kill Switch" app and its naming was officially obsolete after the HUD took over server control. Mick said the renaming should reflect that it's now a *configuration* tool, not a kill switch. Layered modes, AI-controlled layers III/IV, multiple input-routing presets, app-context-aware passthrough. The HUD is the canvas.

### Floating / center-screen HUD

Like XP-Pen's center-screen popup that appears on press and fades out. Useful when AI-bound keys have semantic descriptions too long for the existing keypad cell. Sits alongside the always-on browser HUD as an alternative display mode.

### Layered AI semantics for K3-K11 and the wheel

Layers I/II already mirror XP-Pen's bindings. Layers III/IV are mostly empty. The vision: per-layer wheel/key semantics that can be re-bound by voice ("on layer III, make K3 paste with formality matching the wheel value"), with the LLM holding the per-layer state.

### Per-key `set_key_binding` (matching the wheel pattern)

`set_wheel_binding` exists; per-key dynamic binding doesn't yet. With it, the LLM could reconfigure individual keys via voice. Constraint: K1/K2/K7/K8/K11 stay hardwired across layers (Mick's muscle-memory promise). K3-K6, K9-K10 are fair game.

### Configurable brightness step + per-action state

Hardcoded 5% in `wheel-brightness-step.sh`. Could be configurable via env var or — more ambitious — per-binding state stored in the adapter so the LLM can tune ("make the steps finer, 2%").

### `set_wheel_binding` LLM hints in `VOICE_SYSTEM_PROMPT`

The system prompt knows about volume / mute / music but not brightness via BetterDisplay. After the brightness binding lands, add a recipe block so future voice commands can rebind brightness without re-explaining.

### Packaging as `npx @mcpaql/adapter-shortcut-remote`

Eventually this should be installable as `claude mcp add --transport http shortcut-remote -- npx -y @mcpaql/adapter-shortcut-remote --serve`. Includes auto-write of the launchd plist on first run, `--install` and `--uninstall` subcommands. Mick endorsed this direction on 2026-05-02 ("this is genuinely an MCP-AQL adapter you install and have a working keypad").

### Voice-command stop-early UX

K11 toggle works for start/stop, but if the user wants to *cancel* a recording (don't send to /voice-command at all), there's no path right now. Could be a long-press on K11, or a separate key, or a HUD button.

### "Repeat last voice command" / "show last response"

After a voice command lands, currently no way to inspect what Claude actually did beyond the HUD overlay (which fades). Worth a simple "show last voice command response" UI in the HUD or an MCP op.

---

## 3. Maybe: cross-link the two issues filed today

Both relate to the broader MCPAQL roadmap and would be helpful to surface from this README / HANDOFF for context.

| Issue | Where | What |
|---|---|---|
| `MCPAQL/adapter-generator#30` | https://github.com/MCPAQL/adapter-generator/issues/30 | feat: optional OAuth scaffolding for generated streamable-HTTP adapters. Codifies the loopback-vs-hosted trust rule we worked out during the streamable-HTTP conversion: bind 127.0.0.1 → no auth needed; bind 0.0.0.0 / hosted → OAuth required. References DollhouseMCP#1883 as related-but-distinct. |
| `MCPAQL/adapter-studio` | https://github.com/MCPAQL/adapter-studio | New private repo created with vision README. Self-service web studio that wraps `adapter-generator` — point at an API, generate an adapter, run locally (free) or have us host it (paid tier). The OAuth toggle issue above feeds into this when the hosted tier ships. |

Worth referencing in the project root's README under a "Related work" section, or in the new HANDOFF doc — either makes them findable from this adapter back to the broader org context.

---

*All of the above are optional. The next session can ship the brightness binding without touching any of this — it's just here so we don't lose the threads.*
