"""Test the actual App route and existing AuthProvider with fictional API responses.

No live account, backend, database or model is used. Run from any directory:
python server/scripts/test-medical-period-route-ui.py [--output <directory>]
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--output')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
output = Path(args.output) if args.output else Path(tempfile.mkdtemp(prefix='fafee-medical-route-ui-'))
output.mkdir(parents=True, exist_ok=True)
checks = []
page_errors = []
unexpected_api = []
external_requests = []
http_failures = []
requests = []
fixture_user = {'id': 'fictional-medical-user', 'username': 'medical-review', 'email': 'review@example.invalid'}
state = {'authenticated': False}


def check(name, condition=True):
    if not condition:
        raise AssertionError(name)
    checks.append(name)


def fill(page, name, value):
    page.locator(f'[name="{name}"]').fill(value)


server = subprocess.Popen(['node', str(repo / 'server/scripts/serve-medical-period-review.js'), '--app'],
                          cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
try:
    url = None
    root = None
    for line in server.stdout:
        if line.strip().startswith('{'):
            ready = json.loads(line)
            if ready.get('type') == 'medical-review-ready':
                url, root = ready['url'], Path(ready['root'])
                break
    if not url:
        raise RuntimeError('Isolated app did not start.')

    def mock_api(route):
        path = urlparse(route.request.url).path
        requests.append(path)
        current_user = {**fixture_user, 'id': state.get('userId', fixture_user['id'])}
        token = {'accessToken': 'fictional-test-token', 'accessTokenExpiresAt': '2030-01-01T00:00:00.000Z', 'user': current_user}
        if path == '/api/auth/refresh':
            route.fulfill(status=200 if state['authenticated'] else 401,
                          json=token if state['authenticated'] else {'error': 'Not logged in'})
        elif path == '/api/auth/login':
            state['authenticated'] = True
            route.fulfill(status=200, json=token)
        elif path == '/api/auth/me':
            route.fulfill(status=200 if state['authenticated'] else 401,
                          json={'user': current_user} if state['authenticated'] else {'error': 'Not logged in'})
        elif path == '/api/auth/logout':
            state['authenticated'] = False
            route.fulfill(status=200, json={'ok': True})
        elif path == '/api/account/balance':
            route.fulfill(status=200, json={'balances': [], 'isAvailable': True})
        elif path in ['/api/labor/status', '/api/labor/laws']:
            route.fulfill(status=200, json={'laws': [], 'available': True})
        else:
            unexpected_api.append(path)
            route.fulfill(status=500, json={'error': 'Unexpected test API'})

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('MEDICAL_TEST_BROWSER', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'), headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        context.route('**/api/**', mock_api)
        context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(url) else
                      (external_requests.append(route.request.url), route.abort()))
        # Register API interception last; all authentication is simulated locally.
        context.route('**/api/**', mock_api)
        context.add_init_script("""(() => {
          const get=Storage.prototype.getItem,set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
          const key='fafee-history-v2:fictional-medical-user:medical-calculator:calculations',old='old-route-history';
          if(get.call(localStorage,key)===null) set.call(localStorage,key,old);
          window.__medicalStorageCalls=[];
          for(const [name,original] of [['getItem',get],['setItem',set],['removeItem',remove]]) Storage.prototype[name]=function(k,...args){if(String(k).includes('medical-calculator'))window.__medicalStorageCalls.push([name,k]);return original.call(this,k,...args)};
          window.__medicalStorageUnchanged=()=>get.call(localStorage,key)===old;
        })()""")
        page = context.new_page()
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        page.on('response', lambda response: http_failures.append(f'{response.status} {response.url}')
                if response.status >= 400 and response.status != 401 else None)

        page.goto(f'{url}/tools/medical-calculator?from=review', wait_until='networkidle')
        expect(page.get_by_role('button', name='登录', exact=True)).to_be_visible()
        query = parse_qs(urlparse(page.url).query)
        check('anonymous medical URL redirects to login preserving full target', urlparse(page.url).path == '/auth' and query['redirect'] == ['/tools/medical-calculator?from=review'])
        check('anonymous user cannot see medical form', page.locator('.medical-calculator').count() == 0)
        page.get_by_placeholder('请输入用户名或邮箱').fill('medical-review')
        page.get_by_placeholder('请输入密码').fill('fictional-password-123')
        page.get_by_role('button', name='登录', exact=True).click()
        expect(page.locator('.medical-calculator')).to_be_visible()
        check('simulated login returns to original medical URL', urlparse(page.url).path == '/tools/medical-calculator' and parse_qs(urlparse(page.url).query)['from'] == ['review'])
        check('specific route renders new pure form, not generic chat', page.locator('.prototype-chat,.composer').count() == 0)
        page.locator('[name="region"]').select_option('shanghai')
        page.get_by_role('button', name='填写实际日期段', exact=True).click()
        fill(page, 'asOf', '2026-06-30')
        fill(page, 'hireDate', '2024-09-01')
        fill(page, 'segments.0.startDate', '2026-06-01')
        fill(page, 'segments.0.endDate', '2026-06-10')
        fill(page, 'segments.0.workDays', '8')
        page.locator('.mp-supplementary > summary').click()
        page.locator('[name="historyComplete"]').check()
        before_calculation = len(requests)
        page.get_by_role('button', name='开始测算', exact=True).click()
        expect(page.locator('.mp-balance')).to_contain_text('54.01')
        check('actual protected route computes Shanghai reference balance', '54.01工作日' == page.locator('.mp-balance strong').inner_text())
        check('calculation makes no API/model request', len(requests) == before_calculation)
        page.screenshot(path=str(output / 'protected-medical-result.png'))
        check('medical route has no sidebar or history operations', page.locator('.chat-sidebar,.sidebar-toggle,.mp-history-list,.account-trigger').count() == 0)
        check('actual route displays enterprise title', page.get_by_role('heading', name='员工医疗期测算', exact=True).is_visible())
        page.get_by_role('button', name='修改条件', exact=True).click()
        fill(page, 'segments.0.workDays', '7')
        check('changing input marks stale result in full App', page.locator('.mp-result-stale').count() == 1 and page.get_by_role('button', name='复制测算单', exact=True).is_disabled())
        page.get_by_role('button', name='重新计算', exact=True).click()
        expect(page.locator('.mp-result-stale')).to_have_count(0)
        check('recalculation completes through actual route')
        page.get_by_role('button', name='修改条件', exact=True).click()
        fill(page, 'specialNote', '普通考勤复核备注')
        page.locator('[name="historyComplete"]').uncheck()
        page.get_by_role('button', name='重新计算', exact=True).click()
        expect(page.locator('.mp-balance')).to_contain_text('补齐并确认')
        check('actual Shanghai route accepts incomplete records and identifies missing confirmation', '7工作日' in page.locator('.mp-metrics').inner_text() and page.get_by_role('alert').count() == 0)
        page.get_by_role('button', name='补充信息', exact=True).click()
        expect(page.locator('[name="historyComplete"]')).to_be_focused()
        page.locator('[name="historyComplete"]').check()
        fill(page, 'segments.0.workDays', '')
        page.get_by_role('button', name='重新计算', exact=True).click()
        expect(page.locator('.mp-balance')).to_contain_text('补充实际病休工作日')
        check('single action in actual route preserves known natural days when workdays missing', '10自然日' in page.locator('.mp-metrics').inner_text() and page.get_by_role('button', name='仅核对基础额度', exact=True).count() == 0)
        page.get_by_role('button', name='补充信息', exact=True).click()
        expect(page.locator('[name="segments.0.workDays"]')).to_be_focused()
        fill(page, 'segments.0.workDays', '7')
        page.get_by_role('button', name='重新计算', exact=True).click()
        check('ordinary remarks do not suppress actual-route balance', page.locator('.mp-balance strong').inner_text() == '55.01工作日')
        check('new partial workflows make no additional API calls', len(requests) == before_calculation)
        for width in [1440, 390, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            check(f'App result has no outer overflow at {width}', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.keyboard.press('Control+,')
        expect(page.get_by_role('dialog', name='设置', exact=True)).to_be_visible()
        page.get_by_role('radio', name='深色', exact=True).check()
        page.get_by_role('button', name='关闭设置', exact=True).click()
        expect(page.locator('.app-workspace')).to_have_attribute('data-theme', 'dark')
        check('medical panels inherit the shared dark surface', page.locator('.mp-result').evaluate('(el) => getComputedStyle(el).backgroundColor') == page.locator('.app-workspace-content').evaluate('(el) => getComputedStyle(el).backgroundColor'))
        for width in [1440, 390, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.locator('.mp-result').scroll_into_view_if_needed()
            check(f'dark medical result reachable at {width}px without outer overflow', page.locator('.mp-result').is_visible() and page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
            page.screenshot(path=str(output / f'medical-workspace-dark-{width}.png'))
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.keyboard.press('Control+,')
        page.get_by_role('radio', name='浅色', exact=True).check()
        page.get_by_role('button', name='关闭设置', exact=True).click()
        expect(page.locator('.app-workspace')).to_have_attribute('data-theme', 'light')
        check('medical page retains account/settings while hiding conversation controls', page.locator('.app-workspace-history-toggle,.workspace-conversation-menu').count() == 0 and page.get_by_role('button', name='账户菜单', exact=True).is_visible())
        page.reload(wait_until='networkidle')
        expect(page.locator('.medical-calculator')).to_be_visible()
        check('refresh restores mock session and remains on medical form', page.locator('[name="region"]').input_value() == '')
        check('refresh discards the current result without saving', page.locator('.mp-result').count() == 0)
        page.get_by_role('button', name='更多功能', exact=True).click()
        page.get_by_role('menuitem', name='医疗期计算器', exact=True).click()
        expect(page.locator('.medical-calculator')).to_be_visible()
        check('new workspace menu opens medical form')
        check('reentering the tool starts an empty draft', page.locator('[name="region"]').input_value() == '' and page.locator('.mp-result').count() == 0)
        page.get_by_role('button', name='更多功能', exact=True).click()
        page.get_by_role('menuitem', name='养老保险测算', exact=True).click()
        expect(page.get_by_role('heading', name='养老保险测算', exact=True)).to_be_visible()
        check('unified pension menu opens enterprise type', page.get_by_role('button', name='企业职工', exact=True).get_attribute('aria-pressed') == 'true')
        page.get_by_role('button', name='个体工商户／灵活就业人员', exact=True).click()
        check('unified pension page switches to flexible type', page.locator('.medical-calculator,.prototype-chat').count() == 0)
        page.get_by_role('button', name='账户菜单', exact=True).click()
        page.get_by_role('button', name='退出登录', exact=True).click()
        expect(page.get_by_role('button', name='登录', exact=True)).to_be_visible()
        page.goto(f'{url}/tools/medical-calculator', wait_until='networkidle')
        expect(page.get_by_role('button', name='登录', exact=True)).to_be_visible()
        check('logout closes access to medical route again', page.locator('.medical-calculator').count() == 0)
        state['userId'] = 'fictional-medical-user-b'
        page.get_by_placeholder('请输入用户名或邮箱').fill('medical-review-b')
        page.get_by_placeholder('请输入密码').fill('fictional-password-123')
        page.get_by_role('button', name='登录', exact=True).click()
        expect(page.locator('.medical-calculator')).to_be_visible()
        check('another account starts with empty medical conditions', page.locator('[name="region"]').input_value() == '' and page.locator('.mp-result').count() == 0)
        page.locator('[name="region"]').select_option('national')
        fill(page, 'hireDate', '2025-01-01')
        fill(page, 'totalWorkYears', '1')
        fill(page, 'segments.0.startDate', '2026-01-31')
        fill(page, 'segments.0.endDate', '2026-02-01')
        page.get_by_role('button', name='开始测算', exact=True).click()
        expect(page.locator('.mp-result')).to_be_visible()
        check('second account can calculate without a history sidebar', page.locator('.chat-sidebar').count() == 0 and '2' in page.locator('.mp-metrics').inner_text())
        page.get_by_role('button', name='补充信息', exact=True).click()
        expect(page.locator('[name="historyComplete"]')).to_be_focused()
        page.locator('[name="historyComplete"]').check()
        page.get_by_role('button', name='重新计算', exact=True).click()
        check('actual national route uses89calendar days rather than a90day constant', page.locator('.mp-balance strong').inner_text() == '87天')
        check('workbench national result removes fixed monthly conversion', '30天/月' not in page.locator('.medical-calculator').text_content())
        page.get_by_role('button', name='账户菜单', exact=True).click()
        page.get_by_role('button', name='退出登录', exact=True).click()
        expect(page.get_by_role('button', name='登录', exact=True)).to_be_visible()
        state['userId'] = fixture_user['id']
        page.goto(f'{url}/tools/medical-calculator', wait_until='networkidle')
        page.get_by_placeholder('请输入用户名或邮箱').fill('medical-review')
        page.get_by_placeholder('请输入密码').fill('fictional-password-123')
        page.get_by_role('button', name='登录', exact=True).click()
        expect(page.locator('.medical-calculator')).to_be_visible()
        check('returning to original account starts empty without restoring history', page.locator('[name="region"]').input_value() == '' and page.locator('.mp-result').count() == 0)
        check('auth and medical remount do not touch old medical storage', page.evaluate('window.__medicalStorageCalls.length===0 && window.__medicalStorageUnchanged()'))
        check('no unexpected API requests', not unexpected_api)
        check('no external resources requested', not external_requests)
        check('no unexpected HTTP failures', not http_failures)
        check('no browser page exceptions', not page_errors)
        browser.close()
    source_hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in
                     ['src/App.jsx', 'src/pages/MedicalCalculatorPage.jsx', 'src/utils/medical-period-calculator.js', 'src/utils/medical-period-history.js']}
    report = {'status': 'passed', 'checks': len(checks), 'cases': checks, 'pageErrors': page_errors,
              'unexpectedApi': unexpected_api, 'externalRequests': external_requests, 'httpFailures': http_failures,
              'mockApiRequests': requests, 'sourceFilesSHA256': source_hashes,
              'scope': 'actual App and AuthProvider with fictional authentication; not live backend or production deployment'}
    (output / 'route-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': 'passed', 'checks': len(checks), 'output': str(output)}, ensure_ascii=False))
except Exception as error:
    (output / 'route-verification.json').write_text(json.dumps({'status': 'failed', 'cases': checks, 'error': str(error), 'pageErrors': page_errors, 'httpFailures': http_failures, 'unexpectedApi': unexpected_api}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'pageErrors': page_errors, 'httpFailures': http_failures}, ensure_ascii=False))
    raise
finally:
    server.terminate()
    server.wait(timeout=20)
