import {
  Action,
  ActionPanel,
  Clipboard,
  closeMainWindow,
  Color,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
  showHUD,
  showToast,
  Toast,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bibliographyHTML,
  bibtex,
  copyRichText,
  formatCreators,
  fullCreators,
  htmlToText,
  inTextCitation,
  Item,
  itemURL,
  Library,
  loadLibrary,
  normalize,
  preferences,
  typeIcon,
  typeTitle,
  ZoteroLibrary,
  zoteroOpenPDFURL,
  zoteroSelectURL,
} from "./zotero";

const MAX_RESULTS = 100;

export default function SearchZotero() {
  const [library, setLibrary] = useState<ZoteroLibrary>();
  const [error, setError] = useState<Error>();
  const [isLoading, setIsLoading] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [scope, setScope] = useState("all");
  const [showingDetail, setShowingDetail] = useState(true);

  const reload = useCallback(async () => {
    setIsLoading(true);
    try {
      setLibrary(await loadLibrary());
      setError(undefined);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const scopedItems = useMemo(() => (library ? itemsInScope(library, scope) : []), [library, scope]);
  const results = useMemo(() => search(scopedItems, searchText), [scopedItems, searchText]);
  const collectionNames = useMemo(() => {
    const names = new Map<number, string>();
    for (const collection of library?.collections ?? []) names.set(collection.id, collection.name);
    return names;
  }, [library]);

  const subtitle =
    results.length > MAX_RESULTS
      ? `Top ${MAX_RESULTS} of ${results.length} — refine your search to see more`
      : `${results.length} item${results.length === 1 ? "" : "s"}`;

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={showingDetail && results.length > 0}
      filtering={false}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="Search title, author, year, tag, citation key…"
      searchBarAccessory={library ? <ScopeDropdown library={library} onChange={setScope} /> : undefined}
    >
      {error ? (
        <List.EmptyView
          icon={{ source: Icon.ExclamationMark, tintColor: Color.Red }}
          title="Couldn't read your Zotero library"
          description={error.message}
          actions={
            <ActionPanel>
              <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
              <Action title="Try Again" icon={Icon.ArrowClockwise} onAction={reload} />
            </ActionPanel>
          }
        />
      ) : (
        results.length === 0 && (
          <List.EmptyView icon="zotero.png" title={isLoading ? "Loading your library…" : "No matching items"} />
        )
      )}
      <List.Section title={searchText ? "Results" : "Recently Added"} subtitle={subtitle}>
        {results.slice(0, MAX_RESULTS).map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            libraries={library?.libraries ?? []}
            collectionNames={collectionNames}
            showingDetail={showingDetail}
            onToggleDetail={() => setShowingDetail((value) => !value)}
            onReload={reload}
          />
        ))}
      </List.Section>
    </List>
  );
}

function ScopeDropdown({ library, onChange }: { library: ZoteroLibrary; onChange: (value: string) => void }) {
  return (
    <List.Dropdown tooltip="Library or Collection" storeValue onChange={onChange}>
      <List.Dropdown.Item title="All Libraries" value="all" icon={Icon.Book} />
      {library.libraries.map((entry) => (
        <List.Dropdown.Section key={entry.libraryID} title={entry.name}>
          <List.Dropdown.Item
            title={entry.name}
            value={`library:${entry.libraryID}`}
            icon={entry.groupID ? Icon.TwoPeople : Icon.Book}
          />
          {collectionTree(library, entry.libraryID).map(({ id, path }) => (
            <List.Dropdown.Item key={id} title={path} value={`collection:${id}`} icon={Icon.Folder} />
          ))}
        </List.Dropdown.Section>
      ))}
    </List.Dropdown>
  );
}

