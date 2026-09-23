import { environment, getPreferenceValues } from "@raycast/api";
import { exec, execFile } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join } from "path";

// Everything here talks to Zotero through two native doors so that no large payload ever crosses
// Tinycast's JS bridge: the `sqlite3` CLI for the library (queried in place, `immutable=1`, so Zotero's
// exclusive lock and a 70 MB database don't matter) and Zotero's local HTTP API for citations.

const ITEMS_SQL = `
WITH regular AS (
  SELECT i.itemID, i.key, i.libraryID, i.dateAdded, t.typeName
  FROM items i JOIN itemTypes t USING (itemTypeID)
  WHERE t.typeName NOT IN ('attachment', 'note', 'annotation')
    AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
)
SELECT
  r.itemID AS id, r.key, r.libraryID, r.dateAdded, r.typeName AS type,
  (SELECT json_group_object(f.fieldName, v.value)
     FROM itemData d JOIN fields f USING (fieldID) JOIN itemDataValues v USING (valueID)
     WHERE d.itemID = r.itemID) AS fields,
  (SELECT json_group_array(json_object('first', c.firstName, 'last', c.lastName, 'type', ct.creatorType))
     FROM (SELECT * FROM itemCreators WHERE itemID = r.itemID ORDER BY orderIndex) ic
     JOIN creators c USING (creatorID) JOIN creatorTypes ct USING (creatorTypeID)) AS creators,
  (SELECT json_group_array(tg.name) FROM itemTags it JOIN tags tg USING (tagID)
     WHERE it.itemID = r.itemID) AS tags,
  (SELECT json_group_array(collectionID) FROM collectionItems WHERE itemID = r.itemID) AS collections,
  (SELECT json_group_array(json_object('key', ai.key, 'path', a.path, 'linkMode', a.linkMode, 'contentType', a.contentType))
     FROM itemAttachments a JOIN items ai ON ai.itemID = a.itemID
     WHERE a.parentItemID = r.itemID AND ai.itemID NOT IN (SELECT itemID FROM deletedItems)) AS attachments
FROM regular r
ORDER BY r.dateAdded DESC;
`;

export interface Preferences {
  zotero_path: string;
  csl_style: string;
  primary_action: "open_pdf" | "open_pdf_zotero" | "open_zotero";
  quote_pdf_path: boolean;
}

export const preferences = () => getPreferenceValues<Preferences>();

export interface Creator {
  first: string | null;
  last: string | null;
  type: string;
}

export interface Attachment {
  key: string;
  path: string | null;
  linkMode: number;
  contentType: string | null;
}

export interface Item {
  id: number;
  key: string;
  libraryID: number;
  dateAdded: string;
  type: string;
  fields: Record<string, string>;
  creators: Creator[];
  tags: string[];
  collections: number[];
  attachments: Attachment[];
  // Derived on load.
  title: string;
  year: string;
  citekey: string | null;
  container: string | null;
  pdf: { key: string; path: string } | null;
  searchTitle: string;
  searchCreators: string;
  searchRest: string;
}

export interface Collection {
  id: number;
  name: string;
  parentID: number | null;
  libraryID: number;
}

export interface Library {
  libraryID: number;
  groupID: number | null;
  name: string;
}

export interface ZoteroLibrary {
  items: Item[];
  collections: Collection[];
  libraries: Library[];
}

export const expandHome = (path: string) => (path.startsWith("~") ? join(homedir(), path.slice(1)) : path);

export function databasePath() {
  return expandHome(preferences().zotero_path?.trim() || "~/Zotero/zotero.sqlite");
}

