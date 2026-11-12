# Built-in PowerPoint table styles

The data in `../../office/pptx-table-styles.ts` is derived from LibreOffice,
under MPL-2.0; see `../../office/pptx-table-styles.LICENSE`. This is DrawingML
table style data; ECMA's `presetTableStyles.xml` is SpreadsheetML instead.

To reproduce its three compact arrays, download the pinned C++ source URL
documented in `pptx-table-styles-generate.py`, then run that script with the
source path and an output JSON path. It compiles a temporary compatibility
shim using `clang++`, extracting all 74 styles without linking LibreOffice.
Its output is `[PARTS, TEMPLATES, IDS]`. The data keeps scheme colours and
transformations; theme colours are resolved when opening a presentation.

The generated 22 templates cover 11 families: two Themed, three Light, four
Medium and two Dark styles. Ten families have seven variants (unaccented and
Accent 1–6); Dark Style 2 has four paired variants. The generated DOMs are
internal reader inputs, cached by known GUID; package definitions remain
authoritative, including empty definitions.

The real Beacon deck's fourth slide exercises a missing built-in definition.
Its full fixture and generation script are shared with the shape regressions.
