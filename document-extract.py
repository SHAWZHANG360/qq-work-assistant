"""Bounded, text-only document parser. Input bytes arrive on stdin, never a path.

Office XML is read from memory; relationships are never fetched. No Office
application, macro, JavaScript, formula evaluator or shell is invoked.
This process has memory/output/time limits; it is not a general OS sandbox.
"""
import csv
import io
import json
import logging
import os
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_BYTES = 10 * 1024 * 1024
MAX_EXPANDED = 40 * 1024 * 1024
MAX_ENTRY = 16 * 1024 * 1024
MAX_XML = 8 * 1024 * 1024
MAX_PARTS = 2048
MAX_UNITS = 200
MEMORY_LIMIT = 384 * 1024 * 1024
_job_handle = None


class Rejected(Exception):
    pass


def restrict_memory():
    global _job_handle
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class BASIC(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(key, ctypes.c_ulonglong) for key in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class EXT(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BASIC), ("IoInfo", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        _job_handle = kernel.CreateJobObjectW(None, None)
        limits = EXT()
        limits.BasicLimitInformation.LimitFlags = 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
        limits.ProcessMemoryLimit = MEMORY_LIMIT
        if not _job_handle or not kernel.SetInformationJobObject(_job_handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(_job_handle, kernel.GetCurrentProcess()):
            raise Rejected("isolation")
    else:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT, MEMORY_LIMIT))
        resource.setrlimit(resource.RLIMIT_CPU, (15, 15))


def audit(event, args):
    # Parser inputs cannot open URLs or create processes. Imports may read their
    # installed modules; writes are forbidden (including bytecode generation).
    if event.startswith(("socket.", "subprocess.", "os.system", "os.exec", "os.spawn", "os.fork")):
        raise Rejected("isolation")
    if event == "open":
        mode = args[1]
        flags = args[2] if len(args) > 2 else 0
        if isinstance(mode, str) and any(c in mode for c in "wax+"):
            raise Rejected("isolation")
        if isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            raise Rejected("isolation")


class Output:
    def __init__(self, cap):
        self.cap = cap
        self.parts = []
        self.length = 0
        self.truncated = False
        self.incomplete = False
        self.warnings = []

    def warn(self, text, incomplete=False):
        if text not in self.warnings and len(self.warnings) < 20:
            self.warnings.append(text)
        self.incomplete |= incomplete

    def add(self, label, text):
        text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text).strip()
        if not text:
            return
        chunk = ("\n\n" if self.parts else "") + "【" + label + "】\n" + text
        remaining = self.cap - self.length
        if len(chunk) > remaining:
            self.truncated = True
            chunk = chunk[:remaining]
        if chunk:
            self.parts.append(chunk)
            self.length += len(chunk)

    def done(self):
        if self.truncated:
            self.warn("文字已达到提取上限，后续内容未读取。", True)
        return {"ok": True, "text": "".join(self.parts), "truncated": self.truncated,
                "warnings": self.warnings, "incomplete": self.incomplete}


def local(tag):
    return tag.rsplit("}", 1)[-1]


class Office:
    def __init__(self, data, kind, out):
        self.archive = zipfile.ZipFile(io.BytesIO(data))
        self.out = out
        entries = self.archive.infolist()
        names = set()
        expanded = 0
        if len(entries) > MAX_PARTS:
            raise Rejected("archive_limit")
        for entry in entries:
            name = entry.filename
            if name in names or "\\" in name or name.startswith("/") or ":" in name or ".." in name.split("/") or re.search(r"[\x00-\x1f\x7f]", name):
                raise Rejected("archive")
            names.add(name)
            if entry.flag_bits & 1:
                raise Rejected("encrypted")
            if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise Rejected("archive")
            expanded += entry.file_size
            if entry.file_size > MAX_ENTRY or expanded > MAX_EXPANDED or entry.file_size > max(1024 * 1024, entry.compress_size * 200):
                raise Rejected("archive_limit")
            if re.search(r"(?:vbaProject|vbaData|macros)\b", name, re.I):
                raise Rejected("macro")
        self.names = names
        expected = {"docx": "word/document.xml", "xlsx": "xl/workbook.xml", "pptx": "ppt/presentation.xml"}[kind]
        if "[Content_Types].xml" not in names or expected not in names:
            raise Rejected("signature")
        types = self.xml("[Content_Types].xml")
        content_types = [e.get("ContentType", "").lower() for e in types.iter()]
        if any("macroenabled" in value or "vbaproject" in value for value in content_types):
            raise Rejected("macro")
        main_type = {"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                     "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
                     "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"}[kind]
        if not any(e.get("PartName") == "/" + expected and e.get("ContentType", "").lower() == main_type for e in types):
            raise Rejected("signature")
        # Relationships are inspected only to report ignored external resources.
        for name in names:
            if name.endswith(".rels"):
                root = self.xml(name)
                if any(e.get("TargetMode", "").lower() == "external" for e in root):
                    out.warn("文档含外部链接；仅提取文件内文字，未访问链接。")
        if any("/embeddings/" in name or "/media/" in name for name in names):
            out.warn("文档中的图片和嵌入附件未识别；如含关键内容，请另发清晰截图。", True)

    def xml(self, name):
        info = self.archive.getinfo(name)
        if info.file_size > MAX_XML:
            raise Rejected("archive_limit")
        data = self.archive.read(info)
        if len(data) > MAX_XML or b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
            raise Rejected("xml")
        # Reject alternate XML encodings that could hide declaration markers.
        if data.startswith((b"\xff\xfe", b"\xfe\xff")) or b"\x00" in data:
            raise Rejected("xml")
        return ET.fromstring(data)

    def rels(self, location):
        folder, base = posixpath.split(location)
        name = posixpath.join(folder, "_rels", base + ".rels")
        result = {}
        if name not in self.names:
            return result
        for e in self.xml(name):
            target = e.get("Target", "")
            if e.get("TargetMode", "").lower() == "external" or not target or re.search(r"[\\:#?\x00-\x20]", target):
                continue
            normalized = posixpath.normpath(target.lstrip("/")) if target.startswith("/") else posixpath.normpath(posixpath.join(folder, target))
            if normalized in self.names and not normalized.startswith("../"):
                result[e.get("Id", "")] = normalized
        return result


