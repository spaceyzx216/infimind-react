"""Verify actual pension App routes with fictional authentication and parameters.

python server/scripts/test-pension-routes-ui.py [--output <directory>]
Uses an isolated source snapshot; never accesses a live account or backend.
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
output = Path(args.output) if args.output else Path(tempfile.mkdtemp(prefix='pension-route-ui-'))
output.mkdir(parents=True, exist_ok=True)
report_path = output / 'pension-route-verification.json'
report_path.write_text(json.dumps({'status': 'running'}, indent=2), encoding='utf-8')
checks, page_errors, unexpected_api, external_requests, http_failures, requests = [], [], [], [], [], []
state = {'authenticated': False}
fixture_user = {'id': 'fictional-pension-user', 'username': 'pension-review', 'email': 'review@example.invalid'}
fixture = {
    'recordMonth': '2025-12',
    'gender': 'male', 'currentAge': '59', 'retirementAge': '60', 'actualYears': '19',
    'deemedYears': '0', 'pastAvgIndex': '100', 'accountBalance': '90000', 'localAvgWage': '8000',
    'wageGrowth': '0', 'accountInterest': '0', 'currentMonthlyWage': '8000', 'futureWageGrowth': '0', 'grade': '100'
}


def check(name, condition=True):
    if not condition:
        raise AssertionError(name)
    checks.append(name)


def fill_fixture(page):
    for name, value in fixture.items():
        control = page.locator(f'[name="{name}"]')
        if not control.count():
            continue
        if control.evaluate('(element) => element.tagName') == 'SELECT':
            control.select_option(value)
        else:
            control.fill(value)


server = subprocess.Popen(['node', str(repo / 'server/scripts/serve-medical-period-review.js'), '--app'],
                          cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, encoding='utf-8', creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
try:
    url, root = None, None
    for line in server.stdout:
        if line.strip().startswith('{'):
            ready = json.loads(line)
            if ready.get('type') == 'medical-review-ready':
                url, root = ready['url'], Path(ready['root'])
                break
    if not url:
        raise RuntimeError('Isolated actual App did not start.')

    def mock_api(route):
        path = urlparse(route.request.url).path
        requests.append(path)
        token = {'accessToken': 'fictional-test-token', 'accessTokenExpiresAt': '2030-01-01T00:00:00.000Z', 'user': fixture_user}
        if path in ['/api/auth/refresh', '/api/auth/me']:
            value = ({'user': fixture_user} if path.endswith('/me') else token) if state['authenticated'] else {'error': 'Not logged in'}
            route.fulfill(status=200 if state['authenticated'] else 401, json=value)
        elif path == '/api/auth/login':
            state['authenticated'] = True
            route.fulfill(status=200, json=token)
        elif path == '/api/auth/logout':
            state['authenticated'] = False
            route.fulfill(status=200, json={'ok': True})
        elif path == '/api/account/balance':
            route.fulfill(status=200, json={'balances': [], 'isAvailable': True})
        elif path == '/api/tasks':
            route.fulfill(status=200, json={'tasks': [], 'hasMore': False})
        elif path in ['/api/labor/status', '/api/labor/laws']:
            route.fulfill(status=200, json={'laws': [], 'available': True})
        else:
            unexpected_api.append(path)
            route.fulfill(status=500, json={'error': 'Unexpected test API'})

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('PENSION_TEST_BROWSER', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'), headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(url) else
                      (external_requests.append(route.request.url), route.abort()))
        context.route('**/api/**', mock_api)
        page = context.new_page()
        page.on('pageerror', lambda error: page_errors.append(str(error)))
        page.on('response', lambda response: http_failures.append(f'{response.status} {response.url}')
                if response.status >= 400 and response.status != 401 else None)
        for product in ['pension-calc1', 'pension-calc2']:
            target = f'/tools/{product}?from=review'
            page.goto(url + target, wait_until='networkidle')
            expect(page.get_by_role('button', name='登录', exact=True)).to_be_visible()
            check(f'{product}: anonymous redirect preserves target',
                  urlparse(page.url).path == '/auth' and parse_qs(urlparse(page.url).query)['redirect'] == [target])
            check(f'{product}: form protected', page.locator('.pension-calculation-page').count() == 0)
        page.get_by_placeholder('请输入用户名或邮箱').fill('pension-review')
        page.get_by_placeholder('请输入密码').fill('fictional-password-123')
        page.get_by_role('button', name='登录', exact=True).click()
        expect(page.locator('.pension-calculation-page')).to_be_visible()
        check('login resumes flexible pension route and query',
              urlparse(page.url).path == '/tools/pension-calc2' and parse_qs(urlparse(page.url).query)['from'] == ['review'])
        for product, initial_type in [('pension-calc2', '个体工商户／灵活就业人员'), ('pension-calc1', '企业职工')]:
            page.goto(f'{url}/tools/{product}', wait_until='networkidle')
            expect(page.get_by_role('heading', name='养老保险测算', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name=initial_type, exact=True)).to_have_attribute('aria-pressed', 'true')
            check(f'{product}: legacy URL selects expected type in unified page')
            check(f'{product}: empty form without chat or history',
                  page.locator('[name="currentAge"]').input_value() == '' and
                  page.locator('.chat-sidebar,.pension-history-row,[name="history-search"],textarea,.composer').count() == 0)
            history_keys = [f'fafee-history-v2:{fixture_user["id"]}:{tool}:calculations' for tool in ['pension-calc1', 'pension-calc2']]
            saved_value = '[{"id":"legacy-record","title":"preserved history"}]'
            page.evaluate('({keys,value}) => { for (const key of keys) localStorage.setItem(key,value) }', {'keys': history_keys, 'value': saved_value})
            fill_fixture(page)
            page.locator('button[type="submit"]').click()
            expect(page.get_by_test_id('pension-total')).to_have_text('2,302.73元／月')
            check(f'{product}: actual App computes expected pension')
            other_type = '企业职工' if product == 'pension-calc2' else '个体工商户／灵活就业人员'
            original_url = page.url
            page.get_by_role('button', name=other_type, exact=True).click()
            expect(page.get_by_test_id('pension-result')).to_have_count(0)
            check(f'{product}: in-page switch keeps common inputs and invalidates result',
                  page.url == original_url and page.locator('[name="accountBalance"]').input_value() == '90000')
            fill_fixture(page)
            page.locator('button[type="submit"]').click()
            expect(page.get_by_test_id('pension-total')).to_have_text('2,302.73元／月')
            expected_cost = '640.00' if other_type == '企业职工' else '1,600.00'
            expect(page.locator('.pension-result-grid')).to_contain_text(expected_cost)
            check(f'{product}: switched type uses its own contribution rule')
            page.locator('[name="accountBalance"]').fill('100000')
            expect(page.get_by_test_id('pension-result')).to_have_count(0)
            page.locator('button[type="submit"]').click()
            expect(page.get_by_test_id('pension-total')).to_have_text('2,374.68元／月')
            check(f'{product}: input edits require recalculation')
            page.get_by_role('button', name='重置条件', exact=True).click()
            expect(page.get_by_test_id('pension-result')).to_have_count(0)
            check(f'{product}: reset clears inputs without removing legacy history',
                  page.locator('[name="currentAge"]').input_value() == '' and
                  page.evaluate('(keys) => keys.map((key) => localStorage.getItem(key))', history_keys) == [saved_value, saved_value])
            page.reload(wait_until='networkidle')
            expect(page.locator('.pension-calculation-page')).to_be_visible()
            check(f'{product}: refresh does not restore old records',
                  page.locator('[name="currentAge"]').input_value() == '' and page.get_by_test_id('pension-result').count() == 0)
        page.get_by_role('button', name='更多功能', exact=True).click()
        expect(page.get_by_role('menuitem', name='养老保险测算', exact=True)).to_have_attribute('aria-current', 'page')
        check('both legacy pension routes share one active menu entry')
        check('calculators are not forced into existing pinned navigation', page.locator('.app-workspace-tools [data-tool-path="/tools/pension-calc1"]').count() == 0)
        page.get_by_role('menuitemcheckbox', name='固定到侧栏：养老保险测算', exact=True).click()
        expect(page.locator('.app-workspace-tools [data-tool-path="/tools/pension-calc1"]')).to_be_visible()
        page.get_by_role('menuitemcheckbox', name='固定到侧栏：医疗期计算器', exact=True).click()
        check('both calculators can be pinned using mentor menu')
        page.keyboard.press('Escape')
        rail = page.locator('.app-workspace-tools')
        before = rail.locator('[data-tool-path]').evaluate_all('(items) => items.map((item) => item.dataset.toolPath)')
        pension_link = rail.locator('[data-tool-path="/tools/pension-calc1"]')
        pension_link.focus()
        pension_link.press('Alt+ArrowUp')
        after = rail.locator('[data-tool-path]').evaluate_all('(items) => items.map((item) => item.dataset.toolPath)')
        check('keyboard reorder preserves other pins', set(before) == set(after) and before != after)
        page.reload(wait_until='networkidle')
        check('pinned tools and order survive refresh', after == rail.locator('[data-tool-path]').evaluate_all('(items) => items.map((item) => item.dataset.toolPath)'))
        for width in [1440, 768, 390, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            fill_fixture(page)
            page.locator('button[type="submit"]').click()
            expect(page.get_by_test_id('pension-total')).to_have_text('2,302.73元／月')
            check(f'{width}px pension form and result have no outer overflow', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
            check(f'{width}px pension result is reachable inside workspace scroll', page.get_by_test_id('pension-result').is_visible() and page.locator('.pension-calculation-page').evaluate('(el) => el.scrollHeight > el.clientHeight && el.scrollTop > 0'))
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.keyboard.press('Control+,')
        expect(page.get_by_role('dialog', name='设置', exact=True)).to_be_visible()
        page.get_by_role('radio', name='深色', exact=True).check()
        page.get_by_role('button', name='关闭设置', exact=True).click()
        expect(page.locator('.app-workspace')).to_have_attribute('data-theme', 'dark')
        check('pension form inherits shared dark surface', page.locator('.pension-calculation-page').evaluate('(el) => getComputedStyle(el).backgroundColor') == page.locator('.app-workspace-content').evaluate('(el) => getComputedStyle(el).backgroundColor'))
        page.screenshot(path=str(output / 'workspace-pension-dark.png'))
        page.keyboard.press('Control+,')
        page.get_by_role('radio', name='浅色', exact=True).check()
        page.get_by_role('button', name='关闭设置', exact=True).click()
        expect(page.locator('.app-workspace')).to_have_attribute('data-theme', 'light')
        check('pension form has no history toggle, conversation options or side chat', page.locator('.app-workspace-history-toggle,.workspace-conversation-menu,.workspace-side-chat').count() == 0)
        rail.locator('[data-tool-path="/tools/medical-calculator"]').click()
        expect(page.locator('.medical-calculator')).to_be_visible()
        check('medical entry retains independent page', page.locator('.pension-calculation-page').count() == 0)
        check('medical form hides conversation controls', page.locator('.app-workspace-history-toggle,.workspace-conversation-menu').count() == 0)
        page.goto(f'{url}/tools/handbook', wait_until='networkidle')
        expect(page.locator('.prototype-chat-header')).to_be_visible()
        check('generic protected tool route retains fallback', page.locator('.pension-calculation-page,.medical-calculator').count() == 0)
        check('chat pages retain mentor conversation controls', page.locator('.app-workspace-history-toggle,.workspace-conversation-menu').count() == 2)
        page.goto(f'{url}/tools/fictional-unmapped-tool', wait_until='networkidle')
        expect(page.locator('.app-workspace-page-title')).to_have_text('用工咨询')
        check('unknown tool follows mentor redirect', urlparse(page.url).path == '/labor-consult')
        page.goto(f'{url}/tools/pension-calc1', wait_until='networkidle')
        page.get_by_role('button', name='账户菜单', exact=True).click()
        page.get_by_role('button', name='退出登录', exact=True).click()
        expect(page.get_by_role('button', name='登录', exact=True)).to_be_visible()
        for product in ['pension-calc1', 'pension-calc2']:
            page.goto(f'{url}/tools/{product}', wait_until='networkidle')
            expect(page.get_by_role('button', name='登录', exact=True)).to_be_visible()
            check(f'logout protects {product} again', page.locator('.pension-calculation-page').count() == 0)
        fixture_user['id'] = 'fictional-pension-other-user'
        fixture_user['username'] = 'another-review-user'
        page.get_by_placeholder('请输入用户名或邮箱').fill('another-review-user')
        page.get_by_placeholder('请输入密码').fill('fictional-password-456')
        page.get_by_role('button', name='登录', exact=True).click()
        expect(page.locator('.pension-calculation-page')).to_be_visible()
        check('second account starts a blank form', page.locator('[name="accountBalance"]').input_value() == '')
        check('no unexpected API requests', not unexpected_api)
        check('no external resources requested', not external_requests)
        check('no unexpected HTTP failures', not http_failures)
        check('no browser exceptions', not page_errors)
        browser.close()
    names = ['src/App.jsx', 'src/components/WorkspaceLayout.jsx', 'src/pages/PensionCalculationPage.jsx', 'src/pages/PensionCalculatorContent.jsx', 'src/pages/PensionCalculationPage.css',
             'src/utils/pension-calculator.js', 'src/utils/pension-retirement.js', 'src/utils/pension-rules.js', 'src/utils/pension-history.js']
    report = {'status': 'passed', 'checks': len(checks), 'cases': checks, 'pageErrors': page_errors,
              'unexpectedApi': unexpected_api, 'externalRequests': external_requests, 'httpFailures': http_failures,
              'sourceFilesSHA256': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names},
              'scope': 'actual App and AuthProvider with fictional authentication and parameters; not live backend or policy acceptance'}
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status': 'passed', 'checks': len(checks), 'output': str(output)}, ensure_ascii=False))
except Exception as error:
    report_path.write_text(json.dumps({'status': 'failed', 'cases': checks, 'error': str(error),
                                     'pageErrors': page_errors, 'unexpectedApi': unexpected_api,
                                     'externalRequests': external_requests}, ensure_ascii=False, indent=2), encoding='utf-8')
    raise
finally:
    server.terminate()
    server.wait(timeout=20)
