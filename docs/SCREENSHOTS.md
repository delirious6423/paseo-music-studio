# Screenshots

These are captures of the actual Studio component, not illustrations or AI-generated images.
They use synthetic fixture data in Chromium inside a disposable native Linux x64 VM.
No private library, real prompts, personal host addresses or generated music are included.

| Image | Scope |
| --- | --- |
| [Desktop studio](../assets/studio-desktop.png) | 0.5.1 component fixture, 1280 × 1000 CSS viewport, dark theme |
| [Phone studio](../assets/studio-phone.png) | 0.5.1 component fixture, 390 × 844 CSS viewport, dark theme |
| [MiniMax advanced desktop](../assets/minimax-advanced-desktop.png) | 0.5.1 advanced controls and explicit 1 × 2 × 3 native workload, dark theme |
| [MiniMax advanced phone](../assets/minimax-advanced-phone.png) | Same scenario in the compact light-theme layout |
| [MiniMax progress phone](../assets/minimax-running-phone.png) | Fixture stage/window counters and elapsed/run budget, compact light theme |
| [Packaged Paseo web client](../assets/studio-packaged.png) | Historical 0.4.0 actual Paseo 0.13 daemon/web client in a disposable VM; diagnostic tones, not AI music |

The 0.5.1 captures come from the final passing UI run after correcting stale validation errors.
A fixture supplies the progress text; separate parser/controller regressions validate real MiniMax log handling.
Some views are scrolled to the feature being demonstrated. PNG ancillary text/metadata is stripped for distribution.

These screenshots do not establish physical-phone, Electron-shell, Windows/macOS UI, real-GPU timing,
encoder audibility or music-quality acceptance. See [testing scope](TESTING.md).

## Reproduce

After installing the locked development dependencies, use a configured disposable native VM:

```bash
tests/ui/run.sh
```

The runner saves images and a report outside the checkout. `--update-assets` replaces the three standard
listing assets only; select the MiniMax feature captures from the run’s artifacts after review.
Do not capture the user’s live library or run the app on the everyday desktop as a fallback.
