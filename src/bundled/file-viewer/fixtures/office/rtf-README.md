# RTF fixtures

`rtf-textutil.rtf` is a native macOS `/usr/bin/textutil` export made on 2026-11-09 from this UTF-8 HTML:

```html
<!doctype html><html><head><meta charset="utf-8"></head><body><p>Native export café — Ω 😀</p><p><b>Bold text</b> <i>Italic text</i> <u>Underlined text</u></p><p><a href="https://example.com/report">Read report</a></p><table><tr><td>North</td><td>42</td></tr><tr><td>South</td><td>17</td></tr></table><p>After the table.</p></body></html>
```

It was produced with `textutil -noload -convert rtf -output rtf-textutil.rtf source.html`. It exercises native field grouping, escaped paragraph breaks, font/control destinations, CP-1252 escapes, surrogate pairs and two table rows. The adjacent `legacy-textutil.doc` was converted from this RTF by textutil.

`rtf-pictures.rtf` and `rtf-pictures-binary.rtf` are minimal hand-authored valid RTF documents, not application exports. Each embeds a 1×1 PNG, a JPEG made from that PNG by macOS `sips -s format jpeg`, and an object destination that must be omitted. The first uses hexadecimal payloads; the second uses raw `\binN` payloads. Tests also supply small hand-authored RTF strings to exercise Unicode fallback counts and malformed inputs directly.

`rtf-hidden-budget.png` is a generated, valid 4096×4096 black, 1-bit grayscale PNG (2,116 bytes). It has a CRC-checked IHDR, a zlib-compressed IDAT containing 4096 scanlines of filter byte 0 plus 512 zero bytes, and IEND. macOS `sips` decoded it to JPEG on 2026-11-11. Each picture occupies the existing 16 Mi pixel allowance; four fill the 64 Mi package allowance. The RTF tests wrap four copies in hidden/deleted groups before visible copies, proving hidden content does not consume the visible picture budget without lowering the production limits.
