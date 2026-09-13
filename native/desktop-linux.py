#!/usr/bin/env python3
"""DODO Linux X11 backend. JSON stdin; exact executable grants; no clipboard/shell.

Uses X-Resource 1.2 for server-reported process identity, XTEST for bounded
input, Pillow for window-only JPEGs, and the system AT-SPI library for UI text.
An X11 desktop (including an explicitly chosen nested X11 session) is required.
Wayland compositor restrictions are never bypassed with privileged input tools.
"""
import base64
import ctypes as C
import ctypes.util
import hashlib
import io
import json
import os
import re
import sys
import time

class Refused(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)

def require(condition, code, message):
    if not condition:
        raise Refused(code, message)

def number(value):
    require(isinstance(value, (int, float)) and not isinstance(value, bool), 'INVALID_INPUT', 'a number is required')
    require(float('-inf') < value < float('inf'), 'INVALID_INPUT', 'invalid numeric value')
    return value

# X-Resource protocol QueryClientIds, request 4. The server, not _NET_WM_PID,
# supplies local client PIDs. Works with both older and newer python-xlib.
def server_pid(display, window_id):
    from Xlib.protocol import rq
    class CountBytes(rq.LengthOf):
        def parse_value(self, length, unused_display):
            return length // 4
    spec = rq.Struct(rq.Card32('client'), rq.Card32('mask'))
    identity = rq.Struct(rq.Object('spec', spec), CountBytes('value', 4), rq.List('value', rq.Card32Obj))
    class Query(rq.ReplyRequest):
        _request = rq.Struct(rq.Card8('opcode'), rq.Opcode(4), rq.RequestLength(), rq.LengthOf('specs', 4), rq.List('specs', spec))
        _reply = rq.Struct(rq.ReplyCode(), rq.Pad(1), rq.Card16('sequence_number'), rq.ReplyLength(), rq.LengthOf('ids', 4), rq.Pad(20), rq.List('ids', identity))
    extension = display.query_extension('X-Resource')
    require(extension and extension.present, 'NOT_SUPPORTED', 'X-Resource 1.2 process identity is required')
    reply = Query(display=display.display, opcode=extension.major_opcode, specs=[{'client': int(window_id), 'mask': 2}])
    for item in reply.ids:
        if item.spec.mask & 2 and item.value:
            return int(item.value[0])
    raise Refused('FORBIDDEN', 'the X server did not provide a local process identity')

