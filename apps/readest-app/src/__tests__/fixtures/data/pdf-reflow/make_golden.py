"""Generate the reflow golden page set (pdfReflowGolden.test.ts).

    python3 make_golden.py   # needs reportlab + Pillow; rewrites ../pdfReflowGoldenFixtures.ts

Each page is a small real PDF covering one layout the reflow rules must keep
handling: prose, headings, running headers/page numbers, footnotes, lists, two
columns, tables of several kinds, figures, watermarks, code, scans. Pages are
inlined as base64 so the patch carries no binary files.
"""
import base64, io, math, os
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from PIL import Image

pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
W, H = A4
CN = 'STSong-Light'
HERE = os.path.dirname(os.path.abspath(__file__))
PAGES = {}

ZH = [
    '尺寸的变化或时间的变化将会影响形状、功能和行为。如果事物的尺寸增大或减小，',
    '它的重量、力量和表面积都会以不同的速度发生变化。物体的长度增加两倍，',
    '表面积则增为原来的四倍，体积增为原来的八倍。这一规律适用于一切物体。',
]
EN = [
    'The quick brown fox jumps over the lazy dog while the committee reviews',
    'the quarterly report and discusses the numbers shown in the appendix.',
    'Each figure was measured under identical laboratory conditions.',
]


def page(name):
    def deco(fn):
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=A4, invariant=1)
        fn(c)
        c.showPage()
        c.save()
        PAGES[name] = base64.b64encode(buf.getvalue()).decode()
        return fn
    return deco


def para(c, x, y, lines, size=11, lead=15, font='Helvetica'):
    c.setFont(font, size)
    for line in lines:
        c.drawString(x, y, line)
        y -= lead
    return y


def zh(c, x, y, lines, size=12, lead=18):
    return para(c, x, y, lines, size, lead, CN)


def gradient(w=30, h=18):
    img = Image.new('RGB', (w, h))
    for i in range(w):
        for j in range(h):
            img.putpixel((i, j), (int(255 * i / w), int(255 * j / h), 140))
    b = io.BytesIO()
    img.save(b, 'PNG')
    b.seek(0)
    return ImageReader(b)


@page('zh-prose')
def _(c):
    zh(c, 60, H - 80, ZH + ZH)


@page('zh-headings')
def _(c):
    c.setFont(CN, 20); c.drawString(60, H - 80, '第二节 尺寸和极限')
    c.setFont(CN, 15); c.drawString(60, H - 120, '尺寸和时间')
    y = zh(c, 60, H - 150, ZH)
    c.setFont(CN, 15); c.drawString(60, y - 20, '为什么恐龙的头比躯体小？')
    zh(c, 60, y - 50, ZH[:2])


@page('running-header-footer')
def _(c):
    c.setFont(CN, 9); c.drawString(60, H - 40, '探索智慧：从达尔文到芒格')
    c.drawRightString(W - 60, H - 40, '第二章')
    zh(c, 60, H - 90, ZH + ZH[:1])
    c.setFont('Helvetica', 9); c.drawCentredString(W / 2, 40, '127')


@page('footnote')
def _(c):
    y = zh(c, 60, H - 80, ZH)
    c.setLineWidth(0.5); c.line(60, 110, 200, 110)
    c.setFont(CN, 8); c.drawString(60, 96, '① 这里的“长度”指物体任一方向上的线性尺寸。')
    c.drawString(60, 84, '② 参见第三章的讨论。')


@page('bullets')
def _(c):
    y = zh(c, 60, H - 80, ['影响生物尺寸的三个因素：'])
    for item in ['• 重量随体积增长，按长度的立方变化；', '• 力量随横截面增长，按长度的平方变化；',
                 '• 散热随表面积增长，同样按长度的平方变化。']:
        c.setFont(CN, 12); c.drawString(72, y, item); y -= 20
    zh(c, 60, y - 10, ['因此尺寸存在上限。'])


