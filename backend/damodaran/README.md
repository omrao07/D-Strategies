# Damodaran Bot Module

This module handles **ingestion, retrieval, and numeric extraction** of valuation data.
(e.g. WACC, tax rate, growth assumptions, share counts) from Damodaran’s resources.
(PDFs, text, video transcripts).

---

## Files

- **ingest.ts**  
  Load and chunk PDFs/videos/text into searchable spans with source/page metadata.

- **retrieve.ts**  
  Hybrid search API. Given a query, returns `Hit[]` containing text + `{sourceId, page, start, end}`.

- **hook.ts**  
  Exposes `/damodaran/extract`. Takes a query + hits, applies regex + context matching.
  returns normalized numeric values with citations.

---

## Example

```ts
import { retrieve } from "./retrieve";
import { extract } from "./hook";

{// Query for Apple WACC and tax rate
const hits = retrieve("Apple WACC tax rate", 5);
const out = extract("Apple WACC tax rate", hits);

console.log(out) }