class Accessibility:
    """Bounded, read-only AT-SPI traversal; edits are explicit focused-field input."""
    def __init__(self):
        name = ctypes.util.find_library('atspi')
        require(name is not None, 'NOT_SUPPORTED', 'AT-SPI is not installed; run dodo setup')
        self.lib = C.CDLL(name)
        def bind(name, result, arguments):
            function = getattr(self.lib, name)
            function.restype = result
            function.argtypes = arguments
            return function
        p, e = C.c_void_p, C.c_void_p
        self.init = bind('atspi_init', C.c_int, [])
        self.desktop = bind('atspi_get_desktop', p, [C.c_int])
        self.count = bind('atspi_accessible_get_child_count', C.c_int, [p, e])
        self.child = bind('atspi_accessible_get_child_at_index', p, [p, C.c_int, e])
        self.pid = bind('atspi_accessible_get_process_id', C.c_uint, [p, e])
        self.role = bind('atspi_accessible_get_role_name', C.c_char_p, [p, e])
        self.name = bind('atspi_accessible_get_name', C.c_char_p, [p, e])
        self.states = bind('atspi_accessible_get_state_set', p, [p])
        self.contains = bind('atspi_state_set_contains', C.c_int, [p, C.c_int])
        self.text = bind('atspi_accessible_get_text_iface', p, [p])
        self.editable = bind('atspi_accessible_get_editable_text_iface', p, [p])
        self.caret = bind('atspi_text_get_caret_offset', C.c_int, [p, e])
        self.insert = bind('atspi_editable_text_insert_text', C.c_int, [p, C.c_int, C.c_char_p, C.c_int, e])
        self.component = bind('atspi_accessible_get_component_iface', p, [p])
        class Rect(C.Structure):
            _fields_ = [('x', C.c_int), ('y', C.c_int), ('width', C.c_int), ('height', C.c_int)]
        self.extents = bind('atspi_component_get_extents', C.POINTER(Rect), [p, C.c_int, e])
        require(self.init() == 0, 'NOT_SUPPORTED', 'AT-SPI could not connect to the current user session')

    def elements(self, target, deadline):
        desktop = self.desktop(0)
        require(desktop, 'NOT_SUPPORTED', 'AT-SPI desktop is unavailable')
        queue = []
        for index in range(min(100, max(0, self.count(desktop, None)))):
            app = self.child(desktop, index, None)
            if app and self.pid(app, None) == target['pid']:
                queue.append((app, 0))
        output, scanned = [], 0
        while queue and scanned < 400 and time.time() * 1000 <= deadline:
            element, depth = queue.pop(0)
            scanned += 1
            if not element:
                continue
            role = (self.role(element, None) or b'').decode('utf-8', 'replace')[:100]
            states = self.states(element)
            editable = bool(states and self.contains(states, 7))
            redacted = editable or 'password' in role.lower() or role.lower() in ('text', 'entry')
            component = self.component(element)
            rect = self.extents(component, 0, None) if component else None
            bounds = target['bounds']
            inside = bool(rect and rect.contents.width > 0 and rect.contents.height > 0 and rect.contents.x >= bounds['x'] and rect.contents.y >= bounds['y'] and rect.contents.x + rect.contents.width <= bounds['x'] + bounds['width'] and rect.contents.y + rect.contents.height <= bounds['y'] + bounds['height'])
            if inside:
                output.append((element, states, {'role': role, 'depth': min(depth, 6), 'redacted': redacted, **({} if redacted else {'title': (self.name(element, None) or b'').decode('utf-8', 'replace')[:300]})}))
            if depth < 6 and not redacted:
                for index in range(min(100, max(0, self.count(element, None)))):
                    if len(queue) >= 400:
                        break
                    queue.append((self.child(element, index, None), depth + 1))
            if len(output) >= 100:
                break
        return output, bool(queue)

