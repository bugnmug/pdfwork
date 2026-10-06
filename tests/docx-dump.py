# docx-dump.py <file.docx>: a Word document's structure as JSON, for test checks.
# Body blocks in order: paragraphs (style, alignment, text with "\t" for tabs and "\n" for
# line breaks, list numbering, tab stops, borders, pictures) and tables (cells with their fill
# and the blocks inside, so nested tables show), plus the running header and footer.
import json
import sys

import docx
from docx.oxml.ns import qn


def W(tag):
    return qn("w:" + tag)


doc = docx.Document(sys.argv[1])

# List numbering: numId -> level -> (format, text).
levels = {}
try:
    numbering = doc.part.numbering_part.element
    abstract = {}
    for a in numbering.findall(W("abstractNum")):
        lv = {}
        for l in a.findall(W("lvl")):
            fmt = l.find(W("numFmt"))
            txt = l.find(W("lvlText"))
            lv[l.get(W("ilvl"))] = (fmt.get(W("val")) if fmt is not None else None, txt.get(W("val")) if txt is not None else "")
        abstract[a.get(W("abstractNumId"))] = lv
    for n in numbering.findall(W("num")):
        ref = n.find(W("abstractNumId"))
        if ref is not None:
            levels[n.get(W("numId"))] = abstract.get(ref.get(W("val")), {})
except Exception:
    pass


def text_of(p):
    out = ""
    for r in p.iter(W("r")):
        for c in r:
            tag = c.tag.split("}")[1]
            if tag == "t":
                out += c.text or ""
            elif tag == "tab":
                out += "\t"
            elif tag == "br":
                out += "\n"
    return out


def para(p):
    ppr = p.find(W("pPr"))
    o = {"t": "p", "text": text_of(p)}
    pics = len(p.findall(".//" + W("drawing")))
    if pics:
        o["pics"] = pics
    if ppr is not None:
        st = ppr.find(W("pStyle"))
        if st is not None:
            o["style"] = st.get(W("val"))
        jc = ppr.find(W("jc"))
        if jc is not None:
            o["align"] = jc.get(W("val"))
        n = ppr.find(W("numPr"))
        if n is not None and n.find(W("numId")) is not None:
            num = n.find(W("numId")).get(W("val"))
            lvl = n.find(W("ilvl")).get(W("val")) if n.find(W("ilvl")) is not None else "0"
            fmt, txt = levels.get(num, {}).get(lvl, (None, ""))
            o["list"] = {"id": num, "level": int(lvl), "format": fmt, "text": txt}
        tabs = ppr.find(W("tabs"))
        if tabs is not None:
            o["tabs"] = [t.get(W("val")) for t in tabs.findall(W("tab"))]
        bdr = ppr.find(W("pBdr"))
        if bdr is not None:
            o["border"] = [c.tag.split("}")[1] for c in bdr]
        ind = ppr.find(W("ind"))
        if ind is not None:
            o["indent"] = {k.split("}")[1]: int(v) for k, v in ind.attrib.items()}
    return o


def table(tb):
    rows = []
    for tr in tb.findall(W("tr")):
        cells = []
        for tc in tr.findall(W("tc")):
            tcpr = tc.find(W("tcPr"))
            shd = tcpr.find(W("shd")) if tcpr is not None else None
            cells.append({"fill": shd.get(W("fill")) if shd is not None else None, "blocks": body(tc)})
        rows.append(cells)
    tblpr = tb.find(W("tblPr"))
    ind = tblpr.find(W("tblInd")) if tblpr is not None else None
    return {"t": "table", "rows": rows, "indent": int(ind.get(W("w"))) if ind is not None else 0}


def body(el):
    out = []
    for c in el:
        tag = c.tag.split("}")[1]
        if tag == "p":
            out.append(para(c))
        elif tag == "tbl":
            out.append(table(c))
    return out


sec = doc.sections[0]
furniture = {}
for name, part in (("header", sec.header), ("footer", sec.footer)):
    xml = part._element.xml if part is not None else ""
    furniture[name] = {"text": "\n".join(p.text for p in part.paragraphs) if part is not None else "", "page": "PAGE" in xml, "pages": "NUMPAGES" in xml, "pics": xml.count("<w:drawing")}

print(json.dumps({"body": body(doc.element.body), **furniture}, ensure_ascii=False))
