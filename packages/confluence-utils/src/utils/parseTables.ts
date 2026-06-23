import { parseDocument, DomUtils } from "htmlparser2";

/**
 * A Confluence storage-format table, parsed into structured rows.
 *
 * Unlike {@link extractTextFromXML} (which strips digits and is tuned for RAG
 * text extraction), this preserves cell text verbatim — versions, dates, and
 * numbers survive — which the deployment-automation parsers depend on.
 */
export interface ParsedTable {
  /** First row's cells, verbatim. */
  headers: string[];
  /** Body rows (header row excluded), each as an array of cell strings. */
  rows: string[][];
  /** Body rows keyed by their lower-cased, trimmed header. */
  records: Record<string, string>[];
}

/** Plain text of a single cell, unwrapping Confluence inline macros. */
function cellText(node: any): string {
  let out = "";
  const recurse = (n: any) => {
    if (!n) return;
    // Confluence inline date macro: the value is in the `datetime` attribute
    // (`<time datetime="2026-06-23" />`), not a text node.
    if (n.type === "tag" && n.name === "time" && n.attribs?.datetime) {
      out += n.attribs.datetime + " ";
      return;
    }
    if (n.type === "tag" && n.name === "ac:structured-macro") {
      // Inline code / status macros keep their value in a plain-text body.
      const ptb = DomUtils.findOne(
        (el: any) => el.name === "ac:plain-text-body",
        n.children
      );
      if (ptb) {
        out += DomUtils.textContent(ptb) + " ";
        return;
      }
      // Other macros (e.g. status lozenges): fall through to their text.
    }
    // Page links / smart links: the visible text may live in a link body, or
    // only in the referenced page's `ri:content-title` attribute (a bare page
    // link has no text node at all).
    if (n.type === "tag" && (n.name === "ac:link" || n.name === "ac:inline-card")) {
      const body = DomUtils.findOne(
        (el: any) => el.name === "ac:link-body" || el.name === "ac:plain-text-link-body",
        n.children
      );
      const bodyText = body ? DomUtils.textContent(body).trim() : "";
      if (bodyText) {
        out += bodyText + " ";
        return;
      }
      const ref = DomUtils.findOne(
        (el: any) => el.name === "ri:page" || el.name === "ri:card-appearance" || el.name === "ri:url",
        n.children
      );
      const title =
        ref?.attribs?.["ri:content-title"] ?? ref?.attribs?.["ri:value"] ?? "";
      if (title) {
        out += title + " ";
        return;
      }
      // Otherwise fall through to whatever children carry text.
    }
    if (n.type === "text" || n.type === "cdata") {
      out += n.data;
    } else if (n.children) {
      n.children.forEach(recurse);
    }
  };
  (node.children || []).forEach(recurse);
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Parse every `<table>` in a Confluence storage-format body into structured
 * rows. The first `<tr>` of each table is treated as the header.
 */
export function parseStorageTables(html: string): ParsedTable[] {
  const doc = parseDocument(html, { xmlMode: true });
  const tables = DomUtils.findAll((n: any) => n.name === "table", doc.children);

  return tables.map((table: any) => {
    const trs = DomUtils.findAll((n: any) => n.name === "tr", table.children);
    const cells: string[][] = trs
      .map((tr: any) =>
        DomUtils.findAll(
          (n: any) => n.name === "td" || n.name === "th",
          tr.children
        ).map(cellText)
      )
      .filter((r) => r.length > 0);

    if (cells.length === 0) return { headers: [], rows: [], records: [] };

    const headers = cells[0];
    const rows = cells.slice(1);
    const records = rows.map((r) => {
      const rec: Record<string, string> = {};
      headers.forEach((h, i) => {
        rec[h.toLowerCase().trim()] = r[i] ?? "";
      });
      return rec;
    });
    return { headers, rows, records };
  });
}