def paragraphs(root):
    lines = []
    for p in root.iter():
        if local(p.tag) == "p":
            bits = []
            for e in p.iter():
                if local(e.tag) == "t" and e.text:
                    bits.append(e.text)
                elif local(e.tag) in ("tab", "br", "cr"):
                    bits.append("\t" if local(e.tag) == "tab" else "\n")
            if bits:
                lines.append("".join(bits))
    return "\n".join(lines)


def docx(office, out):
    out.add("正文（文档分页未保留）", paragraphs(office.xml("word/document.xml")))
    extras = sorted(n for n in office.names if re.fullmatch(r"word/(?:header\d+|footer\d+|footnotes|endnotes)\.xml", n))
    for name in extras:
        if out.length >= out.cap:
            out.truncated = True
            break
        out.add("页眉/页脚/注释 " + posixpath.basename(name), paragraphs(office.xml(name)))


def xlsx(office, out):
    strings = []
    if "xl/sharedStrings.xml" in office.names:
        for si in office.xml("xl/sharedStrings.xml"):
            strings.append("".join(e.text or "" for e in si.iter() if local(e.tag) == "t"))
    workbook = office.xml("xl/workbook.xml")
    rels = office.rels("xl/workbook.xml")
    sheets = [e for e in workbook.iter() if local(e.tag) == "sheet"]
    for index, sheet in enumerate(sheets):
        if index >= MAX_UNITS or out.length >= out.cap:
            out.truncated = True
            break
        rel_id = next((v for k, v in sheet.attrib.items() if k.endswith("}id")), "")
        target = rels.get(rel_id)
        if not target or not re.fullmatch(r"xl/worksheets/[^/]+\.xml", target):
            out.warn("有工作表关系无法读取。", True)
            continue
        sheet_name = re.sub(r"[\x00-\x1f\x7f]", "", sheet.get("name", str(index + 1)))[:100]
        lines = []
        line_chars = 0
        for row in office.xml(target).iter():
            if local(row.tag) != "row":
                continue
            cells = []
            for cell in row:
                if local(cell.tag) != "c":
                    continue
                value = next((e.text or "" for e in cell if local(e.tag) == "v"), "")
                if cell.get("t") == "s":
                    try:
                        value = strings[int(value)] if int(value) >= 0 else ""
                    except (ValueError, IndexError):
                        value = "[无法读取的共享文字]"
                        out.warn("部分单元格文字索引无效。", True)
                elif cell.get("t") == "inlineStr":
                    value = "".join(e.text or "" for e in cell.iter() if local(e.tag) == "t")
                elif cell.get("t") == "b":
                    value = "TRUE" if value == "1" else "FALSE"
                if any(local(e.tag) == "f" for e in cell):
                    out.warn("公式仅使用文件内已保存的结果，未计算公式。")
                    if not value:
                        value = "[公式无已保存结果]"
                        out.incomplete = True
                if value:
                    coordinate = cell.get("r", "")
                    if not re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]{0,6}", coordinate):
                        coordinate = "单元格"
                    cells.append(coordinate + "=" + value)
            if cells:
                line = " | ".join(cells)
                lines.append(line)
                line_chars += len(line)
            if line_chars > out.cap + 1000:
                out.truncated = True
                break
        out.add("工作表：" + sheet_name, "\n".join(lines))
    out.warn("表格提取保留单元格位置；未还原格式、图表或日期显示样式。")


