import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--api-url', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
documents = [dict(fileId='a', fileName='虚构手册.txt', text='第一章 考勤\n  实际出勤不得按旷工处理。\n未修改的尾部内容。'),
             dict(fileId='b', fileName='虚构考勤.txt', text='实际出勤仍按旷工处理。', parseMetadata=dict(ocrRegionCount=1))]

def evidence(file_id, quote):
    doc = next(d for d in documents if d['fileId'] == file_id)
    start = doc['text'].index(quote)
    return dict(quote=quote, location=dict(status='found', matches=[dict(fileId=file_id, fileName=doc['fileName'], sectionTitle='考勤', startOffset=start, endOffset=start + len(quote))]))

finding = dict(id='one', kind='conflict', title='同一实际出勤规则冲突', topic='考勤', status='risk', level='high', explanation='同一员工、同一实际出勤条件下，两个制度给出相反处理。',
               recommendation='核实实际出勤，统一处理规则。', suggestedClause='完整条款建议，不作为已接受的局部替换。', conditions=['同一实际出勤条件'], authorities=[], relatedChanges=['同时调整考勤制度'],
               evidence=[evidence('a', '实际出勤不得按旷工处理。'), evidence('b', documents[1]['text'])])
second = dict(finding, id='two', kind='clause', title='记录需要核实', level='medium', suggestedClause='', evidence=[evidence('a', '不得按旷工处理')])
third = dict(finding, id='three', title='缺少定位的提示', evidence=[dict(quote='不存在的引用', location=dict(status='not-found', matches=[]))])
fourth = dict(finding, id='four', kind='clause', title='可定位的条款建议', suggestedClause='示例条款，仍保留实际出勤条件。', evidence=[evidence('a', '实际出勤不得按旷工处理。')])
report = dict(analysisStatus='completed', scope=dict(description='仅检查虚构材料正文', background={}), sourceDocuments=documents,
              findings=[finding, second, third, fourth], coverage=[], pendingQuestions=['实际适用范围待核实'], warnings=[], procedureChecklist=[], referenceVersions=[])
checks, errors = [], []
with sync_playwright() as p:
    edge = Path('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
    browser = p.chromium.launch(headless=True, **({'executable_path': str(edge)} if edge.exists() else {}))
    for width, height in [(1440, 1000), (390, 844)]:
        context = browser.new_context(viewport=dict(width=width, height=height), permissions=['clipboard-read', 'clipboard-write'])
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        def proxy(route):
            path = route.request.url.split('/api/', 1)[1]
            if path == 'tasks/handbook-diagnosis/annotation-test/report':
                route.fulfill(json=dict(task=dict(id='annotation-test', threadId='annotation-test', productId='handbook-diagnosis', status='succeeded', title='虚构批注稿'), report=report))
            else:
                route.fulfill(response=route.fetch(url=args.api_url + '/api/' + path))
        page.route('**/api/**', proxy)
        page.goto(args.url + '/tools/handbook?taskId=annotation-test', wait_until='networkidle')
        expect(page.get_by_role('heading', name='诊断摘要', exact=True)).to_be_visible()
        expect(page.get_by_text(finding['recommendation'], exact=True).first).to_be_visible()
        article = page.get_by_test_id('handbook-finding').first
        assert article.locator('.hb-markdown p').first.evaluate('(e) => getComputedStyle(e).fontSize') == '16px'
        assert article.locator('h3').evaluate('(e) => getComputedStyle(e).fontSize') == '17px'
        assert page.locator('.hb-section-title h2').evaluate('(e) => getComputedStyle(e).fontSize') == '19px'
        page.get_by_role('button', name='员工手册诊断批注稿', exact=False).click()
        pane = page.get_by_role('complementary', name='员工手册诊断批注稿', exact=True)
        expect(pane.locator('.quote-marker').filter(has_text='1·2')).to_be_visible()
        expect(pane.get_by_text('未修改的尾部内容。', exact=True)).to_be_visible()
        pane.get_by_role('button', name='复制原文', exact=True).click()
        assert page.evaluate('navigator.clipboard.readText()').replace('\r\n', '\n') == documents[0]['text']
        with page.expect_download() as downloaded:
            pane.get_by_role('button', name='下载诊断批注稿', exact=True).click()
        path = output / f'annotated-{width}.doc'
        downloaded.value.save_as(path)
        assert downloaded.value.suggested_filename.endswith('-诊断批注稿.doc')
        html = path.read_text(encoding='utf-8')
        assert '未修改的尾部内容。' in html and '1·2' in html
        assert fourth['suggestedClause'] in html and '未定位诊断提示' in html and third['title'] in html
        assert finding['suggestedClause'] not in html, '含OCR待确认依据的建议不能出现在批注稿'
        assert '同一实际出勤条件' in html
        pane.get_by_role('combobox', name='切换批注文件', exact=True).select_option('b')
        expect(pane.locator('.quote-marker').filter(has_text='1')).to_be_visible()
        assert pane.get_by_text(finding['suggestedClause'], exact=True).count() == 0, 'OCR文本不能显示可直接替换的条款建议'
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=str(output / f'annotations-{width}.png'), full_page=True)
        pane.get_by_role('button', name='关闭原文', exact=True).click()
        page.reload(wait_until='networkidle')
        page.get_by_role('button', name='员工手册诊断批注稿', exact=False).click()
        expect(page.locator('.hb-source .quote-marker').first).to_be_visible()
        checks.append(f'{width}px: 统一字号、建议展开、跨文件编号、重叠标记、OCR提示、复制、下载全文与未定位提示、刷新恢复')
        context.close()
    browser.close()
assert not errors, errors
(output / 'annotation-ui-results.json').write_text(json.dumps(dict(checks=checks, errors=errors), ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(dict(checks=checks, errors=errors), ensure_ascii=False))
