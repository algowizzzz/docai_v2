# ONLYOFFICE Fidelity Pilot — Sample Set

Purpose: validate that DOCX documents survive upload → view → edit → save in
ONLYOFFICE Document Server with no loss of formatting, images, tables, or layout,
before building the full platform.

## Sample set (10 documents)

| # | Document | Why it's in the set |
|---|----------|--------------------|
| 1 | CCR.docx | **Embedded custom fonts** (RobotoMono, NovaMono shipped inside the file) — tests font handling and substitution behavior |
| 2 | Data_Collection_Guide.md.docx | **Longest document** (656KB body XML) + embedded fonts + 10 tables — tests scale/pagination |
| 3 | mcp-agent-trd-final.docx | **Heaviest table load**: 51 tables + custom header |
| 4 | IRIS_CCR_Claude_Code_Requirements.docx | 40 tables + header — dense requirements-doc style |
| 5 | Abikarta_Requirements_Design_Document.docx | 29 pages, 36 tables — long structured design doc |
| 6 | deeplearnhq-architecture-v3.docx | **Multi-section document** (2 sections) + header — tests section breaks |
| 7 | Saad_Resume_BMO_Resume_Final_Nov2025.docx | Layout-sensitive resume — tight spacing where any shift is visible |
| 8 | SAJHA_OSFI_Tool_Suite_Requirements.docx | Typical governance/requirements doc (26 tables, header) — the "everyday" case |
| 9 | SYNTH-1_Images_and_Formatting.docx | **Synthetic torture test A**: exact-size images (incl. non-native aspect ratio), image in table cell, banner, centered captioned image, mixed fonts/sizes/colors/highlights, multi-level lists, landscape section, page-number footer field |
| 10 | SYNTH-2_Tables_TOC_Fields.docx | **Synthetic torture test B**: horizontally & vertically merged cells, nested table, 8-column wide table, cell shading/colors, TOC field, page-number field, precise indent/spacing values |
| 11 | WEB-1_Calibre_Demo_Images_Footnotes.docx | Calibre's demo.docx (calibre-ebook.com) — real-world doc with 4 images, 6 tables, footnotes; well-known conversion torture test |
| 12 | WEB-2_SmartArt_Basic.docx | **SmartArt** (real diagram XML parts) — LibreOffice regression-test fixture (sw/qa/extras/ooxmlexport) |
| 13 | WEB-3_SmartArt_TextLocation_4diagrams.docx | **4 SmartArt diagrams** with text placement variations — LibreOffice fixture (oox/qa, tdf#151518) |
| 14 | WEB-4_SmartArt_ThemeColors.docx | **SmartArt with theme-colored text** — LibreOffice fixture (oox/qa, tdf#54095) |

Note: SYNTH-1 and SYNTH-2 were generated because none of the available real
documents contained images. WEB-1..4 were downloaded 2026-08-03 to cover
images-in-the-wild and SmartArt. If real image-heavy or tracked-changes company
documents become available, add them to the set.

SmartArt expectation: SmartArt is a known weak spot in every non-Microsoft
editor. ONLYOFFICE renders SmartArt, but on edit it may convert diagrams to
grouped shapes (visually identical, no longer editable as SmartArt). The pilot
should confirm: (a) view renders correctly, (b) round-trip without touching the
diagram leaves the diagram XML intact, (c) what happens when the diagram itself
is edited. Decide in/out of scope based on results.

Known gaps not covered by this set (flag if present in the real corpus):
- Legacy binary .doc files
- Tracked changes / comments
- Embedded OLE objects (live Excel charts), macros (.docm)
- Content controls / protected forms

## Test protocol (per document)

1. **View test** — open in ONLYOFFICE side-by-side with Word/PDF export of the
   original. Check: page count, fonts, table structure, image size & placement,
   headers/footers, colors/shading.
2. **Round-trip test** — open in ONLYOFFICE, make one trivial edit (add and
   delete a space), force save, download the result. Compare against the
   original: export both to PDF, render pages to images, pixel-diff with a
   similarity threshold. Any page below threshold → human review.

## Acceptance criteria

- 10/10 pass the view test (no visible layout, font, image, or table deltas)
- 10/10 pass the round-trip test above the similarity threshold
- Every flagged delta gets a documented root cause and an in/out-of-scope decision

## Folder layout

- `sample-docs/` — the 10 input documents (immutable originals; do not edit in place)
- `roundtrip/` — documents after ONLYOFFICE edit-save (created during the test)
- `reports/` — PDF renders, diff images, and the pass/fail report (created during the test)
