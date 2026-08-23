import sys, os, time, logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger('guided_discovery_runner')

def main(case_id):
    root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
    if root_dir not in sys.path:
        sys.path.insert(0, root_dir)
    from app.database.connection import SessionLocal
    from app.models.automation import AutomationTestCase
    from app.services.automation.guided_discovery import GUIDED_DISCOVERY_INJECTED_SCRIPT
    from playwright.sync_api import sync_playwright

    db = SessionLocal()
    case = db.query(AutomationTestCase).filter(AutomationTestCase.id == case_id).first()
    if not case:
        logger.error('Test case not found: %s', case_id)
        db.close()
        return
    url = (case.application_url or 'https://www.eand.ae/en/index.html').strip()
    display_id = case.display_id
    db.close()

    captured = []
    def persist(objs):
        s_db = SessionLocal()
        try:
            c = s_db.query(AutomationTestCase).filter(AutomationTestCase.id == case_id).first()
            if c:
                c.recorded_flow_objects = list(objs)
                c.flow_discovery_status = 'captured' if objs else 'none'
                twins = s_db.query(AutomationTestCase).filter(AutomationTestCase.display_id == c.display_id, AutomationTestCase.id != c.id).all()
                for tw in twins:
                    tw.recorded_flow_objects = list(objs)
                    tw.flow_discovery_status = 'captured' if objs else 'none'
                s_db.commit()
                logger.info('Persisted %d objects for %s', len(objs), display_id)
        except Exception as e:
            logger.error('Persist error: %s', e)
        finally:
            s_db.close()

    stop_req = False
    def handle_event(source, evt):
        logger.info('Captured DOM: %s (%s)', evt.get('target_name'), evt.get('action'))
        captured.append(evt)
        persist(captured)

    def handle_finish(source, hist=None):
        nonlocal stop_req
        logger.info('Finish & Save clicked for %s', display_id)
        if hist and isinstance(hist, list) and len(hist) > len(captured):
            captured.clear()
            captured.extend(hist)
        persist(captured)
        stop_req = True

    try:
        with sync_playwright() as p:
            launch_args = {
                'headless': False,
                'args': [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-infobars',
                    '--start-maximized'
                ],
                'ignore_default_args': ['--enable-automation']
            }
            try:
                browser = p.chromium.launch(channel='chrome', **launch_args)
            except Exception:
                browser = p.chromium.launch(**launch_args)

            context = browser.new_context(
                viewport={'width': 1920, 'height': 1080},
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            )
            context.add_init_script('Object.defineProperty(navigator, \'webdriver\', {get: () => undefined});')
            context.expose_binding('__onGuidedDiscoveryEvent', handle_event)
            context.expose_binding('__onGuidedDiscoveryFinish', handle_finish)
            context.add_init_script(GUIDED_DISCOVERY_INJECTED_SCRIPT)

            page = context.new_page()
            try:
                page.goto(url, wait_until='domcontentloaded', timeout=45000)
            except Exception as e:
                logger.warning('Nav warning: %s', e)

            while not stop_req:
                try:
                    if page.is_closed() or not browser.is_connected():
                        break
                    time.sleep(0.5)
                except Exception:
                    break
            persist(captured)
            try:
                browser.close()
            except Exception:
                pass
    except Exception as e:
        logger.error('Runner error: %s', e)

if __name__ == '__main__':
    if len(sys.argv) > 1:
        main(int(sys.argv[1]))
