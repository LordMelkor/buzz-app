# Native iWork preview fixtures

The native source files were generated with Pages and Keynote 14.5 on 2026-11-09. Both packages' `Metadata/BuildVersionHistory.plist` records `M14.5-7045.0.17-4` (observed directly).

The committed `iwork-native.pages` and `iwork-native.key` retain the native `Index/*.iwa`, `Metadata/*` and `preview*.jpg` files. They were re-zipped using stored entries with `Data/` omitted, as requested, to avoid committing Apple theme assets. The IWA and JPEG bytes were not rewritten.

Independent `/usr/bin/sips -g pixelWidth -g pixelHeight` measurements of the retained `preview.jpg`:

| Fixture | Width | Height | Preview bytes |
| --- | ---: | ---: | ---: |
| Pages | 790 | 1024 | 20,213 |
| Keynote | 1024 | 768 | 24,671 |

SHA-256 of the committed packages:

- Pages: `289a647b26f2ce3daf5cd8266750eee6a05b1c05da1f80c5449f05fe0a34f7ad`
- Keynote: `d82aca193406afd60bae971dbd2f77dd74bdf5fbef96ff4c0e1a98b7998006f8`

These fixtures exercise native preview extraction, not IWA document rendering. Numbers parsing and fallback use the separately owned Numbers fixture and loader tests.