class Backend:
    def __init__(self):
        from Xlib import display, X, XK
        from PIL import Image
        self.X, self.XK, self.Image = X, XK, Image
        display_name = os.environ.get('DISPLAY', '')
        require(re.fullmatch(r':[0-9]+(?:\.[0-9]+)?', display_name), 'NOT_SUPPORTED', 'a local X11 DISPLAY is required; no TCP display or Wayland permission bypass')
        self.display = display.Display(display_name)
        self.root = self.display.screen().root
        self.display.set_error_handler(lambda error, request: None)
        require(self.display.query_extension('X-Resource').present, 'NOT_SUPPORTED', 'X-Resource 1.2 is required for verified window identity')

    def process(self, pid):
        base = '/proc/' + str(pid)
        require(os.stat(base).st_uid == os.getuid(), 'FORBIDDEN', 'window process belongs to another OS user')
        executable = os.path.realpath(base + '/exe')
        require(os.path.isabs(executable) and os.path.isfile(executable), 'FORBIDDEN', 'window executable is unavailable')
        with open(base + '/stat', encoding='utf-8') as file:
            start = file.read().rsplit(')', 1)[1].split()[19]
        app_id = 'linux.' + hashlib.sha256(executable.encode('utf-8')).hexdigest()[:40]
        return executable, app_id, str(pid) + ':' + start

    def window(self, window_id, allowed, local=False):
        win = self.display.create_resource_object('window', int(window_id))
        require(win.get_attributes().map_state == self.X.IsViewable, 'FORBIDDEN', 'window is not viewable')
        pid = server_pid(self.display, win.id)
        executable, app_id, instance = self.process(pid)
        require(local or app_id in allowed, 'FORBIDDEN', 'window is outside the exact owner allowlist')
        geometry = win.get_geometry()
        require(0 < geometry.width * geometry.height <= 40000000, 'RESOURCE_LIMIT', 'window dimensions exceed the image budget')
        translated = self.root.translate_coords(win, 0, 0)
        title = win.get_wm_name() or ''
        if isinstance(title, bytes):
            title = title.decode('utf-8', 'replace')
        data = {'windowId': win.id, 'pid': pid, 'appId': app_id, 'processIdentity': instance, 'title': str(title)[:300], 'bounds': {'x': translated.x, 'y': translated.y, 'width': geometry.width, 'height': geometry.height}}
        if local:
            data['executable'] = executable
        return win, data

    def top(self, win):
        for _ in range(32):
            parent = win.query_tree().parent
            if parent.id == self.root.id:
                return win
            win = parent
        raise Refused('FORBIDDEN', 'window ancestry exceeds the bound')

    def unobscured(self, win, bounds):
        children = self.root.query_tree().children
        top = self.top(win)
        ids = [item.id for item in children]
        require(top.id in ids, 'CONFLICT', 'window ancestry changed')
        for other in children[ids.index(top.id) + 1:]:
            try:
                if other.get_attributes().map_state != self.X.IsViewable:
                    continue
                g = other.get_geometry()
                if g.x < bounds['x'] + bounds['width'] and g.x + g.width > bounds['x'] and g.y < bounds['y'] + bounds['height'] and g.y + g.height > bounds['y']:
                    raise Refused('CONFLICT', 'another window covers the target; window-only capture/input refused')
            except Refused:
                raise
            except Exception:
                raise Refused('CONFLICT', 'window stacking changed')

    def focused(self, win):
        focus = self.display.get_input_focus().focus
        if not hasattr(focus, 'id'):
            return False
        for _ in range(32):
            if focus.id == win.id:
                return True
            if focus.id == self.root.id:
                return False
            focus = focus.query_tree().parent
        return False

    def fresh(self, request, foreground=False):
        require(time.time() * 1000 <= number(request.get('deadline')), 'STALE_WORKSPACE', 'snapshot deadline expired')
        target = request['target']
        win, now = self.window(target['windowId'], request['allowedApps'])
        for key in ('pid', 'appId', 'processIdentity', 'bounds'):
            require(now[key] == target.get(key), 'STALE_WORKSPACE', 'window identity/geometry changed; capture again')
        require(not foreground or self.focused(win), 'CONFLICT', 'target is not focused; input refused')
        return win, now

    def capture(self, request):
        # Freeze other X clients while checking stacking and obtaining pixels.
        # Closing a failed helper releases the server grab automatically.
        self.display.grab_server()
        try:
            win, data = self.window(request['windowId'], request['allowedApps'])
            b = data['bounds']
            self.unobscured(win, b)
            raw = win.get_image(0, 0, b['width'], b['height'], self.X.ZPixmap, 0xffffffff)
            require(raw is not None, 'NOT_SUPPORTED', 'X server could not capture this window')
            formats = self.display.display.info.pixmap_formats
            pix = next((fmt for fmt in formats if fmt.depth == raw.depth), None)
            require(pix and raw.depth in (24, 32) and pix.bits_per_pixel in (24, 32), 'NOT_SUPPORTED', 'only 24/32-bit TrueColor X11 images are supported')
            require(self.display.display.info.image_byte_order == self.X.LSBFirst, 'NOT_SUPPORTED', 'unsupported X11 image byte order')
            stride = ((b['width'] * pix.bits_per_pixel + pix.scanline_pad - 1) // pix.scanline_pad) * (pix.scanline_pad // 8)
            image = self.Image.frombytes('RGB', (b['width'], b['height']), raw.data, 'raw', 'BGRX' if pix.bits_per_pixel == 32 else 'BGR', stride, 1)
            max_edge = int(number(request.get('maxEdge', 1280)))
            require(1 <= max_edge <= 2000, 'INVALID_INPUT', 'invalid maxEdge')
            image.thumbnail((max_edge, max_edge))
            output = io.BytesIO()
            image.save(output, 'JPEG', quality=75)
            content = output.getvalue()
            require(len(content) <= 3 * 1024 * 1024, 'RESOURCE_LIMIT', 'window JPEG is oversized')
            data.update({'imageWidth': image.width, 'imageHeight': image.height, 'mimeType': 'image/jpeg', 'image': base64.b64encode(content).decode('ascii')})
            return data
        finally:
            self.display.ungrab_server()
            self.display.sync()

    def position(self, request, x, y):
        win, data = self.fresh(request, True)
        target, bounds = request['target'], data['bounds']
        require(0 <= x < target['imageWidth'] and 0 <= y < target['imageHeight'], 'INVALID_INPUT', 'coordinates outside captured image')
        self.unobscured(win, bounds)
        px = int(bounds['x'] + x * bounds['width'] / target['imageWidth'])
        py = int(bounds['y'] + y * bounds['height'] / target['imageHeight'])
        self.display.xtest_fake_input(self.X.MotionNotify, x=px, y=py)
        self.display.sync()

    def key(self, request, keysym, modifiers=()):
        code = self.display.keysym_to_keycode(keysym)
        require(code != 0, 'NOT_SUPPORTED', 'key is not present in the current X11 keyboard mapping')
        held = []
        try:
            for symbol in modifiers:
                keycode = self.display.keysym_to_keycode(self.XK.string_to_keysym(symbol))
                require(keycode != 0, 'NOT_SUPPORTED', 'modifier is absent from keyboard mapping')
                held.append(keycode)
                self.display.xtest_fake_input(self.X.KeyPress, keycode)
            self.fresh(request, True)
            held.append(code)
            self.display.xtest_fake_input(self.X.KeyPress, code)
        finally:
            for keycode in reversed(held):
                self.display.xtest_fake_input(self.X.KeyRelease, keycode)
            self.display.sync()

    def action(self, request):
        require(self.display.query_extension('XTEST').present, 'NOT_SUPPORTED', 'XTEST is not available')
        action = request['action']
        kind = action['kind']
        win, target = self.fresh(request)
        if kind == 'focus':
            win.configure(stack_mode=self.X.Above)
            win.set_input_focus(self.X.RevertToParent, self.X.CurrentTime)
            self.display.sync()
            self.fresh(request, True)
        elif kind == 'type':
            self.fresh(request, True)
            text = action.get('text', '')
            require(isinstance(text, str) and 0 < len(text) <= 2000, 'INVALID_INPUT', 'invalid text length')
            accessibility = Accessibility()
            elements, _ = accessibility.elements(target, request['deadline'])
            candidates = [(element, states) for element, states, _ in elements if states and accessibility.contains(states, 12) and accessibility.editable(element)]
            require(len(candidates) == 1, 'NOT_SUPPORTED', 'typing requires one focused AT-SPI editable field in the permitted window')
            element = candidates[0][0]
            text_interface = accessibility.text(element)
            require(text_interface, 'NOT_SUPPORTED', 'focused control does not expose text insertion')
            offset = accessibility.caret(text_interface, None)
            require(offset >= 0, 'NOT_SUPPORTED', 'focused control has no valid insertion point')
            self.fresh(request, True)
            require(accessibility.insert(accessibility.editable(element), offset, text.encode('utf-8'), len(text), None), 'FORBIDDEN', 'AT-SPI text insertion was rejected')
        elif kind == 'key':
            names = {'enter':'Return','tab':'Tab','space':'space','backspace':'BackSpace','escape':'Escape','delete':'Delete','left':'Left','right':'Right','up':'Up','down':'Down','home':'Home','end':'End','pageup':'Prior','pagedown':'Next'}
            key = action.get('key', '')
            require(re.fullmatch(r'(?:[a-z0-9]|f[1-9]|f1[0-2]|enter|tab|space|backspace|escape|delete|left|right|up|down|home|end|pageup|pagedown)', key), 'INVALID_INPUT', 'unknown key')
            name = names.get(key, key.upper() if key.startswith('f') and len(key) > 1 else key)
            mods = {'command':'Super_L','control':'Control_L','option':'Alt_L','shift':'Shift_L'}
            requested = action.get('modifiers', [])
            require(isinstance(requested, list) and len(requested) <= 4 and all(item in mods for item in requested), 'INVALID_INPUT', 'invalid modifiers')
            self.key(request, self.XK.string_to_keysym(name), [mods[item] for item in requested])
        else:
            require(kind in ('move', 'click', 'scroll', 'drag'), 'INVALID_INPUT', 'unsupported action')
            x, y = number(action.get('x')), number(action.get('y'))
            self.position(request, x, y)
            buttons = []
            if kind == 'click':
                count = int(number(action.get('count', 1)))
                require(count in (1, 2), 'INVALID_INPUT', 'invalid click count')
                buttons = [3 if action.get('button') == 'right' else 1] * count
            elif kind == 'scroll':
                dx, dy = int(number(action.get('deltaX', 0))), int(number(action.get('deltaY', 0)))
                require(abs(dx) <= 1000 and abs(dy) <= 1000, 'INVALID_INPUT', 'scroll limit exceeded')
                buttons = ([5 if dy > 0 else 4] * ((abs(dy) + 119) // 120)) + ([7 if dx > 0 else 6] * ((abs(dx) + 119) // 120))
            elif kind == 'drag':
                tx, ty = number(action.get('toX')), number(action.get('toY'))
                try:
                    self.display.xtest_fake_input(self.X.ButtonPress, 1)
                    for index in range(1, 11):
                        self.position(request, x + (tx - x) * index / 10, y + (ty - y) * index / 10)
                finally:
                    self.display.xtest_fake_input(self.X.ButtonRelease, 1)
                    self.display.sync()
            for button in buttons:
                self.position(request, x, y)
                try:
                    self.display.xtest_fake_input(self.X.ButtonPress, button)
                finally:
                    self.display.xtest_fake_input(self.X.ButtonRelease, button)
                    self.display.sync()
        return {'posted': True, 'note': 'Input sent to the owner-permitted window. Verify the effect with a fresh observation.'}

    def run(self, request):
        op = request.get('op')
        if op in ('status', 'requestPermissions'):
            accessibility = False
            if self.display.query_extension('XTEST').present and ctypes.util.find_library('atspi'):
                try:
                    bridge = Accessibility()
                    accessibility = bool(bridge.desktop(0))
                except Exception:
                    accessibility = False
            return {'screenRecording': True, 'accessibility': accessibility, 'platform': 'linux', 'backend': 'x11-xres-xtest-atspi'}
        local = op == 'apps'
        allowed = request.get('allowedApps', [])
        require(local or (isinstance(allowed, list) and 0 < len(allowed) <= 20 and all(isinstance(value, str) for value in allowed)), 'FORBIDDEN', 'exact owner app grants are required')
        if op in ('windows', 'apps'):
            prop = self.root.get_full_property(self.display.intern_atom('_NET_CLIENT_LIST'), self.X.AnyPropertyType)
            ids = list(prop.value) if prop else [win.id for win in self.root.query_tree().children]
            windows = []
            for window_id in ids[:1000]:
                try:
                    _, data = self.window(window_id, allowed, local)
                    windows.append(data)
                    if len(windows) >= 100:
                        break
                except Exception:
                    continue
            return {'windows': windows, 'truncated': len(ids) > 1000 or len(windows) >= 100}
        if op == 'capture':
            return self.capture(request)
        if op == 'action':
            return self.action(request)
        if op == 'accessibility':
            _, target = self.fresh(request)
            elements, truncated = Accessibility().elements(target, request['deadline'])
            self.fresh(request)
            return {'elements': [row for _, _, row in elements], 'truncated': truncated}
        raise Refused('INVALID_INPUT', 'unknown desktop operation')

def main():
    request = {}
    backend = None
    try:
        data = sys.stdin.buffer.read(65537)
        require(len(data) <= 65536, 'RESOURCE_LIMIT', 'desktop request exceeds limit')
        request = json.loads(data.decode('utf-8'))
        require(isinstance(request, dict), 'INVALID_INPUT', 'request must be an object')
        backend = Backend()
        output = {'ok': True, 'data': backend.run(request)}
    except Exception as error:
        code = error.code if isinstance(error, Refused) else 'NOT_SUPPORTED'
        message = str(error) if isinstance(error, Refused) else 'Linux desktop operation failed; verify the local X11 session and setup dependencies'
        if request.get('op') in ('status', 'requestPermissions'):
            output = {'ok': True, 'data': {'screenRecording': False, 'accessibility': False, 'platform': 'linux', 'backend': 'x11-xres-xtest-atspi (session/dependencies unavailable)'}}
        else:
            output = {'ok': False, 'error': {'code': code, 'message': message}}
    finally:
        if backend is not None:
            backend.display.close()
    print(json.dumps(output, ensure_ascii=True, separators=(',', ':')))
    return 0 if output['ok'] else 1

if __name__ == '__main__':
    sys.exit(main())