function sqlite<T>(sql: string): Promise<T[]> {
  const database = databasePath();
  if (!existsSync(database)) {
    return Promise.reject(new Error(`No Zotero database at ${database}. Check the Zotero Path preference.`));
  }
  const uri = `file:${encodeURI(database).replace(/\?/g, "%3F").replace(/#/g, "%23")}?immutable=1`;
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/sqlite3",
      ["-readonly", "-json", uri, sql],
      { maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr || error.message).trim()));
        const text = String(stdout).trim();
        try {
          resolve(text ? JSON.parse(text) : []);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

const CONTAINER_FIELDS = [
  "publicationTitle",
  "bookTitle",
  "proceedingsTitle",
  "encyclopediaTitle",
  "dictionaryTitle",
  "websiteTitle",
  "blogTitle",
  "forumTitle",
  "programTitle",
  "repository",
  "university",
  "institution",
  "publisher",
];

export function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function resolveAttachmentPath(attachment: Attachment, dataDirectory: string): string | null {
  const path = attachment.path;
  if (!path) return null;
  if (path.startsWith("storage:")) return join(dataDirectory, "storage", attachment.key, path.slice("storage:".length));
  if (isAbsolute(path)) return path;
  return null;
}

function derive(raw: Record<string, unknown>, dataDirectory: string): Item {
  const item = {
    ...raw,
    fields: JSON.parse((raw.fields as string) || "{}"),
    creators: JSON.parse((raw.creators as string) || "[]"),
    tags: JSON.parse((raw.tags as string) || "[]"),
    collections: JSON.parse((raw.collections as string) || "[]"),
    attachments: JSON.parse((raw.attachments as string) || "[]"),
  } as Item;

  const fields = item.fields;
  item.title = fields.title || fields.caseName || fields.subject || fields.nameOfAct || "(untitled)";
  item.year = (fields.date || "").match(/\d{4}/)?.[0] ?? "";
  item.citekey = fields.citationKey || null;
  item.container = CONTAINER_FIELDS.map((name) => fields[name]).find(Boolean) ?? null;

  // PDFs first, then EPUBs; a linked URL (linkMode 3) has no file to open.
  const files = item.attachments
    .filter((attachment) => attachment.linkMode !== 3)
    .map((attachment) => ({ attachment, path: resolveAttachmentPath(attachment, dataDirectory) }))
    .filter((entry): entry is { attachment: Attachment; path: string } => entry.path !== null);
  const pdf =
    files.find((entry) => entry.attachment.contentType === "application/pdf") ??
    files.find((entry) => entry.attachment.contentType === "application/epub+zip");
  item.pdf = pdf ? { key: pdf.attachment.key, path: pdf.path } : null;

  item.searchTitle = normalize(`${item.title} ${fields.shortTitle ?? ""}`);
  item.searchCreators = normalize(item.creators.map((creator) => `${creator.first ?? ""} ${creator.last ?? ""}`).join(" "));
  item.searchRest = normalize(
    [
      item.year,
      item.citekey,
      item.container,
      fields.journalAbbreviation,
      fields.DOI,
      fields.ISBN,
      item.tags.join(" "),
    ]
      .filter(Boolean)
      .join(" "),
  );
  return item;
}

export async function loadLibrary(): Promise<ZoteroLibrary> {
  const dataDirectory = dirname(databasePath());
  const [rawItems, collections, groups] = await Promise.all([
    sqlite<Record<string, unknown>>(ITEMS_SQL),
    sqlite<Collection>(
      `SELECT collectionID AS id, collectionName AS name, parentCollectionID AS parentID, libraryID
       FROM collections
       WHERE collectionID NOT IN (SELECT collectionID FROM deletedCollections)
       ORDER BY collectionName COLLATE NOCASE`,
    ).catch(() =>
      // Zotero 6 has no deletedCollections table.
      sqlite<Collection>(
        `SELECT collectionID AS id, collectionName AS name, parentCollectionID AS parentID, libraryID
         FROM collections ORDER BY collectionName COLLATE NOCASE`,
      ),
    ),
    sqlite<{ groupID: number; libraryID: number; name: string }>(
      "SELECT groupID, libraryID, name FROM groups ORDER BY name COLLATE NOCASE",
    ),
  ]);

  const libraries: Library[] = [
    { libraryID: 1, groupID: null, name: "My Library" },
    ...groups.map((group) => ({ libraryID: group.libraryID, groupID: group.groupID, name: group.name })),
  ];
  return { items: rawItems.map((raw) => derive(raw, dataDirectory)), collections, libraries };
}

// MARK: - Display helpers

export function formatCreators(item: Item, max = 3): string {
  const authors = item.creators.filter((creator) => creator.type === "author");
  const list = authors.length > 0 ? authors : item.creators;
  const names = list.map((creator) => creator.last || creator.first || "");
  if (names.length === 0) return "";
  if (names.length > max) return `${names[0]} et al.`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

export function fullCreators(item: Item): string {
  return item.creators.map((creator) => [creator.first, creator.last].filter(Boolean).join(" ")).join(", ");
}

export function typeTitle(type: string): string {
  return type.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

const ICONS = new Set([
  "artwork", "audioRecording", "bill", "blogPost", "book", "bookSection", "case", "computerProgram",
  "conferencePaper", "dictionaryEntry", "document", "email", "encyclopediaArticle", "film", "forumPost",
  "hearing", "instantMessage", "interview", "journalArticle", "letter", "magazineArticle", "manuscript",
  "map", "newspaperArticle", "patent", "preprint", "thesis",
]);

export const typeIcon = (type: string) => `${ICONS.has(type) ? type : "default"}.png`;

// MARK: - Zotero URLs

function libraryPath(item: Item, libraries: Library[], style: "select" | "api") {
  const groupID = libraries.find((library) => library.libraryID === item.libraryID)?.groupID;
  if (style === "api") return groupID ? `groups/${groupID}` : "users/0";
  return groupID ? `groups/${groupID}` : "library";
}

export const zoteroSelectURL = (item: Item, libraries: Library[]) =>
  `zotero://select/${libraryPath(item, libraries, "select")}/items/${item.key}`;

export const zoteroOpenPDFURL = (item: Item, libraries: Library[]) =>
  item.pdf ? `zotero://open-pdf/${libraryPath(item, libraries, "select")}/items/${item.pdf.key}` : null;

export function itemURL(item: Item): string | null {
  if (item.fields.DOI) return `https://doi.org/${item.fields.DOI.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}`;
  return item.fields.url || null;
}

// MARK: - Local API (citations)

const API = "http://127.0.0.1:23119";

export class ZoteroUnavailableError extends Error {
  constructor() {
    super(
      "Start Zotero and enable Settings → Advanced → “Allow other applications on this computer to communicate with Zotero”.",
    );
  }
}

async function request(path: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { headers: { "Zotero-Allowed-Request": "true" } });
  } catch {
    throw new ZoteroUnavailableError();
  }
  const body = await response.text();
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) throw new ZoteroUnavailableError();
    throw new Error(body.trim() || `Zotero answered ${response.status}`);
  }
  return body;
}

