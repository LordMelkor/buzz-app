# Legacy office fixtures

These are binary CFB documents, not parser-created stand-ins.

- `legacy-textutil.doc` was exported on macOS using `/usr/bin/textutil -convert doc -output legacy-textutil.doc rtf-textutil.rtf` on 2026-11-09. The input is the adjacent native RTF export. It covers Unicode text, paragraphs, a hyperlink field's displayed result, and table cell/row marks. It contains one uncompressed Unicode piece.
- `legacy-poi-fields.doc` is Apache POI's [test-data/document/test-fields.doc](https://github.com/apache/poi/blob/trunk/test-data/document/test-fields.doc), Git blob `2a6c51642cbf9942f39374ba0d0e61da453f99bd`. It contains a compressed ANSI piece, a CREATEDATE field, and separate footnote, endnote, comment, header and textbox stories. The reader keeps only main-story text and field results.
- `legacy-poi-basic.ppt` is Apache POI's [test-data/slideshow/basic_test_ppt_file.ppt](https://github.com/apache/poi/blob/trunk/test-data/slideshow/basic_test_ppt_file.ppt), Git blob `af16393f44e0f315c212b60392e2bae2130987bc`. Its metadata identifies Microsoft Office PowerPoint as the producer. It has two slides, notes, master text, and multiple incremental saves; scanning the whole stream would include stale text and masters.
- `legacy-poi-order.ppt` is Apache POI's [test-data/slideshow/incorrect_slide_order.ppt](https://github.com/apache/poi/blob/trunk/test-data/slideshow/incorrect_slide_order.ppt), Git blob `6aead5df979db755c7884fc48cb1277351dd7685`. Its slide records are not in presentation order.

- `legacy-poi-password.ppt` is Apache POI's [test-data/slideshow/Password_Protected-hello.ppt](https://github.com/apache/poi/blob/trunk/test-data/slideshow/Password_Protected-hello.ppt), Git blob `3bbab4d5c0da8cf7ceaf8ebbf737dd98bb4439a8`. It exercises the encrypted CurrentUser header rather than an OOXML EncryptedPackage stream.

Apache POI fixtures were retrieved through GitHub's contents API on 2026-11-09. Their upstream license and notices are retained in `legacy-APACHE-LICENSE.txt` and `legacy-APACHE-NOTICE.txt`.

Tests mutate copies through CFB only to model corruption/encryption; those mutations are not claimed to be native exports.

The DOC reader preserves cells in order and recognizes consecutive cell marks as row ends. It does not interpret PAPX table properties, formatting, or object data; complex or multiline table layout can be approximate.
