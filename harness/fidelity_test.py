#!/usr/bin/env python3
"""ONLYOFFICE fidelity pilot harness.

Per document:
  1. Round-trip docx through ONLYOFFICE's conversion engine (docx -> docx),
     the same x2t parse/serialize path the editor uses on save.
  2. L1 structural inventory diff (images+sizes, tables/rows/cells, merges,
     sections, headers, fonts, diagram parts, footnotes, embedded fonts).
  3. L2 text diff (extracted text, line by line).
  4. L3 visual diff: render original & roundtrip to PDF with the SAME renderer
     (LibreOffice), rasterize pages at 150dpi, per-page pixel similarity.
  5. Also exports ONLYOFFICE's own docx->pdf render of the original (view test).

Outputs: roundtrip/*.docx, reports/report.md, reports/diff/*.png (flagged pages),
reports/inventory.json
"""
import os, sys, json, glob, subprocess, difflib, zipfile, re, time, shutil
import requests
import numpy as np
from PIL import Image

BASE = os.path.expanduser("~/Desktop/onlyoffice-pilot")
SAMPLES = os.path.join(BASE, "sample-docs")
ROUNDTRIP = os.path.join(BASE, "roundtrip")
REPORTS = os.path.join(BASE, "reports")
OO_PDF = os.path.join(REPORTS, "onlyoffice-view-pdf")
DIFFDIR = os.path.join(REPORTS, "diff")
WORK = os.path.join(BASE, "work")
OO = "http://localhost:8090"
FILESERVER_PORT = 8901
SOFFICE = "/opt/homebrew/bin/soffice"
DPI = 150
PAGE_FAIL_PCT = 0.5      # % of pixels differing beyond tolerance -> flag page
PIXEL_TOL = 24           # per-channel tolerance to ignore antialiasing noise

for d in (ROUNDTRIP, REPORTS, OO_PDF, DIFFDIR, WORK):
    os.makedirs(d, exist_ok=True)

# ---------------------------------------------------------------- conversion
def convert(url_path, out_type, key):
    """Ask Document Server to convert a file it fetches from our file server."""
    payload = {
        "async": False,
        "filetype": "docx",
        "outputtype": out_type,
        "key": key,
        "title": os.path.basename(url_path),
        "url": f"http://host.docker.internal:{FILESERVER_PORT}/{requests.utils.quote(url_path)}",
    }
    r = requests.post(f"{OO}/ConvertService.ashx", json=payload,
                      headers={"Accept": "application/json"}, timeout=300)
    r.raise_for_status()
    j = r.json()
    if "error" in j:
        raise RuntimeError(f"conversion error {j['error']} for {url_path} -> {out_type}")
    return requests.get(j["fileUrl"], timeout=300).content

# ---------------------------------------------------------------- inventory
def inventory(path):
    z = zipfile.ZipFile(path)
    names = z.namelist()
    doc = z.read("word/document.xml").decode("utf8", "ignore")
    inv = {}
    inv["images"] = sorted(re.findall(r'<a:ext cx="(\d+)" cy="(\d+)"/>', doc))
    inv["image_count"] = len(re.findall(r"<a:blip ", doc))
    inv["tables"] = doc.count("<w:tbl>")
    inv["rows"] = doc.count("<w:tr>") + doc.count("<w:tr ")
    inv["cells"] = doc.count("<w:tc>") + doc.count("<w:tc ")
    inv["gridspan"] = len(re.findall(r"<w:gridSpan ", doc))
    inv["vmerge"] = len(re.findall(r"<w:vMerge", doc))
    inv["sections"] = len(re.findall(r"<w:sectPr", doc))
    inv["footnote_refs"] = doc.count("footnoteReference")
    inv["fields"] = doc.count("<w:fldChar") // 2
    inv["headers_parts"] = sorted(n for n in names if n.startswith("word/header"))
    inv["footers_parts"] = sorted(n for n in names if n.startswith("word/footer"))
    inv["diagram_parts"] = sorted(n for n in names if n.startswith("word/diagrams/"))
    inv["media"] = sorted(n.split("/")[-1].split(".")[-1] for n in names if n.startswith("word/media/"))
    inv["embedded_fonts"] = sorted(n for n in names if n.startswith("word/fonts/"))
    try:
        ft = z.read("word/fontTable.xml").decode("utf8", "ignore")
        inv["fonts_referenced"] = sorted(set(re.findall(r'w:name="([^"]+)"', ft)))
    except KeyError:
        inv["fonts_referenced"] = []
    inv["cell_shading"] = sorted(set(re.findall(r'<w:shd[^>]*w:fill="([0-9A-Fa-f]{6})"', doc)))
    return inv

