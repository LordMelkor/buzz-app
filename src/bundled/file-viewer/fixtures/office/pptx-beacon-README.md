# Beacon presentation QA regression

`pptx-beacon-launch-review.pptx` is an unchanged copy of the fictional Beacon
QA deck supplied on 2026-11-09, generated with python-pptx. It is not a
PowerPoint or LibreOffice export. SHA-256: `669f387e12fd6ddc4f938f91c7908d90af3767bf7c125412b3dec5812b5ec365`.

`pptx-beacon-generate.py` preserves the original `make-office.py` deck function,
with standalone imports and the output name changed to this fixture's name:

```sh
uv run --with python-pptx python src/bundled/file-viewer/fixtures/office/pptx-beacon-generate.py
```

Slide 2 has three 2.9×1.2in chevrons with default adjustment `50000`, default
0.1in left/right body margins and centered vertical alignment. Their text
rectangle excludes 0.6in on both horizontal sides, so the final text insets
are 0.7in (50.4pt). The regression asserts the parsed shape model and Copy
text at the reader boundary; browser visual acceptance is separate.

Sources:

- [ECMA-376 DrawingML `rect` (§20.1.9.22)](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.rectangletype)
- [Pinned Apache POI preset definitions](https://github.com/apache/poi/blob/338882ac8898df5c13a7d15f533204c5dd8607d6/poi/src/main/resources/org/apache/poi/sl/draw/geom/presetShapeDefinitions.xml)
- [ODF 1.3 text areas (§19.220)](https://docs.oasis-open.org/office/OpenDocument/v1.3/os/part3-schema/OpenDocument-v1.3-os-part3-schema.html#attribute-draw_text-areas)
