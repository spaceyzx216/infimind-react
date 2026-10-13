import argparse
import json
from html.parser import HTMLParser
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--api-url', required=True)
parser.add_argument('--results', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)

class DocumentText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_body = False
        self.in_paragraph = False
        self.annotation_depth = 0
        self.paragraph = []
        self.source_lines = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'body': self.in_body = True
        if self.in_body and tag == 'div': self.annotation_depth += 1
        if self.in_body and tag == 'p' and self.annotation_depth == 0: self.in_paragraph = True; self.paragraph = []
    def handle_endtag(self, tag):
        if self.in_body and tag == 'div': self.annotation_depth -= 1
        if tag == 'p' and self.in_paragraph: self.source_lines.append(''.join(self.paragraph)); self.in_paragraph = False
    def handle_data(self, data):
        if self.in_paragraph: self.paragraph.append(data)

checks, errors = [], []
with sync_playwright() as p:
    edge = Path('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
    browser = p.chromium.launch(headless=True, **({'executable_path': str(edge)} if edge.exists() else {}))
    for case in ['T03', 'T08', 'T12']:
        data = json.loads((Path(args.results) / f'{case}.json').read_text(encoding='utf-8'))
        report = data['report']
        context = browser.new_context(viewport=dict(width=1440, height=1000))
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        def proxy(route):
            path = route.request.url.split('/api/', 1)[1]
            if path == f'tasks/handbook-diagnosis/{case}/report':
                route.fulfill(json=dict(task=dict(data['task'], id=case), report=report))
            else: route.fulfill(response=route.fetch(url=args.api_url + '/api/' + path))
        page.route('**/api/**', proxy)
        page.goto(args.url + '/tools/handbook?taskId=' + case, wait_until='networkidle')
        expect(page.get_by_test_id('handbook-finding')).to_have_count(len(report['findings']))
        page.screenshot(path=str(output / f'{case}-report.png'), full_page=True)
        for number, finding in enumerate(report['findings'], 1):
            for position, citation in enumerate(finding['evidence'], 1):
                if citation['location']['status'] != 'found': continue
                page.get_by_role('button', name=f"定位原文：{finding['title']} {position}", exact=True).click()
                pane = page.get_by_role('complementary', name='员工手册诊断批注稿', exact=True)
                expect(pane.locator('.local-edit-badge').filter(has_text=str(number)).first).to_be_visible()
                pane.get_by_role('button', name='关闭原文', exact=True).click()
        page.get_by_role('button', name='员工手册诊断批注稿', exact=False).click()
        pane = page.get_by_role('complementary', name='员工手册诊断批注稿', exact=True)
        for document in report['sourceDocuments']:
            if len(report['sourceDocuments']) > 1: pane.get_by_role('combobox', name='切换批注文件', exact=True).select_option(document['fileId'])
            with page.expect_download() as downloaded: pane.get_by_role('button', name='下载诊断批注稿', exact=True).click()
            path = output / f"{case}-{document['fileId']}.doc"
            downloaded.value.save_as(path)
            html = path.read_text(encoding='utf-8')
            # Source stays in order; numeric markers are additional inline text.
            parsed = DocumentText(); parsed.feed(html)
            position = 0
            content = '\n'.join(parsed.source_lines)
            for line in document['text'].split('\n'):
                line = line.strip()
                if not line or line.startswith('#'): continue
                at = content.find(line, position)
                assert at >= 0, f'{case}: 导出缺少原文行 {line[:50]}'
                position = at + len(line)
        page.screenshot(path=str(output / f'{case}-annotations.png'), full_page=True)
        checks.append(dict(case=case, findings=len(report['findings']), files=len(report['sourceDocuments']), sourceCharacters=sum(len(d['text']) for d in report['sourceDocuments'])))
        context.close()
    browser.close()
assert not errors, errors
(output / 'live-ui-results.json').write_text(json.dumps(dict(checks=checks, errors=errors), ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(dict(checks=checks, errors=errors), ensure_ascii=False))