def text_of(path):
    z = zipfile.ZipFile(path)
    doc = z.read("word/document.xml").decode("utf8", "ignore")
    # paragraph-per-line plain text
    paras = re.split(r"</w:p>", doc)
    out = []
    for p in paras:
        t = "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p))
        if t.strip():
            out.append(t)
    return out

# ---------------------------------------------------------------- rendering
def render_pdf(docx_path, outdir):
    """LibreOffice render (SAME renderer for both sides of the compare)."""
    subprocess.run([SOFFICE, "--headless", "--convert-to", "pdf", "--outdir", outdir, docx_path],
                   check=True, capture_output=True, timeout=300)
    pdf = os.path.join(outdir, os.path.splitext(os.path.basename(docx_path))[0] + ".pdf")
    if not os.path.exists(pdf):
        raise RuntimeError(f"render failed: {docx_path}")
    return pdf

def rasterize(pdf, outprefix):
    subprocess.run(["pdftoppm", "-png", "-r", str(DPI), pdf, outprefix],
                   check=True, capture_output=True, timeout=600)
    return sorted(glob.glob(outprefix + "-*.png"))

def page_diff(a_png, b_png, diff_out=None):
    a = np.asarray(Image.open(a_png).convert("RGB"), dtype=np.int16)
    b = np.asarray(Image.open(b_png).convert("RGB"), dtype=np.int16)
    if a.shape != b.shape:
        h = min(a.shape[0], b.shape[0]); w = min(a.shape[1], b.shape[1])
        a2, b2 = a[:h, :w], b[:h, :w]
        shape_mismatch = True
    else:
        a2, b2, shape_mismatch = a, b, False
    delta = np.abs(a2 - b2).max(axis=2)
    differing = (delta > PIXEL_TOL)
    pct = 100.0 * differing.mean()
    if diff_out and (pct > PAGE_FAIL_PCT or shape_mismatch):
        # side-by-side with red overlay on differences
        av = Image.open(a_png).convert("RGB"); bv = Image.open(b_png).convert("RGB")
        overlay = np.asarray(bv).copy()
        ys, xs = np.where(differing)
        overlay[ys, xs] = [255, 0, 0]
        combo = Image.new("RGB", (av.width + bv.width + 8, max(av.height, bv.height)), "white")
        combo.paste(av, (0, 0)); combo.paste(Image.fromarray(overlay), (av.width + 8, 0))
        combo.save(diff_out)
    return pct, shape_mismatch