const itemPath = (item: Item, libraries: Library[]) =>
  `/api/${libraryPath(item, libraries, "api")}/items/${item.key}`;

export async function bibliographyHTML(item: Item, libraries: Library[]): Promise<string> {
  const style = encodeURIComponent(preferences().csl_style || "apa");
  return request(`${itemPath(item, libraries)}?format=bib&style=${style}`);
}

export async function inTextCitation(item: Item, libraries: Library[]): Promise<string> {
  const style = encodeURIComponent(preferences().csl_style || "apa");
  const json = JSON.parse(await request(`${itemPath(item, libraries)}?format=json&include=citation&style=${style}`));
  return htmlToText(json.citation ?? "");
}

export async function bibtex(item: Item, libraries: Library[]): Promise<string> {
  // Better BibTeX's export keeps its own citation keys; Zotero's built-in BibTeX invents new ones.
  if (item.citekey) {
    try {
      const text = await request(
        `/better-bibtex/export/item?citationKeys=${encodeURIComponent(item.citekey)}&translator=betterbibtex`,
      );
      if (text.trim().startsWith("@")) return text.trim();
    } catch (error) {
      if (error instanceof ZoteroUnavailableError && !(await zoteroReachable())) throw error;
    }
  }
  return (await request(`${itemPath(item, libraries)}?format=bibtex`)).trim();
}

async function zoteroReachable() {
  try {
    await fetch(`${API}/connector/ping`);
    return true;
  } catch {
    return false;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function htmlToText(html: string): string {
  return html
    .replace(/<span class="Z3988"[^>]*><\/span>/g, "")
    .replace(/<div class="csl-left-margin"[^>]*>([\s\S]*?)<\/div>/g, "$1 ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return String.fromCodePoint(code);
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/// Tinycast's Clipboard only carries plain text, so rich text goes through macOS: textutil turns the
/// HTML into RTF, and pbcopy files input that starts with an RTF header as rich text.
export function copyRichText(html: string): Promise<void> {
  mkdirSync(environment.supportPath, { recursive: true });
  const file = join(environment.supportPath, "bibliography.html");
  const cleaned = html
    .replace(/<span class="Z3988"[^>]*><\/span>/g, "")
    .replace(/<div class="csl-left-margin"[^>]*>([\s\S]*?)<\/div>/g, "$1 ")
    .replace(/ style="[^"]*"/g, "");
  writeFileSync(file, `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${cleaned}</body></html>`);
  const quoted = `'${file.replace(/'/g, "'\\''")}'`;
  return new Promise((resolve, reject) => {
    exec(`/usr/bin/textutil -format html -convert rtf -stdout ${quoted} | /usr/bin/pbcopy`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}
