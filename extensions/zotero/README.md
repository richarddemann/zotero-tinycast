# Zotero

Search your Zotero library, open PDFs, and copy citations, BibTeX and citation keys.

Reads `zotero.sqlite` with the system `sqlite3` rather than a WebAssembly SQLite, so it stays fast on
large libraries and works in [Tinycast](https://tinycast.dev) as well as Raycast.
Citation actions use Zotero's local API: keep Zotero running and turn on *Settings → Advanced → Allow
other applications on this computer to communicate with Zotero*.

See the [repository README](../../README.md) for installation, shortcuts and troubleshooting.
