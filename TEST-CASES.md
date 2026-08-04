# Fidelity Test Cases — per document

Every document gets three automated layers plus targeted manual checks.

## The three automated layers (all 14 docs)

| Layer | What it compares | Catches |
|---|---|---|
| **L1 Structural inventory** | XML-level counts & values, original vs round-trip: image count + exact sizes (EMU), table/row/cell counts, merged-cell spans, section count, header/footer parts, fonts referenced, SmartArt diagram parts, footnote count | Anything dropped or resized, even if visually subtle |
| **L2 Text diff** | Full extracted text, line by line (`diff`) | Lost/altered content, reordered paragraphs |
| **L3 Visual page diff** | Both versions rendered to PDF by the SAME renderer → each page rasterized at 150dpi → per-page pixel similarity score | Layout shifts, font substitution, pagination changes, color/shading changes |

Pass = L1 identical, L2 identical, every L3 page ≥ threshold (default 99.5%
similarity). Any flagged page produces a side-by-side + red-overlay diff image
in `reports/` for human review.

## Per-document targeted checks

### 1. CCR.docx — embedded fonts
- [ ] L3 on every page (font substitution shows as global pixel drift)
- [ ] Manual: RobotoMono/NovaMono glyphs render (not Courier fallback)
- [ ] L1: `word/fonts/*.ttf` still present after round-trip (font embedding preserved)

### 2. Data_Collection_Guide.md.docx — longest doc
- [ ] Page count identical (pagination stability at scale)
- [ ] L3 on ALL pages — drift compounds; check last pages especially
- [ ] All 10 tables intact (L1 row/cell counts)

### 3. mcp-agent-trd-final.docx — 51 tables
- [ ] L1: 51 tables, identical row/cell count per table
- [ ] L3: table borders/shading pages
- [ ] Manual: header repeats correctly across pages

### 4. IRIS_CCR_Claude_Code_Requirements.docx — 40 tables
- [ ] Same as #3 (40 tables)

### 5. Abikarta_Requirements_Design_Document.docx — 29 pages, 36 tables
- [ ] Page count stays 29
- [ ] L1 table inventory identical

### 6. deeplearnhq-architecture-v3.docx — multi-section
- [ ] L1: 2 sections survive; section properties (margins/size) unchanged
- [ ] Manual: section break behavior — content doesn't merge across the break

### 7. Saad_Resume_BMO_Resume_Final_Nov2025.docx — layout-sensitive
- [ ] Page count stays 2
- [ ] L3 strict: any line-wrap change on a resume is visible — inspect any page < 99.9%

### 8. SAJHA_OSFI_Tool_Suite_Requirements.docx — everyday governance doc
- [ ] Baseline case: expect clean pass on all layers; if this fails, stop and diagnose before anything else

### 9. SYNTH-1_Images_and_Formatting.docx — images
- [ ] L1: 6 image references with EXACT emu sizes — the stretched image must stay 5.0"×1.2" (engine must not "fix" aspect ratio)
- [ ] Image inside table cell survives at 2.0" width
- [ ] Landscape section stays landscape
- [ ] Page-number field in footer still a live field (not frozen text)
- [ ] Manual: highlight color, red text, Courier/Georgia runs, list nesting

### 10. SYNTH-2_Tables_TOC_Fields.docx — table torture
- [ ] L1: gridSpan (horizontal merge) and vMerge (vertical merge) attributes identical
- [ ] Nested table still nested (not flattened to sibling)
- [ ] Cell shading hex values unchanged (C00000, ED7D31, 70AD47, 1F4E79, D9D9D9)
- [ ] TOC field code preserved as a field
- [ ] Precise formatting: 0.5" indent, 12pt before/after, 1.5 line spacing values unchanged in XML

### 11. WEB-1_Calibre_Demo — real-world images + footnotes
- [ ] L1: 4 images, sizes identical; footnote count identical
- [ ] L3: image placement pages
- [ ] Manual: footnote renders at correct page bottom, reference mark intact

### 12–14. WEB-2/3/4 — SmartArt (the known weak spot)
- [ ] **The governance question**: after a round-trip that does NOT touch the
      diagram, are `word/diagrams/*` parts byte-identical (or at least
      structurally identical)?
- [ ] L3: diagrams render visually identical
- [ ] WEB-3: all 4 diagrams present, text placement per diagram correct
- [ ] WEB-4: theme-colored text keeps its color
- [ ] Exploratory (manual, in editor): click and edit a diagram → document what
      happens (expected: converts to grouped shapes; visually same, no longer
      SmartArt). This result goes in the report as a documented limitation, not
      a pass/fail.

## Methodology notes

- **Same-renderer rule**: both original and round-trip are rendered to PDF by
  the same engine, so any pixel diff = real file difference, not renderer noise.
- **Round-trip mechanism**: each docx goes through ONLYOFFICE Document Server's
  own conversion engine (the same parse→serialize path the editor uses on save).
- **View test**: ONLYOFFICE's rendering of the original is checked via its own
  PDF export + spot screenshots in the editor for docs 1, 9, 10, 11, 12–14.
- Originals in `sample-docs/` are never modified.
