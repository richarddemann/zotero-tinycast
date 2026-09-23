<div align="center">

<img src="extensions/zotero/assets/command-icon.png" width="96" alt="">

# Zotero for Tinycast

Search your Zotero library from [Tinycast](https://tinycast.dev) or Raycast. Open PDFs and copy
citations, BibTeX and citation keys.

</div>

![Searching a Zotero library in Tinycast](media/screenshot.png)

The Raycast Store's Zotero extension gets stuck on **Loading…** in Tinycast. Its SQLite engine runs on
WebAssembly, and Tinycast currently never finishes loading WebAssembly
([fix proposed](https://github.com/abue-ammar/tinycast/issues/1056)). This one reads your library with
macOS's own `sqlite3` instead, so it works today and opens instantly, even for large libraries.

## Install

In Tinycast, open **Settings → Extensions → Registries… → Add Registry…**, paste
`richarddemann/zotero-tinycast`, then **Search…** for "zotero" and click **Install**. You need
[Node.js](https://nodejs.org) installed, because Tinycast builds the extension on install.

To run it in Raycast instead: clone this repo, then run `npm install && npm run dev` in `extensions/zotero`.

## Features

- Search by title, author, year, journal, tag, DOI or citation key
- Filter by library, group or collection
- Open the PDF (<kbd>↵</kbd>), open it in Zotero (<kbd>⌘⇧O</kbd>), or show the item in Zotero (<kbd>⌘O</kbd>)
- Copy a bibliography entry (<kbd>⌘⇧C</kbd>), formatted with italics (<kbd>⌘⌥C</kbd>), or paste it (<kbd>⌘⇧V</kbd>)
- Copy an in-text citation (<kbd>⌘⇧I</kbd>), BibTeX (<kbd>⌘⇧B</kbd>) or the citation key (<kbd>⌘.</kbd>)

Citation and BibTeX actions need Zotero running with *Settings → Advanced → Allow other applications
on this computer to communicate with Zotero* turned on. Choose your citation style in the extension's
preferences. Search works even when Zotero is closed.

## License

[MIT](LICENSE). The item-type icons come from the Raycast Store
[Zotero extension](https://www.raycast.com/reckoning-dev/zotero) by reckoning-dev.
