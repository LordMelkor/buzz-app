# ODP fixture

`odp-odfpy.odp` is a presentation package produced by odfpy 1.4.1 on 2026-11-09.
It was not exported by LibreOffice or replayed in a desktop presentation
application. Regenerate it with:

```sh
uv run --with odfpy==1.4.1 python src/bundled/file-viewer/fixtures/office/odp-generate.py
```

The fixture includes a master page with a 10×7.5 inch layout; common and
automatic inherited styles; title/body text, a styled span and hyperlink,
bullets and a line break; a modifier/equation-based enhanced path and a preset
arrow; a translated group; embedded PNG and explicit remote image; a table with
a merged header; a packaged ODF chart; speaker notes; and a hidden middle page.
Page names deliberately differ from their sequence.

The original chart in this fixture has a title but no plot or saved data, so the
reader reports it as unsupported. Saved ODF chart range coverage is in `odf-
charts-README.md`. Affine transforms that include shear are approximated by the
rotation/flip/scale supported by the shared slide model. ODF enhanced geometry
interprets arithmetic and path commands with bounded evaluators; an unsupported
or invalid path falls back to the shape rectangle and retains its text.
