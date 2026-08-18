#!/usr/bin/env python3
"""
Generates docs/presentation/Mnemosyne-Overview.pptx.

Requires python-pptx (pip install python-pptx). Diagrams are hand-drawn with
native PowerPoint shapes rather than rendered from Mermaid, because headless
Chromium (mermaid-cli's renderer) can't spawn in this sandbox.

Regenerate with:
    python3 -m venv /tmp/pptx-env && source /tmp/pptx-env/bin/activate
    pip install python-pptx
    python3 docs/presentation/build_deck.py
"""
import os

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.oxml.ns import qn

# ---- palette -----------------------------------------------------------
NAVY = RGBColor(0x1B, 0x2A, 0x4A)
SLATE = RGBColor(0x3A, 0x4A, 0x63)
ACCENT = RGBColor(0x2E, 0x6F, 0x95)
ACCENT_DARK = RGBColor(0x1F, 0x4E, 0x6B)
BODY = RGBColor(0x33, 0x33, 0x33)
MUTED = RGBColor(0x70, 0x70, 0x70)
BOX_FILL = RGBColor(0xDC, 0xE8, 0xF5)
BOX_BORDER = RGBColor(0x3A, 0x6E, 0xA5)
BOX_FILL_ALT = RGBColor(0xE9, 0xF3, 0xE7)
BOX_BORDER_ALT = RGBColor(0x5C, 0x9A, 0x5C)
BOX_FILL_MUTED = RGBColor(0xEE, 0xEE, 0xEE)
BOX_BORDER_MUTED = RGBColor(0x99, 0x99, 0x99)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)

prs = Presentation()
prs.slide_width = SLIDE_W
prs.slide_height = SLIDE_H
BLANK = prs.slide_layouts[6]


def add_slide():
    return prs.slides.add_slide(BLANK)


def set_background(slide, color=WHITE):
    bg = slide.background
    bg.fill.solid()
    bg.fill.fore_color.rgb = color


def add_text(slide, left, top, width, height, text, size=18, color=BODY,
             bold=False, italic=False, align=PP_ALIGN.LEFT, font="Calibri",
             anchor=MSO_ANCHOR.TOP, line_spacing=None):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    lines = text.split("\n")
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = line
        p.alignment = align
        if line_spacing:
            p.line_spacing = line_spacing
        for run in p.runs:
            run.font.size = Pt(size)
            run.font.color.rgb = color
            run.font.bold = bold
            run.font.italic = italic
            run.font.name = font
    return box


def add_bullets(slide, left, top, width, height, items, size=18, color=BODY,
                 font="Calibri", space_after=10, bullet_color=ACCENT):
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    for i, item in enumerate(items):
        if isinstance(item, tuple):
            text, level = item
        else:
            text, level = item, 0
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        prefix = ("  •  " if level == 1 else "•  ")
        p.text = prefix + text
        p.level = 0
        p.space_after = Pt(space_after)
        for run in p.runs:
            run.font.size = Pt(size - (2 if level == 1 else 0))
            run.font.color.rgb = color
            run.font.name = font
    return box


def add_kicker_title(slide, kicker, title, title_size=32):
    add_text(slide, Inches(0.6), Inches(0.35), Inches(8), Inches(0.4), kicker,
              size=14, color=ACCENT, bold=True, font="Calibri")
    add_text(slide, Inches(0.6), Inches(0.68), Inches(12), Inches(0.9), title,
              size=title_size, color=NAVY, bold=True, font="Calibri")
    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.6), Inches(1.35),
                                   Inches(1.2), Pt(3))
    line.fill.solid()
    line.fill.fore_color.rgb = ACCENT
    line.line.fill.background()
    return