@page('numbered')
def _(c):
    y = para(c, 60, H - 80, ['Steps to reproduce the measurement:'])
    for i, t in enumerate(['Weigh the sample and record the mass.', 'Measure each side twice.',
                           'Compute the surface-to-volume ratio.'], 1):
        c.setFont('Helvetica', 11); c.drawString(72, y, f'{i}. {t}'); y -= 16
    para(c, 60, y - 10, ['Repeat for every sample in the batch.'])


@page('two-column')
def _(c):
    left = ['Size matters in biology. A mouse can', 'fall from a building and walk away,',
            'while a horse would not survive.', 'The reason is the ratio of surface']
    right = ['area to volume. Air resistance acts', 'on the surface, weight on the volume,',
             'so small animals fall slowly.', 'Large ones fall fast and hard.']
    para(c, 50, H - 80, left)
    para(c, W / 2 + 10, H - 80, right)


@page('hyphenated')
def _(c):
    para(c, 60, H - 80, ['The experiment demonstrated that thermo-',
                         'dynamic constraints limit the maximum size', 'of terrestrial animals.'])


@page('ruled-table')
def _(c):
    y = para(c, 60, H - 80, EN[:2]) - 20
    rows = [['Region', 'Q1', 'Q2'], ['North', '1,200', '1,350'], ['South', '980', '1,010']]
    cw, rh = [140, 90, 90], 24
    for r in range(len(rows) + 1): c.line(60, y - r * rh, 60 + sum(cw), y - r * rh)
    xx = 60
    for i in range(len(cw) + 1):
        c.line(xx, y, xx, y - len(rows) * rh)
        if i < len(cw): xx += cw[i]
    c.setFont('Helvetica', 11)
    for r, row in enumerate(rows):
        xx = 60
        for i, t in enumerate(row): c.drawString(xx + 6, y - r * rh - 16, t); xx += cw[i]
    para(c, 60, y - len(rows) * rh - 30, ['Table 1 shows regional sales.'])


@page('zh-ruleless-table')
def _(c):
    y = zh(c, 60, H - 80, ['下表列出了三种方案的主要参数。']) - 14
    rows = [['方案', '成本(万元)', '工期(天)'], ['甲', '120', '45'], ['乙', '98', '60'], ['丙', '150', '30']]
    c.setFont(CN, 12)
    for r, row in enumerate(rows):
        for i, t in enumerate(row): c.drawString([60, 170, 290][i], y - r * 20, t)
    zh(c, 60, y - 4 * 20 - 20, ['综合来看，乙方案最为平衡。'])


@page('sparse-mixed-table')
def _(c):
    y = zh(c, 60, H - 80, ['表 1 大方块冰和小方块冰的数据变化']) - 20
    c.setFont(CN, 10)
    for r, label in enumerate(['边长', '横切面面积', '总表面积（6面）']):
        c.drawString(60, y - r * 46, label)
    c.setFont('Helvetica', 20)
    for r, (a, b) in enumerate([('1', '2'), ('1', '4'), ('48', '24')]):
        c.drawString(260, y - r * 46, a); c.drawString(400, y - r * 46, b)
    zh(c, 60, y - 3 * 46 - 20, ['正如以上所看到的，大方块冰单位体积的表面积更小。'])


@page('figure-caption')
def _(c):
    y = para(c, 60, H - 80, EN)
    c.drawImage(gradient(), 100, y - 220, width=300, height=180)
    para(c, 60, y - 245, ['Figure 1: gradient test image.'])


@page('vector-chart')
def _(c):
    y = para(c, 60, H - 80, EN[:1])
    base = y - 200
    c.line(80, base, 80, base + 150); c.line(80, base, 400, base)
    for i, v in enumerate([40, 90, 60, 120, 100]):
        c.setFillColorRGB(0.2, 0.4 + 0.1 * i, 0.8); c.rect(100 + i * 55, base, 35, v, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0); c.setFont('Helvetica', 8)
    for i, t in enumerate(['Jan', 'Feb', 'Mar', 'Apr', 'May']): c.drawString(105 + i * 55, base - 12, t)
    para(c, 60, base - 40, ['Figure 2: monthly output.'])


