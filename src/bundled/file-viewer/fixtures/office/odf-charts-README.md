# OpenDocument chart fixtures

`charts-odfpy.ods` and `charts-odfpy.odp` were generated with odfpy 1.4.1 on
2026-11-09 from synthetic values authored for these tests. Regenerate with:

```sh
uv run --with odfpy==1.4.1 python src/bundled/file-viewer/fixtures/office/odf-charts-generate.py
```

These are real ODF packages produced by odfpy, with embedded chart packages,
chart styles, a local chart table, and a parent table named `Sales Q1`. They
were not exported by or visually replayed in LibreOffice. Parent values are
Q1/Q2/Q3 and 12.5/21/0; the chart cache deliberately differs: Cache1/Cache2/Cache3
and 91/92/93. This distinguishes authoritative local data from parent fallback.

Tests at `openOffice` remove the local table and change addresses to the parent
cells, preserving the producer's package structure. Further variants exercise
supported chart families, missing cached formula values, external/missing
references, and billion-row compact repeats. No formula is evaluated and no
external workbook is fetched.

Each range resolves its table by name. Local tables override parent tables with
the same name; an unrelated local table does not block an explicit parent
reference. Additional variants retain the local table while referencing parent
`Metrics`, and apply inherited percentage cell styles from `styles.xml`.

The format tests follow the ODF 1.3 specification:
[§19.473.3](https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part3-schema/OpenDocument-v1.3-os-part3-schema.html#attribute-style_data-style-name)
assigns a data style to table-cell and chart styles;
[§16.29.10](https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part3-schema/OpenDocument-v1.3-os-part3-schema.html#element-number_percentage-style)
defines percentage styles. Explicit axis formats also respect
[chart:link-data-style-to-source](https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part3-schema/OpenDocument-v1.3-os-part3-schema.html#property-chart_link-data-style-to-source).
These tests cover named styles and parent-style inheritance, not conditional
`style:map` expressions or arbitrary number-format rendering.
