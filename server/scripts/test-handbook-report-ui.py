import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:15173')
parser.add_argument('--output', required=True)
parser.add_argument('--api-url', help='Optional loopback-only fixture API; keeps shared frontend tests away from real user data')
args = parser.parse_args()
if args.api_url:
    assert urlsplit(args.api_url).hostname in ['127.0.0.1', 'localhost']
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
quote = '员工忘打卡可以提交实际出勤证明。'
clause = '第一条 员工可提交实际出勤证明。\n第二条 公司应核实后更正记录。'
markdown = '### 原文问题\n\n**先核实实际出勤**，再判断记录。\n\n- 核对日期\n- 核对适用人员\n\n| 情形 | 处理 |\n| --- | --- |\n| 忘打卡 | 核实 |\n\n```text\n' + 'very-long-synthetic-token-' * 25 + '\n```\n\n<script>window.handbookUnsafe = true</script>'
authority = {'title': '虚构法条测试', 'article': '第四十二条', 'note': '仅测试展示，不是真实法律。', 'provisionStatus': 'matched', 'quoteStatus': 'matched', 'supportStatus': 'model_supported', 'applicabilityStatus': 'pending', 'versionLabel': 'synthetic-v1', 'quote': '虚构条文原文需保留条件。', 'provisionText': '第四十二条 虚构条文原文需保留条件。', 'supportReason': '**模型意见**：应结合条件核对。'}
finding = {'id': 'finding-format', 'title': '展示测试问题', 'kind': 'clause', 'topic': '考勤', 'level': 'medium', 'status': 'risk', 'explanation': markdown, 'recommendation': '1. 核对原件\n2. 更正记录\n\n保留现有期限。', 'suggestedClause': clause, 'conditions': ['已实际出勤'], 'authorities': [authority], 'relatedChanges': [], 'evidence': [{'chunkId': 'format-block', 'quote': quote, 'location': {'status': 'found', 'matches': [{'fileId': 'format-file', 'fileName': '虚构制度.txt', 'sectionTitle': '考勤', 'startOffset': 0, 'endOffset': len(quote)}]}}]}
report = {'analysisStatus': 'completed', 'scope': {'description': '虚构界面测试', 'background': {}}, 'findings': [finding], 'coverage': [], 'procedureChecklist': [], 'pendingQuestions': [], 'warnings': [], 'sourceDocuments': [{'fileId': 'format-file', 'fileName': '虚构制度.txt', 'text': quote}], 'referenceVersions': []}
def response(task_id, data):
    return {'task': {'id': task_id, 'threadId': 'format-report', 'title': '报告格式测试', 'status': 'succeeded', 'productId': 'handbook-diagnosis'}, 'report': data}

checks, errors = [], []
with sync_playwright() as p:
    edge = Path('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
    browser = p.chromium.launch(headless=True, **({'executable_path': str(edge)} if edge.exists() else {}))
    for width, height in [(1440, 1000), (390, 844)]:
        context = browser.new_context(viewport={'width': width, 'height': height}, permissions=['clipboard-read', 'clipboard-write'])
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        if args.api_url:
            def proxy(route):
                parts = urlsplit(route.request.url)
                route.fulfill(response=route.fetch(url=args.api_url + parts.path + ('?' + parts.query if parts.query else '')))
            page.route('**/api/**', proxy)
        page.route('**/api/tasks/handbook-diagnosis/format-report/report', lambda route: route.fulfill(json=response('format-report', report)))
        page.route('**/api/tasks/handbook-diagnosis/format-reply/report', lambda route: route.fulfill(json=response('format-reply', {'kind': 'followup', 'sourceTaskId': 'format-report', 'answer': '### 追问说明\n\n**核对条件**\n\n- 查看制度版本\n- 查看实际记录'})))
        page.goto(args.url + '/tools/handbook?taskId=format-report')
        page.wait_for_load_state('networkidle')
        article = page.get_by_test_id('handbook-finding')
        expect(article.get_by_role('heading', name='原文问题')).to_be_visible()
        expect(article.locator('.hb-markdown > ul > li')).to_have_count(2)
        expect(article.locator('table')).to_be_visible()
        assert page.evaluate('window.handbookUnsafe !== true')
        article.get_by_text('适用条件与依据详情', exact=True).click()
        expect(article.locator('.hb-markdown > ol > li')).to_have_count(2)
        expect(article.get_by_text('条号已匹配 · 引文已匹配 · 模型认为有支持 · 法律适用待复核', exact=True)).to_be_visible()
        article.get_by_text('查看法条原文', exact=True).click()
        expect(article.get_by_text(authority['provisionText'], exact=True)).to_be_visible()
        article.locator('.hb-suggestion button').click()
        expect(article.locator('.hb-suggestion button .lucide-check')).to_be_visible()
        assert page.evaluate('navigator.clipboard.readText()').replace('\r\n', '\n') == clause
        page.get_by_role('button', name='复制报告', exact=True).click()
        expect(page.get_by_role('button', name='复制报告', exact=True).locator('.lucide-check')).to_be_visible()
        copied = page.evaluate('navigator.clipboard.readText()').replace('\r\n', '\n')
        assert '1. 展示测试问题' in copied and '问题说明\n' in copied and '原文 1\n' + quote in copied
        assert clause in copied and '法律适用待复核' in copied
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
        page.screenshot(path=str(output / f'report-format-{width}.png'), full_page=True)
        page.goto(args.url + '/tools/handbook?taskId=format-reply')
        page.wait_for_load_state('networkidle')
        expect(page.locator('.hb-reply').get_by_role('heading', name='追问说明')).to_be_visible()
        expect(page.locator('.hb-reply li')).to_have_count(2)
        checks.append(f'{width}px: Markdown段落列表表格、原文与示例复制、法条状态、追问、无横向溢出')
        context.close()
    assert not errors, errors
    browser.close()
(output / 'report-format-results.json').write_text(json.dumps({'checks': checks, 'pageErrors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'checks': checks, 'pageErrors': errors}, ensure_ascii=False))
