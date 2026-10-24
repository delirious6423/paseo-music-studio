# Changelog

0.5.1 is the first public GitHub source snapshot. Earlier versions describe local milestones,
not published releases. No version is published to npm.

## 0.5.1

- Make the MiniMax example directly pasteable into Settings, validate both example profiles in pure CI,
  document all five required model files and engine/download sources, and check whitespace in the full source tree.
- Show MiniMax engine stages, frame budgets, completed per-song windows and elapsed/run-deadline information
  without inventing an overall percentage. Preserve window counters across graph rebuilds and freeze the clock
  before library import. Profile deadlines can exceed one hour within Node’s timer representation.
- Make replay mode and its clear action visible; validate one LM song per replay before launch.
- Show native batch output totals, action-local validation errors and model-specific guidance.
- Prevent wrong-active-model recipe loading, fix model highlighting/default resets, and cancel audio loading
  when entering multi-select. Clear stale generation errors when the recipe changes.
- Record measured WAV/MP3 duration separately from requested seconds; label unmeasured legacy tracks honestly.

## 0.5.0

- Add a shell-free local MiniMax Music 3 adapter: lyrics/instrumental mode, editable native controls,
  independent LM/noise seeds, native batching, MP3 and WAV16/24/32-bit-float output, and song-code replay.
- Preserve original formats and MIME types; pass long requests through private owned files rather than argv.
- Validate native manifests before import; retain failed-save queues and report unreadable partial outputs.
- Preserve safe-integer seed offsets across native/outer batches; replace the artificial step ceiling with
  the engine’s integer representation guard.

## 0.4.0

- Add streamed original-audio ZIP downloads and confirmed recoverable batch deletion for up to 20 tracks.
- Harden download ownership/expiry, structural audio validation, save recovery, staging cleanup and stale UI actions.
- Reduce idle polling while retaining completion, recovery and other-client refreshes.
- Collapse saved generation prompts below track actions.

## 0.3.1

- Support full Stable Audio duration bounds and chunked full-track playback assembly.

## 0.3.0

- Add sequential 1–20-take batches, prompt variations, numbered titles and cancellation.

## 0.2.0

- Introduce model-agnostic command profiles, explicit first-run setup and portable disposable-VM tests.
- Adopt the Paseo Music Studio name while retaining the `paseo-music` runtime identity.
