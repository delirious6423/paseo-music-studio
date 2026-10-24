# Third-party software and model terms

Paseo Music Studio’s original plug-in source and documentation are licensed under [MIT](LICENSE).
That license does not replace any host, dependency, engine, model, tokenizer or output-related terms.
This source distribution does not contain model weights, engine binaries, generated music or `node_modules`.

## Host and JavaScript dependencies

Paseo supplies the host-facing runtime modules; development dependencies and their exact resolutions
are recorded in `package.json` and `package-lock.json`. They are installed separately, not vendored here.

| Project | Terms to review |
| --- | --- |
| [Paseo and its plug-in SDK](https://github.com/getpaseo/paseo) | Apache-2.0 for Paseo’s own code; incorporated third-party components retain their licenses. See its [license](https://github.com/getpaseo/paseo/blob/main/LICENSE). |
| [React](https://github.com/facebook/react) and [React Native](https://github.com/facebook/react-native) | MIT |
| [TanStack Query](https://github.com/TanStack/query) | MIT |
| [Zod](https://github.com/colinhacks/zod) | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0; development tooling |
| [tsx](https://github.com/privatenumber/tsx) | MIT; development tooling |

Transitive dependencies have their own notices. If you redistribute installed dependencies or a bundled
build, collect and preserve the notices for that exact artifact; this table is not a replacement for them.
Paseo and engine/model names identify compatibility, not affiliation or endorsement.

## Separately installed engines and models

- [sa3.cpp](https://github.com/betweentwomidnights/sa3.cpp): MIT engine source. Its dependencies and
  Stable Audio weights are separate. Review the exact [Stable Audio distribution](https://huggingface.co/thepatch/stable-audio-3-medium-GGUF)
  and [Gemma terms](https://ai.google.dev/gemma/terms) for the text encoder. Do not assume the engine’s MIT license covers weights.
- [minimaxmusic.cpp](https://github.com/ServeurpersoCom/minimaxmusic.cpp): MIT engine source. Review its
  dependency notices and the original [MiniMax Music 3 model](https://huggingface.co/MiniMaxAI/MiniMax-Music3),
  its [model license](https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE), and the chosen
  [GGUF distribution](https://huggingface.co/Serveurperso/MiniMax-Music3-GGUF). No model-use or commercial-use
  permission is granted by this plug-in.

You are responsible for obtaining compatible software/weights and complying with their current terms.
Generated music is not guaranteed unique, copyrightable, non-infringing or cleared for commercial use.
Screenshots use synthetic fixture data, not redistributed model outputs; see [screenshot provenance](docs/SCREENSHOTS.md).