def add_box(slide, left, top, width, height, text, fill=BOX_FILL, border=BOX_BORDER,
            size=13, color=NAVY, bold=True, shape_type=MSO_SHAPE.ROUNDED_RECTANGLE,
            align=PP_ALIGN.CENTER):
    shp = slide.shapes.add_shape(shape_type, left, top, width, height)
    shp.fill.solid()
    shp.fill.fore_color.rgb = fill
    shp.line.color.rgb = border
    shp.line.width = Pt(1.25)
    shp.shadow.inherit = False
    tf = shp.text_frame
    tf.word_wrap = True
    tf.margin_left = Pt(4)
    tf.margin_right = Pt(4)
    tf.margin_top = Pt(2)
    tf.margin_bottom = Pt(2)
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    lines = text.split("\n")
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = line
        p.alignment = align
        for run in p.runs:
            run.font.size = Pt(size)
            run.font.color.rgb = color
            run.font.bold = bold and i == 0
            run.font.name = "Calibri"
    return shp


def add_arrow(slide, start_shape, end_shape, color=ACCENT_DARK, width=Pt(1.75),
              from_side="right", to_side="left"):
    def point(shape, side):
        if side == "right":
            return (shape.left + shape.width, shape.top + shape.height // 2)
        if side == "left":
            return (shape.left, shape.top + shape.height // 2)
        if side == "bottom":
            return (shape.left + shape.width // 2, shape.top + shape.height)
        if side == "top":
            return (shape.left + shape.width // 2, shape.top)
        raise ValueError(side)

    x1, y1 = point(start_shape, from_side)
    x2, y2 = point(end_shape, to_side)
    conn = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, x1, y1, x2, y2)
    conn.line.color.rgb = color
    conn.line.width = width
    line = conn.line._get_or_add_ln()
    tail = line.makeelement(qn('a:tailEnd'), {'type': 'triangle', 'w': 'med', 'len': 'med'})
    line.append(tail)
    return conn


def footer(slide, text="Mnemosyne — PoC overview"):
    add_text(slide, Inches(0.6), Inches(7.05), Inches(8), Inches(0.35), text,
              size=10, color=MUTED, italic=True)
    add_text(slide, Inches(11.5), Inches(7.05), Inches(1.3), Inches(0.35),
              "", size=10, color=MUTED, align=PP_ALIGN.RIGHT)


# =========================================================================
# Slide 1 — Title
# =========================================================================
s = add_slide()
set_background(s, NAVY)
add_text(s, Inches(1), Inches(2.5), Inches(11.3), Inches(1.4), "Mnemosyne",
          size=60, color=WHITE, bold=True, align=PP_ALIGN.LEFT)
add_text(s, Inches(1.02), Inches(3.75), Inches(11), Inches(0.7),
          "Reconstructing the full dataflow path through black-box TypeScript",
          size=22, color=RGBColor(0xB9, 0xCF, 0xE6))
add_text(s, Inches(1.02), Inches(4.35), Inches(11), Inches(0.5),
          "A source-to-source tracing transpiler, served to AI agents over MCP",
          size=16, color=RGBColor(0x8F, 0xAC, 0xCB), italic=True)
add_text(s, Inches(1.02), Inches(6.6), Inches(6), Inches(0.4),
          "Proof of Concept", size=13, color=RGBColor(0x8F, 0xAC, 0xCB), bold=True)


# =========================================================================
# Slide 2 — The problem
# =========================================================================
s = add_slide()
set_background(s)
add_kicker_title(s, "THE PROBLEM", "“Where did this value actually come from?”")
add_bullets(s, Inches(0.6), Inches(1.7), Inches(6.1), Inches(4.8), [
    "Business logic is chains of opaque functions: inputs in, a result object out.",
    "When a number/string/date is wrong, engineers manually trace it backward through "
    "every intermediate step — by reading code and re-running it in their head.",
    "This is slow for debugging, worse for reverse-engineering someone else's code, and "
    "hardest of all when the answer needs to be shown to someone else (audits, "
    "onboarding, “prove how this number was calculated” requests).",
], size=17, space_after=18)

add_box(s, Inches(7.1), Inches(1.9), Inches(5.6), Inches(1.0),
        "inputs  →  priceBox()  →  labelBox()  →  result",
        fill=BOX_FILL_MUTED, border=BOX_BORDER_MUTED, size=15, color=SLATE, bold=False)
add_text(s, Inches(7.1), Inches(3.05), Inches(5.6), Inches(0.9),
          "Two opaque boxes. A wrong result could originate anywhere inside either one.",
          size=13, color=MUTED, italic=True)
add_box(s, Inches(7.1), Inches(4.2), Inches(5.6), Inches(1.9),
        "Mnemosyne's answer:\nrun it once, get back a diagram\nshowing every named "
        "variable, every\noperation, and every source line\nthat produced the result.",
        fill=BOX_FILL, border=BOX_BORDER, size=15, color=NAVY, bold=False)
footer(s)


# =========================================================================
# Slide 3 — Why this is hard in TS/JS
# =========================================================================
s = add_slide()
set_background(s)
add_kicker_title(s, "WHY IT'S HARD", "JavaScript/TypeScript has neither trick Python has")

headers = ["Capability", "Python (JAX, Autograd, SymPy...)", "TS at runtime", "Mnemosyne (compile-time)"]
rows = [
    ["Trace native + - * / < >", "✅ operator overloading", "❌ impossible", "✅ rewrite the AST"],
    ["Recover internal variable names", "❌ invents its own names", "❌ erased after compile", "✅ read from source"],
    ["Exact source line per op", "partial", "⚠️ stack-trace hacks", "✅ exact, from the AST"],
]

col_w = [Inches(3.0), Inches(3.5), Inches(2.3), Inches(3.6)]
left0 = Inches(0.6)
top0 = Inches(1.85)
row_h = Inches(0.7)
header_h = Inches(0.55)

x = left0
for i, htext in enumerate(headers):
    add_box(s, x, top0, col_w[i], header_h, htext, fill=NAVY, border=NAVY, size=13,
            color=WHITE, bold=True)
    x += col_w[i]

for r, row in enumerate(rows):
    y = top0 + header_h + r * row_h
    x = left0
    for i, cell in enumerate(row):
        fill = BOX_FILL if i == 3 else WHITE
        border = BOX_BORDER if i == 3 else RGBColor(0xCC, 0xCC, 0xCC)
        add_box(s, x, y, col_w[i], row_h, cell, fill=fill, border=border, size=12.5,
                color=BODY, bold=(i == 3), shape_type=MSO_SHAPE.RECTANGLE)
        x += col_w[i]

add_text(s, Inches(0.6), Inches(4.7), Inches(12.1), Inches(0.9),
          "The core realization: operator overloading and variable-name recovery are "
          "impossible at runtime in JS/TS — but both fall out naturally once you "
          "transform the source before it runs. Same technique Istanbul uses for code "
          "coverage, applied to dataflow instead of line hits.",
          size=15, color=SLATE, italic=True)
footer(s)


# =========================================================================
# Slide 4 — The approach: side-channel tracing
# =========================================================================
s = add_slide()
set_background(s)
add_kicker_title(s, "THE APPROACH", "Side-channel tracing: values flow through unchanged")

add_text(s, Inches(0.6), Inches(1.7), Inches(12), Inches(0.4), "Source",
          size=13, color=MUTED, bold=True)
b1 = add_box(s, Inches(0.6), Inches(2.05), Inches(3.6), Inches(0.9),
             "const total =\n  subtotal + tax;", fill=WHITE, border=RGBColor(0xAA, 0xAA, 0xAA),
             size=14, color=BODY, bold=False, shape_type=MSO_SHAPE.RECTANGLE)

add_text(s, Inches(4.55), Inches(1.7), Inches(4.3), Inches(0.4), "Babel plugin rewrites it to",
          size=13, color=MUTED, bold=True)
b2 = add_box(s, Inches(4.55), Inches(2.05), Inches(4.3), Inches(0.9),
             "const total = __t.op(\n  '+', subtotal, tax, {...});",
             fill=BOX_FILL, border=BOX_BORDER, size=13, color=NAVY, bold=False,
             shape_type=MSO_SHAPE.RECTANGLE)

add_text(s, Inches(9.15), Inches(1.7), Inches(3.6), Inches(0.4), "at runtime, this...",
          size=13, color=MUTED, bold=True)
b3 = add_box(s, Inches(9.15), Inches(2.05), Inches(3.6), Inches(0.9),
             "computes subtotal + tax\nAND records a tape node",
             fill=BOX_FILL_ALT, border=BOX_BORDER_ALT, size=13, color=NAVY, bold=False,
             shape_type=MSO_SHAPE.RECTANGLE)

add_arrow(s, b1, b2)
add_arrow(s, b2, b3)

add_bullets(s, Inches(0.6), Inches(3.35), Inches(12.1), Inches(2.0), [
    "The real value flows through completely unchanged — the program's output is provably "
    "identical (proven on every run by diffing plain vs. instrumented output).",
    "Each rewritten operation records one node into an in-memory tape as a side effect: "
    "the operation, its inputs' provenance, the real runtime value, and the source line.",
    "One linear, concrete execution path — exactly what ran, in order. No speculative "
    "branches, no symbolic “possible” values.",
], size=15, space_after=12)
footer(s)


# =========================================================================
# Slide 5 — Architecture
# =========================================================================
s = add_slide()
set_background(s)
add_kicker_title(s, "ARCHITECTURE", "Four decoupled components")

comp_w, comp_h = Inches(2.75), Inches(1.5)
gap = Inches(0.55)
top_y = Inches(2.3)
xs = [Inches(0.6) + i * (comp_w + gap) for i in range(4)]

labels = [
    ("transform.ts", "Babel plugin\nAST-in / AST-out"),
    ("runtime.ts", "the __t tape\nbuilds the DAG"),
    ("export-\nmermaid.ts", "DAG → JSON /\nMermaid / DOT"),
    ("mcp-server.ts", "serves the DAG\nto an AI agent"),
]
boxes = []
for x, (name, desc) in zip(xs, labels):
    b = add_box(s, x, top_y, comp_w, comp_h, name + "\n\n" + desc, fill=BOX_FILL,
                border=BOX_BORDER, size=14, color=NAVY, bold=True)
    boxes.append(b)

for i in range(3):
    add_arrow(s, boxes[i], boxes[i + 1])

add_text(s, Inches(0.6), Inches(4.15), Inches(12.1), Inches(0.4),
          "pipeline.ts — shared glue: compiles example.ts twice (plain / instrumented), "
          "runs both in isolated vm contexts, diffs output.",
          size=13, color=MUTED, italic=True)

add_bullets(s, Inches(0.6), Inches(4.75), Inches(12.1), Inches(2.0), [
    "Each component only knows the shape of what it consumes, not how the upstream one "
    "produced it — the transpiler doesn't know how the tape stores nodes; the renderer "
    "doesn't know how nodes were produced.",
    "Node identity: provenance resolves via a runtime call-frame stack that mirrors real "
    "JS scoping (params/bindings register on write, reads walk the stack outward) — "
    "plus literal leaves and a same-statement fallback for unnamed sub-expressions.",
], size=15, space_after=12)
footer(s)


# =========================================================================
# Slide 6 — The example DAG
# =========================================================================
s = add_slide()
set_background(s)
add_kicker_title(s, "LIVE EXAMPLE", "Two chained black boxes, one diagram")

row1_y = Inches(1.75)
row2_y = Inches(2.75)
row3_y = Inches(3.75)
small_w, small_h = Inches(1.55), Inches(0.65)

env_box = add_box(s, Inches(0.6), row1_y, Inches(2.2), small_h,
                   "process.env\n.TAX_RATE = 0.08", fill=BOX_FILL_ALT, border=BOX_BORDER_ALT,
                   size=11)
num_box = add_box(s, Inches(3.15), row1_y, small_w, small_h, ".Number()", fill=BOX_FILL,
                   border=BOX_BORDER, size=12)
rate_box = add_box(s, Inches(5.05), row1_y, small_w, small_h, "TAX_RATE\n(const)", fill=BOX_FILL,
                    border=BOX_BORDER, size=12)
add_arrow(s, env_box, num_box)
add_arrow(s, num_box, rate_box)

price_box = add_box(s, Inches(0.6), row2_y, small_w, small_h, "price\n(param) 19.99", fill=BOX_FILL_ALT,
                     border=BOX_BORDER_ALT, size=11)
qty_box = add_box(s, Inches(0.6), row3_y, small_w, small_h, "qty\n(param) 3", fill=BOX_FILL_ALT,
                   border=BOX_BORDER_ALT, size=11)
mul_box = add_box(s, Inches(2.5), row2_y + Inches(0.5), Inches(0.9), small_h, "*", fill=WHITE,
                   border=RGBColor(0x88, 0x88, 0x88), size=16, shape_type=MSO_SHAPE.OVAL)
add_arrow(s, price_box, mul_box)
add_arrow(s, qty_box, mul_box)

subtotal_box = add_box(s, Inches(3.75), row2_y + Inches(0.5), small_w, small_h,
                        "subtotal\n(local) 59.97", fill=BOX_FILL, border=BOX_BORDER, size=11)
add_arrow(s, mul_box, subtotal_box)

mul2_box = add_box(s, Inches(5.65), row2_y + Inches(0.5), Inches(0.9), small_h, "*", fill=WHITE,
                    border=RGBColor(0x88, 0x88, 0x88), size=16, shape_type=MSO_SHAPE.OVAL)
add_arrow(s, subtotal_box, mul2_box)
add_arrow(s, rate_box, mul2_box, from_side="bottom", to_side="top")

tax_box = add_box(s, Inches(6.9), row2_y + Inches(0.5), small_w, small_h, "tax\n(local) 4.80",
                   fill=BOX_FILL, border=BOX_BORDER, size=11)
add_arrow(s, mul2_box, tax_box)

add_box_plus = add_box(s, Inches(8.8), row2_y + Inches(0.5), Inches(0.9), small_h, "+", fill=WHITE,
                        border=RGBColor(0x88, 0x88, 0x88), size=16, shape_type=MSO_SHAPE.OVAL)
add_arrow(s, subtotal_box, add_box_plus, from_side="top", to_side="top")
add_arrow(s, tax_box, add_box_plus)

total_box = add_box(s, Inches(10.05), row2_y + Inches(0.5), small_w, small_h,
                     "priceBox.total\n(output) 64.77", fill=BOX_FILL, border=BOX_BORDER,
                     size=11)
add_arrow(s, add_box_plus, total_box)

chain_box = add_box(s, Inches(9.0), Inches(5.35), Inches(3.3), Inches(0.8),
                     "↓ feeds into labelBox() as a param →\nlabelBox.summary includes it as text",
                     fill=BOX_FILL_MUTED, border=BOX_BORDER_MUTED, size=11, bold=False)
add_arrow(s, total_box, chain_box, from_side="bottom", to_side="top")

add_text(s, Inches(0.6), Inches(5.5), Inches(7.8), Inches(1.4),
          "Every node above is real: this is the actual trace from examples/example.ts, "
          "captured with npm run trace. Change TAX_RATE and re-run — the values (and "
          "the diagram) update; the shape of the DAG doesn't need to be redrawn by hand.",
          size=14, color=SLATE, italic=True)
footer(s)


# =========================================================================
# Slide 7 — MCP: the AI-helper story
# =========================================================================
s = add_slide()
set_background(s)
add_kicker_title(s, "AI-HELPER WORKFLOW", "Run once. Query the DAG, not the source.")

left_box = add_box(s, Inches(0.6), Inches(1.9), Inches(3.6), Inches(1.1),
                    "Without Mnemosyne:\nagent re-reads & mentally\nsimulates source on every\nfollow-up question",
                    fill=BOX_FILL_MUTED, border=BOX_BORDER_MUTED, size=13, bold=False)
right_box = add_box(s, Inches(4.7), Inches(1.9), Inches(3.6), Inches(1.1),
                     "With Mnemosyne:\nrun_trace once → every\nfollow-up answered from\nthe cached DAG",
                     fill=BOX_FILL, border=BOX_BORDER, size=13, bold=False)
add_arrow(s, left_box, right_box)

tools = [
    ("run_trace", "Run the instrumented program once (optionally with different env vars); cache the DAG."),
    ("find_variable_origin", "Given a name or output attribute, return where it was set and its full ancestry."),
    ("query_causality", "Trace a value backward (ancestry) or forward (descendants) through the DAG."),
    ("get_diagram", "Mermaid diagram — the whole trace, or a sub-graph for one value."),
    ("get_execution_summary", "Inputs, output attributes, black boxes touched, node count."),
]
y = Inches(3.35)
for name, desc in tools:
    name_box = add_box(s, Inches(0.6), y, Inches(2.6), Inches(0.65), name, fill=ACCENT,
                        border=ACCENT_DARK, size=12.5, color=WHITE, bold=True,
                        shape_type=MSO_SHAPE.RECTANGLE)
    add_text(s, Inches(3.35), y, Inches(9.3), Inches(0.65), desc, size=13, color=BODY,
              anchor=MSO_ANCHOR.MIDDLE)
    y += Inches(0.72)

add_text(s, Inches(0.6), Inches(6.9), Inches(12), Inches(0.4),
          "Tool vocabulary borrowed deliberately from Chronos (github.com/Rubentxu/chronos) rather than reinvented.",
          size=11, color=MUTED, italic=True)


# =========================================================================
# Slide 8 — Scope
# =========================================================================
s = add_slide()
set_background(s)
add_kicker_title(s, "SCOPE", "What's traced today, what's deferred")

add_box(s, Inches(0.6), Inches(1.8), Inches(5.9), Inches(0.55), "IN SCOPE", fill=BOX_FILL_ALT,
        border=BOX_BORDER_ALT, size=15, color=NAVY, bold=True, shape_type=MSO_SHAPE.RECTANGLE)
add_bullets(s, Inches(0.6), Inches(2.5), Inches(5.9), Inches(4.3), [
    "Binary arithmetic: + - * /",
    "Comparisons: < > <= >= === !==",
    "Generic method calls: obj.method(args)",
    "Function calls, with argument-name capture",
    "const/let bindings and simple assignment",
    "return, including per-attribute tracing of\nobject-literal returns",
    "process.env.* and module-level const capture",
], size=15, space_after=12)

add_box(s, Inches(6.85), Inches(1.8), Inches(5.9), Inches(0.55), "DEFERRED", fill=BOX_FILL_MUTED,
        border=BOX_BORDER_MUTED, size=15, color=SLATE, bold=True, shape_type=MSO_SHAPE.RECTANGLE)
add_bullets(s, Inches(6.85), Inches(2.5), Inches(5.9), Inches(4.3), [
    "Short-circuit && || ?? ?: (needs careful lowering)",
    "Compound assignment += / unary / ++",
    "Template literals, destructuring, spread",
    "async/await, generators",
    "Loops / per-iteration aggregation",
    "Optional chaining ?.",
    "import / require (see roadmap — next slide)",
], size=15, color=MUTED, space_after=12)
footer(s)


# =========================================================================
# Slide 9 — Known limitations
# =========================================================================
s = add_slide()
set_background(s)
add_kicker_title(s, "HONEST LIMITATIONS", "What to know before you rely on this")

items = [
    ("Call-boundary provenance is coarse for bare property reads",
     "priceBox(...).total used directly resolves to “the object as a whole,” not the "
     "specific attribute — values are never wrapped, so no id travels with them. "
     "Binding it to a local first keeps ancestry precise from that point on."),
    ("Two unnamed sub-expression operands in one op can collide",
     "f() + g() where both sides are complex expressions: the fallback resolution can "
     "attribute both inputs to the same (wrong) node. Not hit by the shipped example; "
     "a real fix needs per-operand id capture at the AST level."),
    ("No import/require support yet",
     "The sandbox doesn't inject require, and ES import isn't parseable by plain vm.Script. "
     "Even once wired up, tracing stops at the package boundary — next slide."),
]
y = Inches(1.85)
for title, desc in items:
    add_text(s, Inches(0.6), y, Inches(12.1), Inches(0.4), title, size=16, color=NAVY, bold=True)
    add_text(s, Inches(0.6), y + Inches(0.42), Inches(12.1), Inches(0.9), desc, size=13.5,
              color=SLATE)
    y += Inches(1.55)
footer(s)


# =========================================================================
# Slide 10 — Roadmap
# =========================================================================
s = add_slide()
set_background(s)
add_kicker_title(s, "ROADMAP", "Next: see inside packages, not just call them")

add_text(s, Inches(0.6), Inches(1.75), Inches(12.1), Inches(0.8),
          "Today, calling into an npm package is (at best) one opaque call node — correct, "
          "but no visibility inside it. The next lever: resolve a package's real source via "
          "its npm registry → GitHub repository link, and trace that too.",
          size=15, color=SLATE)

stageA = add_box(s, Inches(0.6), Inches(2.85), Inches(3.5), Inches(1.15),
                  "1. Resolve\nnpm registry metadata\n→ repository field", fill=BOX_FILL,
                  border=BOX_BORDER, size=13)
stageB = add_box(s, Inches(4.55), Inches(2.85), Inches(3.5), Inches(1.15),
                  "2. Fetch matching\nsource from that repo\n(not the minified dist)",
                  fill=BOX_FILL, border=BOX_BORDER, size=13)
stageC = add_box(s, Inches(8.5), Inches(2.85), Inches(3.5), Inches(1.15),
                  "3. Run the SAME\nBabel plugin over it →\none continuous DAG", fill=BOX_FILL,
                  border=BOX_BORDER, size=13)
add_arrow(s, stageA, stageB)
add_arrow(s, stageB, stageC)

add_bullets(s, Inches(0.6), Inches(4.4), Inches(12.1), Inches(2.6), [
    "Real risk to plan around: most published npm packages ship pre-built/minified JS, not "
    "the readable TS/JS that makes variable-name recovery possible — tracing dist output "
    "would just relabel a + b as mangled args.",
    "Needs version pinning (match the installed version to the right git tag/commit, not "
    "just HEAD), monorepo subpath resolution, and handling packages with no/private repo.",
    "Full design in docs/FUTURE-EXTENSIONS.md — phased: start with a manual repo-path "
    "override for one real dependency before automating registry → repo resolution.",
], size=15, space_after=14)
footer(s)


# =========================================================================
# Slide 11 — Close
# =========================================================================
s = add_slide()
set_background(s, NAVY)
add_text(s, Inches(1), Inches(2.6), Inches(11), Inches(1.0), "Run it once. See the whole path.",
          size=38, color=WHITE, bold=True)
add_bullets(s, Inches(1.02), Inches(3.9), Inches(10.5), Inches(2.5), [
    "npm run trace — see identical output, proven",
    "output/trace.mmd — paste into mermaid.live",
    "npm run mcp — point an AI agent at it",
], size=18, color=RGBColor(0xB9, 0xCF, 0xE6))
add_text(s, Inches(1.02), Inches(6.5), Inches(10), Inches(0.4),
          "docs/DEMO.md — full step-by-step walkthrough", size=13,
          color=RGBColor(0x8F, 0xAC, 0xCB), italic=True)


# =========================================================================
out_path = os.path.join(os.path.dirname(__file__), "Mnemosyne-Overview.pptx")
prs.save(out_path)
print(f"Saved {out_path} ({len(prs.slides)} slides)")
