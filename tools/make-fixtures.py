# -*- coding: utf-8 -*-
"""构造最小但结构真实的 OOXML/ODF/ePub/RTF 样本 + 一个仿 Eagle 资源库目录。

用途：验证 docx/pptx/xlsx/odt/epub/rtf/html/csv/md/py 的正文提取是否正确
（「该抽到的都抽到、不该抽的没抽到」）。所有内容都是**显然的测试样本**
（统一以「示例」开头），不包含任何真实数据，也不会触碰真实 Eagle 资源库。

用法：python make-fixtures.py
输出：与本脚本同级的 testlib/
"""
import os
import json
import zipfile
import shutil
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, 'testlib')

shutil.rmtree(BASE, ignore_errors=True)
os.makedirs(os.path.join(BASE, 'images'))

CT_DOCX = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
           '<Default Extension="xml" ContentType="application/xml"/>'
           '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
           '<Override PartName="/word/document.xml" '
           'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')


def docx(path, paras, header=None, title='示例文稿标题', desc='全文检索功能验证'):
    body = ''.join('<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % p for p in paras)
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           '<w:body>%s</w:body></w:document>' % body)
    core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/">'
            '<dc:title>%s</dc:title><dc:description>%s</dc:description></cp:coreProperties>' % (title, desc))
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CT_DOCX)
        z.writestr('word/document.xml', doc)
        z.writestr('docProps/core.xml', core)
        if header:
            z.writestr('word/header1.xml',
                       '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                       '<w:p><w:r><w:t>%s</w:t></w:r></w:p></w:hdr>' % header)


def pptx(path, slides, notes):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for i, texts in enumerate(slides, 1):
            xml = ('<?xml version="1.0"?><p:sld '
                   'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                   'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>')
            for t in texts:
                xml += '<p:sp><p:txBody><a:p><a:r><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp>' % t
            xml += '</p:spTree></p:cSld></p:sld>'
            z.writestr('ppt/slides/slide%d.xml' % i, xml)
        z.writestr('ppt/notesSlides/notesSlide1.xml',
                   '<?xml version="1.0"?><p:notes '
                   'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
                   'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                   '<a:p><a:r><a:t>%s</a:t></a:r></a:p></p:notes>' % notes)


def xlsx(path, sheetname, shared, cells_inline):
    ss = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d">%s</sst>' % (
        len(shared), ''.join('<si><t>%s</t></si>' % s for s in shared))
    rows = []
    for i, (sidx, val) in enumerate(cells_inline, 1):
        rows.append('<row r="%d"><c r="A%d" t="s"><v>%d</v></c><c r="B%d"><v>%s</v></c></row>'
                    % (i, i, sidx, i, val))
    sheet = ('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             '<sheetData>%s</sheetData></worksheet>' % ''.join(rows))
    wb = ('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
          '<sheets><sheet name="%s" sheetId="1"/></sheets></workbook>' % sheetname)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('xl/workbook.xml', wb)
        z.writestr('xl/sharedStrings.xml', ss)
        z.writestr('xl/worksheets/sheet1.xml', sheet)


def odt(path, paras):
    body = ''.join('<text:p>%s</text:p>' % p for p in paras)
    content = ('<?xml version="1.0" encoding="UTF-8"?><office:document-content '
               'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
               'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">'
               '<office:body><office:text>%s</office:text></office:body></office:document-content>' % body)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('mimetype', 'application/vnd.oasis.opendocument.text')
        z.writestr('content.xml', content)


def epub(path, chapters):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('mimetype', 'application/epub+zip')
        for i, txt in enumerate(chapters, 1):
            z.writestr('OEBPS/ch%d.xhtml' % i,
                       '<html><head><title>c%d</title><style>p{color:red}</style></head>'
                       '<body><p>%s</p></body></html>' % (i, txt))


def rtf_gbk_bytes(text_lines):
    """把文本按 GBK 逐字节转成 RTF 的 \\'xx 转义。

    手写转义极易出错（改一个字就得重算），这里从 bytes 程序化生成，
    任何内容都能直接用。字体表指定 fcharset134（GB2312），ansicpg936。
    """
    head = (r'{\rtf1\ansi\ansicpg936\deff0'
            r'{\fonttbl{\f0\fnil\fcharset134 SimSun;}}'
            r'\f0\fs24 ')
    out = head
    for line in text_lines:
        body = ''.join(r"\'%02x" % b for b in line.encode('gbk'))
        out += body + r'\par '
    out += '}'
    return out.encode('latin-1')


def add_item(iid, filename, content_bytes, name, annotation='', tags=None, folders=None):
    d = os.path.join(BASE, 'images', iid + '.info')
    os.makedirs(d, exist_ok=True)
    fp = os.path.join(d, filename)
    with open(fp, 'wb') as f:
        f.write(content_bytes)
    meta = {"id": iid, "name": name, "size": len(content_bytes),
            "btime": 1790746332000, "mtime": 1790746332000,
            "ext": os.path.splitext(filename)[1].lstrip('.'), "tags": tags or [],
            "folders": folders or [], "isDeleted": False, "url": "",
            "annotation": annotation, "modificationTime": 1790746332000}
    with open(os.path.join(d, 'metadata.json'), 'w') as f:
        json.dump(meta, f, ensure_ascii=False)


tmp = os.path.join(tempfile.gettempdir(), 'ft_fixtures')
shutil.rmtree(tmp, ignore_errors=True)
os.makedirs(tmp, exist_ok=True)
P = lambda n: os.path.join(tmp, n)

# ---- 各种格式的样本 ----
docx(P('manuscript.docx'),
     ['这是一个用于验证全文检索功能的中文示例段落。',
      '第二个段落包含拉丁术语 SampleTerm 与数字 12345，用于测试中英混排分词。',
      '关键词：示例文稿、全文检索、字符编码'],
     header='示例页眉文字')

pptx(P('slide.pptx'),
     [['示例演示文稿标题', '幻灯片正文条目甲'],
      ['第二页标题', '幻灯片正文条目乙']],
     notes='讲稿备注：这一页用于验证备注页内容能否被检索到')

xlsx(P('tables.xlsx'), '示例工作表',
     ['甲类条目', '乙类条目', '丙类条目', '处理组'],
     [(0, 128), (1, 402), (2, 96), (3, 4)])

odt(P('note.odt'),
    ['这是 ODT 格式的示例段落，用于验证 ODF 解析。',
     '数值示例 3.14'])

epub(P('book.epub'), ['第一章：示例章节甲', '第二章：示例章节乙'])

with open(P('report.rtf'), 'wb') as f:
    f.write(rtf_gbk_bytes(['示例中文内容测试', 'Keywords: sample rtf report']))

with open(P('scan.csv'), 'w', encoding='utf-8') as f:
    f.write('编号,分组,数值\n1113,甲组,0.17\n1114,乙组,0.51\n')

with open(P('result.csv'), 'w', encoding='gbk') as f:
    f.write('名称,差值,显著性\n示例甲,-1.8,0.002\n')

with open(P('methods.md'), 'w', encoding='utf-8') as f:
    f.write('# 方法\n示例段落，用于验证 Markdown 正文提取。\n')

with open(P('script.py'), 'w', encoding='utf-8') as f:
    f.write('def load(path):\n    return open(path, encoding="utf-8").read()  # 示例注释\n')

with open(P('index.html'), 'w', encoding='utf-8') as f:
    f.write('<html><head><style>body{color:#111}</style>'
            '<script>var x="不应被索引的脚本内容";</script></head>'
            '<body><h1>示例页面标题</h1><p>示例正文段落，用于验证 HTML 正文提取。</p></body></html>')

# ---- 组装成仿 Eagle 资源库 ----
read = lambda n: open(P(n), 'rb').read()
add_item('FIXDOCX001', 'manuscript.docx', read('manuscript.docx'), '示例文稿', '含页眉与文档属性', ['文稿', '示例'])
add_item('FIXPPTX002', 'slide.pptx', read('slide.pptx'), '示例演示文稿', '含讲稿备注', ['演示'])
add_item('FIXLSX003', 'tables.xlsx', read('tables.xlsx'), '示例计数表', '', ['表格'])
add_item('FIXODT004', 'note.odt', read('note.odt'), '示例 ODT 记录', 'ODF 提取验证', [])
add_item('FIXEPUB005', 'book.epub', read('book.epub'), '示例电子书', '', ['教材'])
add_item('FIXRTF006', 'report.rtf', read('report.rtf'), 'GBK 编码 RTF 报告', '', [])
add_item('FIXCSV007', 'scan.csv', read('scan.csv'), 'UTF-8 编码表格', '', [])
add_item('FIXCSV008', 'result.csv', read('result.csv'), 'GBK 编码表格', '', ['表格'])
add_item('FIXMD009', 'methods.md', read('methods.md'), '示例方法草稿', '', [])
add_item('FIXPY010', 'script.py', read('script.py'), '示例脚本', '', [])
add_item('FIXHTM011', 'index.html', read('index.html'), 'HTML 示例页', '', [])

with open(os.path.join(BASE, 'metadata.json'), 'w') as f:
    json.dump({"folders": [{"id": "F001", "name": "示例文件夹甲"},
                           {"id": "F002", "name": "示例文件夹乙"}],
               "smartFolders": [], "quickAccess": [], "tagsGroups": [],
               "modificationTime": 1791267936884, "applicationVersion": "4.0.0"}, f, ensure_ascii=False)

ids = sorted(os.listdir(os.path.join(BASE, 'images')))
with open(os.path.join(BASE, 'mtime.json'), 'w') as f:
    json.dump({i.replace('.info', ''): 1790746332000 for i in ids}, f)

print('测试库已生成：', BASE, ' 条目数：', len(ids))