@page('tiled-watermark')
def _(c):
    mark = gradient(12, 12)
    for i in range(4):
        for j in range(6):
            c.drawImage(mark, 40 + i * 140, 60 + j * 130, width=40, height=40)
    zh(c, 60, H - 80, ZH)


@page('tilted-text-watermark')
def _(c):
    zh(c, 60, H - 80, ZH)
    c.saveState(); c.translate(W / 2, H / 2); c.rotate(35)
    c.setFillColorRGB(0.85, 0.85, 0.85); c.setFont('Helvetica', 48)
    c.drawCentredString(0, 0, 'SAMPLE COPY')
    c.restoreState()


@page('paper-fill')
def _(c):
    c.setFillColorRGB(0.98, 0.96, 0.9); c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0)
    zh(c, 60, H - 80, ZH)


@page('code-listing')
def _(c):
    y = para(c, 60, H - 80, ['The helper below computes the ratio:'])
    for line in ['def ratio(side):            # side in cm', '    area = 6 * side ** 2     # surface',
                 '    volume = side ** 3       # volume', '    return area / volume']:
        c.setFont('Courier', 10); c.drawString(72, y, line); y -= 14
    para(c, 60, y - 10, ['Smaller cubes give larger ratios.'])


@page('framed-callout')
def _(c):
    y = para(c, 60, H - 80, EN)
    c.rect(60, y - 60, 400, 50, stroke=1, fill=0)
    c.setFont('Helvetica', 11); c.drawString(70, y - 30, 'Note: this is a framed call-out, not a table.')


@page('scan-no-text')
def _(c):
    c.drawImage(gradient(60, 80), 40, 40, width=W - 80, height=H - 80)


@page('mixed-zh-en')
def _(c):
    zh(c, 60, H - 80, ['芒格把这种方法称为 latticework of mental models，', '即“多元思维模型”。他认为 80 到 90 个模型',
                       '就足以覆盖大部分判断。'])


@page('superscript-math')
def _(c):
    y = para(c, 60, H - 80, ['Surface grows with the square of length:'])
    c.setFont('Helvetica', 12); c.drawString(90, y - 6, 'A = 6L'); c.setFont('Helvetica', 8); c.drawString(126, y, '2')
    c.setFont('Helvetica', 12); c.drawString(90, y - 30, 'V = L'); c.setFont('Helvetica', 8); c.drawString(119, y - 24, '3')
    para(c, 60, y - 60, ['so the ratio A/V falls as L grows.'])


@page('dense-numeric-table')
def _(c):
    y = H - 80
    c.setFont('Helvetica-Bold', 9)
    head = ['Year', 'Q1', 'Q2', 'Q3', 'Q4', 'Total']
    for i, t in enumerate(head): c.drawString(60 + i * 75, y, t)
    c.setFont('Helvetica', 9)
    for r in range(8):
        vals = [str(2016 + r)] + [str(100 + r * 7 + k * 3) for k in range(4)]
        vals.append(str(sum(int(v) for v in vals[1:])))
        for i, t in enumerate(vals): c.drawString(60 + i * 75, y - (r + 1) * 14, t)
    para(c, 60, y - 10 * 14 - 10, ['All figures in thousands.'])


out = ['// Generated by pdf-reflow/make_golden.py (reportlab). Golden reflow pages for',
       '// pdfReflowGolden.test.ts. Inline so the patch carries no binary files.',
       'export const GOLDEN_PDFS: Record<string, string> = {']
for name, data in PAGES.items():
    out.append(f"  '{name}':")
    out.append(f"    '{data}',")
out.append('};')
target = os.path.join(HERE, '..', 'pdfReflowGoldenFixtures.ts')
open(target, 'w').write('\n'.join(out) + '\n')
print(len(PAGES), 'pages ->', target, os.path.getsize(target), 'bytes')
