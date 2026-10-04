from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from PIL import Image
import math

pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
W, H = A4
OUT = __import__("os").path.dirname(__import__("os").path.abspath(__file__)) + "/"

def para(c, x, y, lines, size=11, lead=15, font='Helvetica'):
    c.setFont(font, size)
    for line in lines:
        c.drawString(x, y, line)
        y -= lead
    return y

LOREM = ["The quick brown fox jumps over the lazy dog while the committee",
         "reviews the quarterly report and discusses the numbers shown below.",
         "Each figure was measured under identical laboratory conditions."]

# 1. ruled grid table + paragraph + image
c = canvas.Canvas(OUT + 'ruled.pdf', pagesize=A4)
y = para(c, 60, H - 80, LOREM)
rows = [["Region", "Q1", "Q2", "Q3"], ["North", "1,200", "1,350", "1,500"],
        ["South", "980", "1,010", "1,120"], ["East", "1,450", "1,500", "1,610"]]
x0, ytop = 60, y - 20
cw, rh = [140, 90, 90, 90], 24
c.setLineWidth(0.7)
for r in range(len(rows) + 1):
    c.line(x0, ytop - r * rh, x0 + sum(cw), ytop - r * rh)
xx = x0
for i in range(len(cw) + 1):
    c.line(xx, ytop, xx, ytop - len(rows) * rh)
    if i < len(cw): xx += cw[i]
c.setFont('Helvetica', 11)
for r, row in enumerate(rows):
    xx = x0
    for i, t in enumerate(row):
        c.drawString(xx + 6, ytop - r * rh - 16, t)
        xx += cw[i]
y = ytop - len(rows) * rh - 30
y = para(c, 60, y, ["Table 1 shows regional sales. The next paragraph continues the analysis."])
img = Image.new('RGB', (30, 18), (230, 120, 60))
for i in range(30):
    for j in range(18):
        img.putpixel((i, j), (int(255 * i / 30), int(255 * j / 18), 140))
img.save(OUT + 'photo.png')
c.drawImage(ImageReader(OUT + 'photo.png'), 100, y - 200, width=300, height=180)
import os; os.remove(OUT + 'photo.png')
para(c, 60, y - 230, ["Figure 1: gradient test image."])
c.showPage(); c.save()

# 2. booktabs (three horizontal rules only)
c = canvas.Canvas(OUT + 'booktabs.pdf', pagesize=A4)
y = para(c, 60, H - 80, LOREM)
ytop = y - 15
rows = [["Method", "Accuracy", "F1", "Params"], ["Baseline", "81.2", "79.8", "12M"],
        ["Ours", "86.5", "85.1", "14M"], ["Ours+", "88.0", "86.9", "30M"]]
c.setLineWidth(1.0); c.line(60, ytop, 480, ytop)
c.setFont('Helvetica-Bold', 11)
cx = [60, 200, 300, 400]
for i, t in enumerate(rows[0]): c.drawString(cx[i], ytop - 16, t)
c.setLineWidth(0.5); c.line(60, ytop - 24, 480, ytop - 24)
c.setFont('Helvetica', 11)
for r in range(1, 4):
    for i, t in enumerate(rows[r]): c.drawString(cx[i], ytop - 24 - r * 18, t)
c.setLineWidth(1.0); c.line(60, ytop - 24 - 3 * 18 - 8, 480, ytop - 24 - 3 * 18 - 8)
para(c, 60, ytop - 24 - 3 * 18 - 30, ["Results favour the proposed method on every metric."])
c.showPage(); c.save()

# 3. rule-less aligned table (Chinese)
c = canvas.Canvas(OUT + 'plain.pdf', pagesize=A4)
y = para(c, 60, H - 80, ["下表列出了三种方案的主要参数，请注意单位。"], font='STSong-Light', size=12, lead=18)
y -= 14
rows = [["方案", "成本(万元)", "工期(天)", "风险"], ["甲", "120", "45", "低"],
        ["乙", "98", "60", "中"], ["丙", "150", "30", "高"]]
cx = [60, 170, 290, 400]
c.setFont('STSong-Light', 12)
for r, row in enumerate(rows):
    for i, t in enumerate(row): c.drawString(cx[i], y - r * 20, t)
para(c, 60, y - 4 * 20 - 20, ["综合来看，乙方案在成本与风险之间最为平衡。"], font='STSong-Light', size=12, lead=18)
c.showPage(); c.save()

# 4. vector chart (bars + curve + labels)
c = canvas.Canvas(OUT + 'chart.pdf', pagesize=A4)
y = para(c, 60, H - 80, LOREM)
base = y - 200
c.setLineWidth(1); c.line(80, base, 80, base + 150); c.line(80, base, 400, base)
for i, v in enumerate([40, 90, 60, 120, 100]):
    c.setFillColorRGB(0.2, 0.4 + 0.1 * i, 0.8)
    c.rect(100 + i * 55, base, 35, v, fill=1, stroke=0)
c.setFillColorRGB(0, 0, 0)
c.setStrokeColorRGB(0.8, 0.1, 0.1)
p = c.beginPath(); p.moveTo(100, base + 20)
for i in range(1, 6): p.curveTo(100 + i * 55 - 30, base + 30 * i, 100 + i * 55 - 10, base + 20 * i + 20, 100 + i * 55, base + 25 * i + 10)
c.drawPath(p, stroke=1, fill=0)
c.setFont('Helvetica', 8)
for i, t in enumerate(['Jan', 'Feb', 'Mar', 'Apr', 'May']): c.drawString(105 + i * 55, base - 12, t)
para(c, 60, base - 40, ["Figure 2: monthly output."])
c.showPage(); c.save()

# 5. plain prose only (must be untouched) + a framed call-out box
c = canvas.Canvas(OUT + 'prose.pdf', pagesize=A4)
y = H - 80
for k in range(3):
    y = para(c, 60, y, LOREM * 2) - 10
c.rect(60, y - 60, 400, 50, stroke=1, fill=0)
c.setFont('Helvetica', 11); c.drawString(70, y - 30, "Note: this is a framed call-out, not a table.")
c.showPage(); c.save()
print('ok')