function ItemRow(props: {
  item: Item;
  libraries: Library[];
  collectionNames: Map<number, string>;
  showingDetail: boolean;
  onToggleDetail: () => void;
  onReload: () => void;
}) {
  const { item, showingDetail } = props;
  const authors = formatCreators(item);
  return (
    <List.Item
      id={String(item.id)}
      icon={typeIcon(item.type)}
      title={item.title}
      subtitle={showingDetail ? undefined : authors}
      accessories={
        showingDetail
          ? undefined
          : [
              ...(item.pdf ? [{ icon: Icon.Document, tooltip: "Has PDF" }] : []),
              ...(item.year ? [{ text: item.year }] : []),
            ]
      }
      detail={<ItemDetail {...props} />}
      actions={<ItemActions {...props} />}
    />
  );
}

function ItemDetail({ item, libraries, collectionNames }: { item: Item; libraries: Library[]; collectionNames: Map<number, string> }) {
  const fields = item.fields;
  const authors = fullCreators(item);
  const where = [item.container, item.year].filter(Boolean).join(", ");
  const markdown = [
    `## ${escapeMarkdown(item.title)}`,
    authors && `**${escapeMarkdown(authors)}**`,
    where && `*${escapeMarkdown(where)}*`,
    fields.abstractNote && `---\n\n${escapeMarkdown(fields.abstractNote)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const pages = [
    fields.volume && `Vol. ${fields.volume}`,
    fields.issue && `No. ${fields.issue}`,
    fields.pages && `pp. ${fields.pages}`,
  ].filter(Boolean);
  const collections = item.collections.map((id) => collectionNames.get(id)).filter((name): name is string => !!name);
  const libraryName = libraries.find((entry) => entry.libraryID === item.libraryID)?.name;
  const url = itemURL(item);

  return (
    <List.Item.Detail
      markdown={markdown}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="Type" text={typeTitle(item.type)} icon={typeIcon(item.type)} />
          {fields.date && <List.Item.Detail.Metadata.Label title="Date" text={fields.date.split(" ")[0]} />}
          {item.container && <List.Item.Detail.Metadata.Label title="Published In" text={item.container} />}
          {pages.length > 0 && <List.Item.Detail.Metadata.Label title="Details" text={pages.join(", ")} />}
          {item.citekey && <List.Item.Detail.Metadata.Label title="Citation Key" text={item.citekey} />}
          {fields.DOI && url && <List.Item.Detail.Metadata.Link title="DOI" text={fields.DOI} target={url} />}
          {!fields.DOI && url && <List.Item.Detail.Metadata.Link title="URL" text={url} target={url} />}
          <List.Item.Detail.Metadata.Label
            title="Attachment"
            text={item.pdf ? item.pdf.path.split("/").pop() : "None"}
            icon={item.pdf ? Icon.Document : undefined}
          />
          {(item.tags.length > 0 || collections.length > 0) && <List.Item.Detail.Metadata.Separator />}
          {item.tags.length > 0 && (
            <List.Item.Detail.Metadata.TagList title="Tags">
              {item.tags.map((tag) => (
                <List.Item.Detail.Metadata.TagList.Item key={tag} text={tag} />
              ))}
            </List.Item.Detail.Metadata.TagList>
          )}
          {collections.length > 0 && (
            <List.Item.Detail.Metadata.TagList title="Collections">
              {collections.map((name) => (
                <List.Item.Detail.Metadata.TagList.Item key={name} text={name} color={Color.Blue} />
              ))}
            </List.Item.Detail.Metadata.TagList>
          )}
          {libraryName && libraries.length > 1 && <List.Item.Detail.Metadata.Label title="Library" text={libraryName} />}
          <List.Item.Detail.Metadata.Label title="Added" text={item.dateAdded.split(" ")[0]} />
        </List.Item.Detail.Metadata>
      }
    />
  );
}

function ItemActions({
  item,
  libraries,
  onToggleDetail,
  onReload,
}: {
  item: Item;
  libraries: Library[];
  onToggleDetail: () => void;
  onReload: () => void;
}) {
  const prefs = preferences();
  const url = itemURL(item);
  const selectURL = zoteroSelectURL(item, libraries);
  const readerURL = zoteroOpenPDFURL(item, libraries);
  const pdfPath = item.pdf ? (prefs.quote_pdf_path ? `"${item.pdf.path}"` : item.pdf.path) : null;

  const openPDF = item.pdf && (
    <Action.Open key="pdf" title="Open PDF" icon={Icon.Document} target={item.pdf.path} />
  );
  const openInReader = readerURL && (
    <Action.OpenInBrowser
      key="reader"
      title="Open PDF in Zotero"
      icon={Icon.Eye}
      url={readerURL}
      shortcut={{ modifiers: ["cmd", "shift"], key: "o" }}
    />
  );
  const openInZotero = (
    <Action.OpenInBrowser
      key="zotero"
      title="Show in Zotero"
      icon="zotero.png"
      url={selectURL}
      shortcut={{ modifiers: ["cmd"], key: "o" }}
    />
  );
  const open =
    prefs.primary_action === "open_zotero"
      ? [openInZotero, openPDF, openInReader]
      : prefs.primary_action === "open_pdf_zotero"
        ? [openInReader, openPDF, openInZotero]
        : [openPDF, openInReader, openInZotero];

  return (
    <ActionPanel title={item.title}>
      <ActionPanel.Section>
        {open.filter(Boolean)}
        {url && (
          <Action.OpenInBrowser
            title={item.fields.DOI ? "Open DOI" : "Open URL"}
            url={url}
            shortcut={{ modifiers: ["cmd"], key: "l" }}
          />
        )}
      </ActionPanel.Section>

      <ActionPanel.Section title="Cite">
        <Action
          title="Copy Bibliography Entry"
          icon={Icon.Clipboard}
          shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          onAction={() =>
            withCitation("Copied bibliography entry", async () => {
              await Clipboard.copy(htmlToText(await bibliographyHTML(item, libraries)));
            })
          }
        />
        <Action
          title="Copy Formatted Bibliography Entry"
          icon={Icon.Text}
          shortcut={{ modifiers: ["cmd", "opt"], key: "c" }}
          onAction={() =>
            withCitation("Copied formatted bibliography entry", async () => {
              await copyRichText(await bibliographyHTML(item, libraries));
            })
          }
        />
        <Action
          title="Paste Bibliography Entry"
          icon={Icon.TextInput}
          shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
          onAction={() =>
            withCitation(null, async () => {
              const text = htmlToText(await bibliographyHTML(item, libraries));
              await closeMainWindow();
              await Clipboard.paste(text);
            })
          }
        />
        <Action
          title="Copy In-Text Citation"
          icon={Icon.QuoteBlock}
          shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
          onAction={() =>
            withCitation("Copied in-text citation", async () => {
              await Clipboard.copy(await inTextCitation(item, libraries));
            })
          }
        />
        <Action
          title="Copy BibTeX"
          icon={Icon.Code}
          shortcut={{ modifiers: ["cmd", "shift"], key: "b" }}
          onAction={() =>
            withCitation("Copied BibTeX", async () => {
              await Clipboard.copy(await bibtex(item, libraries));
            })
          }
        />
      </ActionPanel.Section>

      {item.citekey && (
        <ActionPanel.Section title="Citation Key">
          <Action.CopyToClipboard
            title="Copy Citation Key"
            content={item.citekey}
            shortcut={{ modifiers: ["cmd"], key: "." }}
          />
          <Action.CopyToClipboard
            title="Copy Pandoc Citation"
            content={`[@${item.citekey}]`}
            shortcut={{ modifiers: ["cmd", "shift"], key: "." }}
          />
          <Action.CopyToClipboard title="Copy LaTeX Citation" content={`\\cite{${item.citekey}}`} />
          <Action.Paste title="Paste Citation Key" content={item.citekey} />
        </ActionPanel.Section>
      )}

      <ActionPanel.Section title="Copy">
        {pdfPath && item.pdf && (
          <>
            <Action.CopyToClipboard
              title="Copy PDF Path"
              content={pdfPath}
              shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
            />
            <Action.ShowInFinder path={item.pdf.path} shortcut={{ modifiers: ["cmd", "shift"], key: "f" }} />
          </>
        )}
        <Action.CopyToClipboard title="Copy Title" content={item.title} shortcut={{ modifiers: ["cmd", "shift"], key: "t" }} />
        {item.fields.DOI && <Action.CopyToClipboard title="Copy DOI" content={item.fields.DOI} />}
        {url && <Action.CopyToClipboard title={item.fields.DOI ? "Copy DOI Link" : "Copy URL"} content={url} />}
        <Action.CopyToClipboard title="Copy Zotero Link" content={selectURL} />
      </ActionPanel.Section>

      <ActionPanel.Section>
        <Action
          title="Toggle Details"
          icon={Icon.Sidebar}
          shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
          onAction={onToggleDetail}
        />
        <Action title="Reload Library" icon={Icon.ArrowClockwise} shortcut={Keyboard.Shortcut.Common.Refresh} onAction={onReload} />
        <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={openExtensionPreferences} />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

async function withCitation(success: string | null, run: () => Promise<void>) {
  const toast = await showToast({ style: Toast.Style.Animated, title: "Asking Zotero…" });
  try {
    await run();
    await toast.hide();
    if (success) await showHUD(success);
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Couldn't get citation from Zotero";
    toast.message = error instanceof Error ? error.message : String(error);
  }
}

// MARK: - Scope

function collectionTree(library: ZoteroLibrary, libraryID: number) {
  const inLibrary = library.collections.filter((collection) => collection.libraryID === libraryID);
  const children = new Map<number | null, typeof inLibrary>();
  for (const collection of inLibrary) {
    const parent = inLibrary.some((other) => other.id === collection.parentID) ? collection.parentID : null;
    children.set(parent, [...(children.get(parent) ?? []), collection]);
  }
  const rows: { id: number; path: string }[] = [];
  const walk = (parentID: number | null, prefix: string) => {
    for (const collection of children.get(parentID) ?? []) {
      const path = prefix ? `${prefix} › ${collection.name}` : collection.name;
      rows.push({ id: collection.id, path });
      walk(collection.id, path);
    }
  };
  walk(null, "");
  return rows;
}

function itemsInScope(library: ZoteroLibrary, scope: string): Item[] {
  const [kind, value] = scope.split(":");
  const id = Number(value);
  if (kind === "library") return library.items.filter((item) => item.libraryID === id);
  if (kind === "collection") {
    // A collection includes its subcollections, which is what you usually want from a launcher.
    const included = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const collection of library.collections) {
        if (collection.parentID !== null && included.has(collection.parentID) && !included.has(collection.id)) {
          included.add(collection.id);
          grew = true;
        }
      }
    }
    return library.items.filter((item) => item.collections.some((collectionID) => included.has(collectionID)));
  }
  return library.items;
}

// MARK: - Search

function search(items: Item[], query: string): Item[] {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return items;
  const scored: { item: Item; score: number }[] = [];
  for (const item of items) {
    let score = 0;
    for (const token of tokens) {
      const tokenScore = scoreToken(item, token);
      if (tokenScore === 0) {
        score = 0;
        break;
      }
      score += tokenScore;
    }
    if (score > 0) scored.push({ item, score });
  }
  // Stable sort keeps the recently-added order among equal scores.
  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.item);
}

function scoreToken(item: Item, token: string): number {
  if (item.citekey && normalize(item.citekey) === token) return 20;
  if (wordStart(item.searchTitle, token)) return 4;
  if (wordStart(item.searchCreators, token)) return 4;
  if (item.searchTitle.includes(token)) return 2;
  if (item.searchCreators.includes(token)) return 2;
  if (item.searchRest.includes(token)) return 1;
  return 0;
}

function wordStart(haystack: string, token: string) {
  let index = haystack.indexOf(token);
  while (index !== -1) {
    if (index === 0 || !/[\p{L}\p{N}]/u.test(haystack[index - 1])) return true;
    index = haystack.indexOf(token, index + 1);
  }
  return false;
}

function escapeMarkdown(text: string) {
  return text.replace(/([\\`*_[\]#<>])/g, "\\$1");
}
