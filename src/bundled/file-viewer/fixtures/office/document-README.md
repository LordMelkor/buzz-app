# Rich document fixtures

Generated locally on 2026-11-09 with python-docx 1.2.0 and odfpy 1.4.1. All visible content and the directly specified 68-byte 1×1 PNG are synthetic; no external document or image was downloaded.

- `document-rich.docx`: python-docx produced headings, runs, table merges, a picture, header and standard package/styles/theme. The generator then added OOXML numbering, fields, hyperlinks, bookmarks, text boxes, tracked changes, equations, footnotes/endnotes and a cached chart with their relationships/content-type overrides.
- `document-rich.odt`: odfpy produced the complete structure, styles, lists, merges, notes, pictures and text box. ODF chart/math adversarial cases are generated separately inside the tests.
