# Media viewer

Reads the PDFs, Markdown, code, text and CSV files shared in a conversation, beside the thread.

## Getting started

1. Turn it on in **Settings → Plugins**.
2. Choose a shared file's card to open it beside the conversation. The card's download button still saves the file.
3. Page through a PDF with ‹ and › or the arrow keys, and zoom with **−**, **+** or **Fit to width**. Choose **Copy text** to copy a text file.

---

Only files shared in the current community open. Text files open up to 20 MB and PDFs up to 100 MB, laid out to the first 1,000 pages. Spreadsheets in CSV or TSV show the first 5,000 rows and 200 columns, up to 50,000 cells. Only the first 2,000,000 characters of a text file are shown (Copy text copies it all), and Markdown over 500,000 characters shows as plain text. Markdown follows the same rules as Notes: no raw HTML, and images show as their alt text.

Other plugins can open a shared file in the viewer with the target `buzz-file:?url=<url>&name=<name>&mime=<mime>` (`name` and `mime` are optional). The viewer claims file cards and targets at order 50, so a plugin that registers its own renderer or panel for the same files at the default order takes them over.

PDFs are drawn with [PDF.js](https://mozilla.github.io/pdf.js/), loaded the first time a PDF opens.