def pptx(office, out):
    rels = office.rels("ppt/presentation.xml")
    slides = [e for e in office.xml("ppt/presentation.xml").iter() if local(e.tag) == "sldId"]
    for index, slide in enumerate(slides):
        if index >= MAX_UNITS or out.length >= out.cap:
            out.truncated = True
            break
        rel_id = next((v for k, v in slide.attrib.items() if k.endswith("}id")), "")
        target = rels.get(rel_id)
        if not target or not re.fullmatch(r"ppt/slides/[^/]+\.xml", target):
            out.warn("有幻灯片关系无法读取。", True)
            continue
        text = paragraphs(office.xml(target))
        if not text.strip():
            out.warn(f"第 {index + 1} 张幻灯片未提取到文字；请检查是否为图片。", True)
        out.add(f"第 {index + 1} 张幻灯片", text)


def pdf(data, out):
    from pypdf import PdfReader
    logging.getLogger("pypdf").setLevel(logging.CRITICAL)
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise Rejected("encrypted")
    pages = reader.pages
    for index in range(min(len(pages), MAX_UNITS)):
        if out.length >= out.cap:
            out.truncated = True
            break
        try:
            text = pages[index].extract_text() or ""
        except MemoryError:
            raise
        except Exception:
            out.warn(f"PDF 第 {index + 1} 页解析失败，未读取。", True)
            continue
        if not text.strip():
            out.warn(f"PDF 第 {index + 1} 页没有可提取文字，可能是扫描页；请导出文字或逐页发清晰图片。", True)
        out.add(f"PDF 第 {index + 1} 页", text)
    if len(pages) > MAX_UNITS:
        out.truncated = True


def plaintext(data, kind, out):
    encoding = "utf-8-sig"
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        encoding = "utf-16"
    try:
        text = data.decode(encoding, "strict")
    except UnicodeDecodeError:
        try:
            text = data.decode("gb18030", "strict")
        except UnicodeDecodeError:
            raise Rejected("encoding")
        out.warn("文件按 GB18030 编码读取；如出现乱码，请另存为 UTF-8 后重试。")
    if "\x00" in text or re.search(r"[\x01-\x08\x0e-\x1f]", text):
        raise Rejected("signature")
    if kind == "txt":
        out.add("文本", text)
        return
    csv.field_size_limit(100_000)
    sample = text[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = csv.reader(io.StringIO(text), dialect=dialect)
    for number, row in enumerate(rows, 1):
        if out.length >= out.cap or number > 10_000:
            out.truncated = True
            break
        out.add(f"CSV 第 {number} 行", " | ".join(row))


def main():
    restrict_memory()
    sys.addaudithook(audit)
    kind = sys.argv[1] if len(sys.argv) > 1 else ""
    cap = min(45000, max(1, int(sys.argv[2]))) if len(sys.argv) > 2 else 45000
    if kind not in ("pdf", "docx", "xlsx", "pptx", "txt", "csv"):
        raise Rejected("format")
    data = sys.stdin.buffer.read(MAX_BYTES + 1)
    if not data or len(data) > MAX_BYTES:
        raise Rejected("size")
    out = Output(cap)
    if kind == "pdf":
        if not data.startswith(b"%PDF-"):
            raise Rejected("signature")
        pdf(data, out)
    elif kind in ("docx", "xlsx", "pptx"):
        if not data.startswith(b"PK\x03\x04"):
            raise Rejected("signature")
        office = Office(data, kind, out)
        {"docx": docx, "xlsx": xlsx, "pptx": pptx}[kind](office, out)
    else:
        if data.startswith((b"PK\x03\x04", b"%PDF-", b"\xd0\xcf\x11\xe0", b"MZ", b"\x7fELF")):
            raise Rejected("signature")
        plaintext(data, kind, out)
    result = out.done()
    if not result["text"]:
        result["incomplete"] = True
        if not result["warnings"]:
            result["warnings"] = ["文件未提取到可读文字，请检查内容或改发清晰图片。"]
    return result


if __name__ == "__main__":
    try:
        answer = main()
    except Rejected as error:
        answer = {"ok": False, "code": str(error)}
    except MemoryError:
        answer = {"ok": False, "code": "memory"}
    except Exception:
        answer = {"ok": False, "code": "parse"}
    sys.stdout.buffer.write(json.dumps(answer, ensure_ascii=False).encode("utf-8"))
