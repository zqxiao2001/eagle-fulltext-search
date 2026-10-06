# -*- coding: utf-8 -*-
"""生成一个「必须依赖 UniGB-UCS2-H CMap 才能正确解码」的中文 PDF。

原理：reportlab 的 UnicodeCIDFont('STSong-Light') 不嵌入字体，文本以 CID 编码写出，
必须靠内置 CMap 才能映射回 Unicode。因此只要 pdf.js 成功加载了 cmaps/，中文就能正确抽出；
一旦 CMap 加载失败（例如 file:// 下 fetch 被拦），抽出来就是乱码或空白。
这是验证中文 PDF 抽取链路的黄金样本。

用法：python make-cjk-pdf.py
输出：testlib/images/FIXXPDF012.info/cjk-sample.pdf（并刷新 mtime.json）
依赖：reportlab
"""
import os
import json
import shutil
import tempfile

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, 'testlib')

pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))

out = os.path.join(tempfile.gettempdir(), 'ft_cjk_sample.pdf')
c = canvas.Canvas(out)
c.setFont('STSong-Light', 14)
lines = [
    '这是一个必须依赖 CMap 才能正确解码的中文 PDF 样本',
    '第二行包含拉丁术语 SampleTerm 与数字 12345（P = 0.027）',
    '第三行用于验证标点、全角括号与空格是否原样抽取',
    '关键词：示例文稿、字符编码、全文检索',
]
y = 800
for t in lines:
    c.drawString(60, y, t)
    y -= 28
c.save()
print('已生成', out, os.path.getsize(out), 'bytes')

# 放进测试库（仅 testlib，不触碰真实 Eagle 资源库）
d = os.path.join(BASE, 'images', 'FIXXPDF012.info')
os.makedirs(d, exist_ok=True)
shutil.copy(out, os.path.join(d, 'cjk-sample.pdf'))
with open(os.path.join(d, 'metadata.json'), 'w') as f:
    json.dump({"id": "FIXXPDF012", "name": "中文 PDF 样本", "size": os.path.getsize(out),
               "btime": 1790746332000, "mtime": 1790746332000, "ext": "pdf",
               "tags": ["PDF", "中文"], "folders": [], "isDeleted": False, "url": "",
               "annotation": "验证 CMap 加载", "modificationTime": 1790746332000}, f, ensure_ascii=False)

ids = sorted(os.listdir(os.path.join(BASE, 'images')))
with open(os.path.join(BASE, 'mtime.json'), 'w') as f:
    json.dump({i.replace('.info', ''): 1790746332000 for i in ids}, f)
print('测试库条目数：', len(ids))