# ---------------------------------------------------------------- main
def main():
    docs = sorted(glob.glob(os.path.join(SAMPLES, "*.docx")))
    if len(sys.argv) > 1:
        docs = [d for d in docs if os.path.basename(d) in sys.argv[1:]]
    # merge with previous results so a partial rerun keeps earlier passes
    prev = {}
    prev_path = os.path.join(REPORTS, "results.json")
    if os.path.exists(prev_path):
        prev = json.load(open(prev_path))
    results = dict(prev)
    inv_dump = {}
    for path in docs:
        name = os.path.basename(path)
        stem = os.path.splitext(name)[0]
        print(f"\n=== {name}", flush=True)
        res = {"roundtrip": None, "L1": None, "L2": None, "L3": None, "flags": []}
        # 1. round-trip via ONLYOFFICE engine
        try:
            rt_bytes = convert(name, "docx", key=f"rt{int(time.time())}{abs(hash(name))%10000}")
            rt_path = os.path.join(ROUNDTRIP, name)
            open(rt_path, "wb").write(rt_bytes)
            res["roundtrip"] = "ok"
        except Exception as e:
            res["roundtrip"] = f"FAILED: {e}"
            results[name] = res
            print("  roundtrip FAILED:", e, flush=True)
            continue
        # ONLYOFFICE's own view render of the original
        try:
            pdf_bytes = convert(name, "pdf", key=f"vw{int(time.time())}{abs(hash(name))%10000}")
            open(os.path.join(OO_PDF, stem + ".pdf"), "wb").write(pdf_bytes)
        except Exception as e:
            res["flags"].append(f"onlyoffice pdf export failed: {e}")
        # 2. L1 inventory
        ia, ib = inventory(path), inventory(rt_path)
        l1_diffs = {k: (ia[k], ib[k]) for k in ia if ia[k] != ib[k]}
        res["L1"] = "identical" if not l1_diffs else {k: {"orig": v[0], "roundtrip": v[1]} for k, v in l1_diffs.items()}
        inv_dump[name] = {"original": ia, "roundtrip": ib}
        # 3. L2 text
        ta, tb = text_of(path), text_of(rt_path)
        delta = list(difflib.unified_diff(ta, tb, lineterm="", n=0))
        res["L2"] = "identical" if not delta else delta[:60]
        # 4. L3 visual (same renderer both sides)
        try:
            wa = os.path.join(WORK, "a"); wb = os.path.join(WORK, "b")
            shutil.rmtree(wa, ignore_errors=True); shutil.rmtree(wb, ignore_errors=True)
            os.makedirs(wa); os.makedirs(wb)
            pa = rasterize(render_pdf(path, wa), os.path.join(wa, "p"))
            pb = rasterize(render_pdf(rt_path, wb), os.path.join(wb, "p"))
            pages = []
            if len(pa) != len(pb):
                res["flags"].append(f"PAGE COUNT: orig {len(pa)} vs roundtrip {len(pb)}")
            for i, (fa, fb) in enumerate(zip(pa, pb), 1):
                out = os.path.join(DIFFDIR, f"{stem}_p{i:03d}.png")
                pct, mism = page_diff(fa, fb, out)
                pages.append(round(pct, 3))
                if mism:
                    res["flags"].append(f"page {i}: size mismatch")
            worst = max(pages) if pages else None
            res["L3"] = {"pages": len(pages), "worst_page_pct_diff": worst,
                         "failed_pages": [i + 1 for i, p in enumerate(pages) if p > PAGE_FAIL_PCT],
                         "per_page": pages}
        except Exception as e:
            res["L3"] = f"FAILED: {e}"
        results[name] = res
        print(f"  L1: {'identical' if res['L1']=='identical' else 'DIFFS: '+','.join(l1_diffs)}", flush=True)
        print(f"  L2: {'identical' if res['L2']=='identical' else 'TEXT DIFFS'}", flush=True)
        print(f"  L3: {res['L3'] if isinstance(res['L3'], str) else 'worst page diff %.3f%%, failed pages %s' % (res['L3']['worst_page_pct_diff'] or 0, res['L3']['failed_pages'])}", flush=True)

    json.dump(inv_dump, open(os.path.join(REPORTS, "inventory.json"), "w"), indent=1)
    json.dump(results, open(os.path.join(REPORTS, "results.json"), "w"), indent=1)

    # markdown report
    lines = ["# ONLYOFFICE Fidelity Pilot — Results", "",
             f"Round-trip: original.docx -> ONLYOFFICE x2t engine -> roundtrip.docx",
             f"Visual diff: both rendered by LibreOffice, {DPI}dpi, page flagged if >{PAGE_FAIL_PCT}% pixels differ (tol {PIXEL_TOL}/255).", "",
             "| Doc | Round-trip | L1 structure | L2 text | L3 pages | L3 worst diff % | Flagged pages | Verdict |",
             "|---|---|---|---|---|---|---|---|"]
    for name, r in results.items():
        l1 = "identical" if r["L1"] == "identical" else "**DIFFS**"
        l2 = "identical" if r["L2"] == "identical" else "**DIFFS**"
        if isinstance(r["L3"], dict):
            l3p, l3w, l3f = r["L3"]["pages"], r["L3"]["worst_page_pct_diff"], r["L3"]["failed_pages"]
        else:
            l3p = l3w = "-"; l3f = [r["L3"]]
        ok = (r["roundtrip"] == "ok" and r["L1"] == "identical" and r["L2"] == "identical"
              and isinstance(r["L3"], dict) and not r["L3"]["failed_pages"] and not r["flags"])
        verdict = "PASS" if ok else "REVIEW"
        lines.append(f"| {name} | {r['roundtrip']} | {l1} | {l2} | {l3p} | {l3w} | {l3f or '—'} | **{verdict}** |")
    lines += ["", "Flags:", ""]
    for name, r in results.items():
        for f in r["flags"]:
            lines.append(f"- {name}: {f}")
    open(os.path.join(REPORTS, "report.md"), "w").write("\n".join(lines))
    print("\nWrote reports/report.md", flush=True)

if __name__ == "__main__":
    main()
