import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision

// One bounded JSON request on stdin, one JSON response on stdout. No shell,
// network, clipboard, filesystem output, or arbitrary AppleScript execution.
struct Failure: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) throws -> Never { throw Failure(code: code, message: message) }
func integer(_ o: [String: Any], _ k: String) throws -> Int {
    guard let n = o[k] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, n.doubleValue.rounded() == n.doubleValue else { try fail("INVALID_INPUT", "invalid integer: \(k)") }
    return n.intValue
}
func number(_ o: [String: Any], _ k: String) throws -> Double {
    guard let n = o[k] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { try fail("INVALID_INPUT", "invalid number: \(k)") }
    return n.doubleValue
}
func clipped(_ s: String, _ max: Int) -> String { String(decoding: s.utf16.prefix(max), as: UTF16.self) }
func frameJSON(_ r: CGRect) -> [String: Double] { ["x":r.minX,"y":r.minY,"width":r.width,"height":r.height] }
func screenPermission() throws { if !CGPreflightScreenCaptureAccess() { try fail("FORBIDDEN", "Screen Recording permission is required; use dodo desktop setup --request-permissions locally") } }
func controlPermission() throws { if !AXIsProcessTrusted() { try fail("FORBIDDEN", "Accessibility permission is required; use dodo desktop setup --request-permissions locally") } }
func bounds(_ w: [String: Any]) -> CGRect { CGRect(dictionaryRepresentation: (w[kCGWindowBounds as String] as? [String: Any] ?? [:]) as CFDictionary) ?? .zero }
func windowRows() -> [[String: Any]] { CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [] }
func appID(_ pid: Int32) -> String? { NSRunningApplication(processIdentifier: pid)?.bundleIdentifier }
func allowedApps(_ req: [String: Any]) throws -> [String] {
    guard let apps=req["allowedApps"] as? [String], !apps.isEmpty, apps.count <= 20, apps.allSatisfy({ $0.count <= 200 && $0.contains(".") && !$0.contains("*") }) else { try fail("FORBIDDEN", "explicit allowed applications are required") }
    return apps
}
func window(_ id: Int, apps: [String]) throws -> [String: Any] {
    guard let w=windowRows().first(where: { ($0[kCGWindowNumber as String] as? Int)==id && ($0[kCGWindowLayer as String] as? Int)==0 }), let pid=w[kCGWindowOwnerPID as String] as? Int32, let app=appID(pid), apps.contains(app) else { try fail("FORBIDDEN", "window is unavailable or outside the allowed applications") }
    let r=bounds(w)
    guard r.width >= 10 && r.height >= 10 else { try fail("INVALID_INPUT", "window has no capturable area") }
    return w
}
func describe(_ w: [String: Any]) -> [String: Any] {
    let pid=w[kCGWindowOwnerPID as String] as? Int32 ?? 0
    return ["windowId":w[kCGWindowNumber as String] as? Int ?? 0,"pid":pid,"appId":appID(pid) ?? "", "title":clipped(w[kCGWindowName as String] as? String ?? "",300),"bounds":frameJSON(bounds(w))]
}
func validTarget(_ req: [String: Any], foreground: Bool) throws -> [String: Any] {
    guard let target=req["target"] as? [String: Any], let old=target["bounds"] as? [String: Any] else { try fail("INVALID_INPUT", "target required") }
    let w=try window(integer(target,"windowId"),apps:allowedApps(req)), r=bounds(w)
    guard try integer(target,"pid") == (w[kCGWindowOwnerPID as String] as? Int), target["appId"] as? String == appID(w[kCGWindowOwnerPID as String] as? Int32 ?? 0),
          abs(r.minX-(try number(old,"x"))) < 0.5, abs(r.minY-(try number(old,"y"))) < 0.5,
          abs(r.width-(try number(old,"width"))) < 0.5, abs(r.height-(try number(old,"height"))) < 0.5 else { try fail("STALE_WORKSPACE", "window moved, resized or changed; capture it again") }
    if let deadline=req["deadline"] as? Double, Date().timeIntervalSince1970*1000 > deadline { try fail("STALE_WORKSPACE", "desktop authorization expired") }
    if foreground {
        let first=windowRows().first { ($0[kCGWindowLayer as String] as? Int)==0 }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == (w[kCGWindowOwnerPID as String] as? Int32), first?[kCGWindowNumber as String] as? Int == w[kCGWindowNumber as String] as? Int else { try fail("CONFLICT", "target must be the frontmost window; focus it then capture again") }
    }
    return w
}
func point(_ a: [String: Any], _ x: String, _ y: String, req: [String: Any], rect: CGRect) throws -> CGPoint {
    guard let target=req["target"] as? [String: Any] else { try fail("INVALID_INPUT", "target missing") }
    let px=try number(a,x), py=try number(a,y), width=try number(target,"imageWidth"), height=try number(target,"imageHeight")
    guard width > 0 && height > 0 && px >= 0 && py >= 0 && px < width && py < height else { try fail("INVALID_INPUT", "coordinates must be inside the captured image") }
    return CGPoint(x:rect.minX+px/width*rect.width,y:rect.minY+py/height*rect.height)
}
let keyCodes: [String: CGKeyCode] = ["enter":36,"tab":48,"space":49,"backspace":51,"escape":53,"delete":117,"left":123,"right":124,"down":125,"up":126,"home":115,"end":119,"pageup":116,"pagedown":121,"a":0,"b":11,"c":8,"d":2,"e":14,"f":3,"g":5,"h":4,"i":34,"j":38,"k":40,"l":37,"m":46,"n":45,"o":31,"p":35,"q":12,"r":15,"s":1,"t":17,"u":32,"v":9,"w":13,"x":7,"y":16,"z":6,"0":29,"1":18,"2":19,"3":20,"4":21,"5":23,"6":22,"7":26,"8":28,"9":25,"f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111]
func flags(_ a: [String: Any]) throws -> CGEventFlags {
    let names=a["modifiers"] as? [String] ?? []; var result:CGEventFlags=[]
    for n in names { switch n { case "command":result.insert(.maskCommand);case "control":result.insert(.maskControl);case "option":result.insert(.maskAlternate);case "shift":result.insert(.maskShift);default:try fail("INVALID_INPUT","invalid modifier") } }
    return result
}
func unoccluded(_ point: CGPoint, target: [String: Any]) throws {
    for row in windowRows() {
        if row[kCGWindowNumber as String] as? Int == target[kCGWindowNumber as String] as? Int { return }
        if (row[kCGWindowAlpha as String] as? Double ?? 1) > 0.01 && bounds(row).contains(point) {
            try fail("CONFLICT", "another window or overlay covers the target point; capture again")
        }
    }
    try fail("CONFLICT", "target window disappeared")
}
func emitMouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, _ click: Int64=1) throws {
    guard let e=CGEvent(mouseEventSource:CGEventSource(stateID:.privateState),mouseType:type,mouseCursorPosition:p,mouseButton:button) else { try fail("INTERNAL_ERROR","cannot create mouse event") }
    e.setIntegerValueField(.mouseEventClickState,value:click);e.post(tap:.cghidEventTap)
}
func ax(_ e: AXUIElement,_ attribute: String) -> CFTypeRef? { var v:CFTypeRef?;guard AXUIElementCopyAttributeValue(e,attribute as CFString,&v) == .success else{return nil};return v }
func axWindow(_ w:[String:Any]) -> AXUIElement? {
    let app=AXUIElementCreateApplication(w[kCGWindowOwnerPID as String] as? Int32 ?? 0)
    AXUIElementSetMessagingTimeout(app,0.3)
    let target=bounds(w)
    for item in (ax(app,kAXWindowsAttribute) as? [AXUIElement] ?? []) {
        guard let p=ax(item,kAXPositionAttribute), let s=ax(item,kAXSizeAttribute),CFGetTypeID(p)==AXValueGetTypeID(),CFGetTypeID(s)==AXValueGetTypeID() else{continue}
        var point=CGPoint.zero;var size=CGSize.zero
        AXValueGetValue(p as! AXValue,.cgPoint,&point);AXValueGetValue(s as! AXValue,.cgSize,&size)
        if abs(point.x-target.minX)<1 && abs(point.y-target.minY)<1 && abs(size.width-target.width)<1 && abs(size.height-target.height)<1{return item}
    };return nil
}
func perform(_ req:[String:Any]) throws -> [String:Any] {
    try screenPermission();try controlPermission()
    guard let a=req["action"] as? [String:Any],let kind=a["kind"] as? String else{try fail("INVALID_INPUT","action required")}
    let w=try validTarget(req,foreground:kind != "focus"),rect=bounds(w)
    if kind == "focus" {
        guard let element=axWindow(w), let app=NSRunningApplication(processIdentifier:w[kCGWindowOwnerPID as String] as? Int32 ?? 0) else{try fail("CONFLICT","cannot identify the accessibility window")}
        guard AXUIElementPerformAction(element,kAXRaiseAction as CFString) == .success else{try fail("FORBIDDEN","application refused window focus")}
        guard app.activate(options:[]) else{try fail("FORBIDDEN","application refused activation")}
        return ["posted":true,"note":"focus requested; capture again before input"]
    }
    switch kind {
    case "move", "click":
        let p=try point(a,"x","y",req:req,rect:rect)
        try unoccluded(p,target:w)
        if kind == "move" {try emitMouse(.mouseMoved,p,.left)} else {
            let right=(a["button"] as? String) == "right",button:CGMouseButton=right ? .right:.left,down:CGEventType=right ? .rightMouseDown:.leftMouseDown,up:CGEventType=right ? .rightMouseUp:.leftMouseUp
            let count=try integer(a,"count");guard (1...2).contains(count) else{try fail("INVALID_INPUT","invalid click count")}
            for i in 1...count { _=try validTarget(req,foreground:true);try emitMouse(down,p,button,Int64(i));try emitMouse(up,p,button,Int64(i)) }
        }
    case "drag":
        let from=try point(a,"x","y",req:req,rect:rect),to=try point(a,"toX","toY",req:req,rect:rect)
        try unoccluded(from,target:w);try unoccluded(to,target:w)
        try emitMouse(.leftMouseDown,from,.left)
        defer { try? emitMouse(.leftMouseUp,to,.left) }
        for i in 1...10 { _=try validTarget(req,foreground:true);let t=Double(i)/10;try emitMouse(.leftMouseDragged,CGPoint(x:from.x+(to.x-from.x)*t,y:from.y+(to.y-from.y)*t),.left);Thread.sleep(forTimeInterval:0.01) }
    case "scroll":
        let p=try point(a,"x","y",req:req,rect:rect),dx=try integer(a,"deltaX"),dy=try integer(a,"deltaY")
        guard dx >= -1000 && dx <= 1000 && dy >= -1000 && dy <= 1000 else{try fail("INVALID_INPUT","scroll exceeds limit")}
        try unoccluded(p,target:w);try emitMouse(.mouseMoved,p,.left)
        guard let e=CGEvent(scrollWheelEvent2Source:CGEventSource(stateID:.privateState),units:.pixel,wheelCount:2,wheel1:Int32(dy),wheel2:Int32(dx),wheel3:0) else{try fail("INTERNAL_ERROR","cannot create scroll event")}
        e.location=p;e.post(tap:.cghidEventTap)
    case "key":
        guard let key=a["key"] as? String,let code=keyCodes[key] else{try fail("INVALID_INPUT","unsupported key")}
        let modifiers=try flags(a)
        for down in [true,false] {guard let e=CGEvent(keyboardEventSource:CGEventSource(stateID:.privateState),virtualKey:code,keyDown:down) else{try fail("INTERNAL_ERROR","cannot create keyboard event")};e.flags=modifiers;e.post(tap:.cghidEventTap)}
    case "type":
        guard let text=a["text"] as? String,!text.isEmpty,text.utf16.count<=2000 else{try fail("INVALID_INPUT","text exceeds 2000 UTF-16 units")}
        // Bounded UTF-16 chunks preserve surrogate pairs; no clipboard changes.
        var chunks:[[UInt16]]=[],current:[UInt16]=[]
        for scalar in text.unicodeScalars {
            let units=Array(String(scalar).utf16)
            if current.count+units.count>16 {chunks.append(current);current=[]}
            current.append(contentsOf:units)
        }
        if !current.isEmpty {chunks.append(current)}
        for units in chunks {
            _=try validTarget(req,foreground:true)
            for down in [true,false] {
                guard let e=CGEvent(keyboardEventSource:CGEventSource(stateID:.privateState),virtualKey:0,keyDown:down) else{try fail("INTERNAL_ERROR","cannot create Unicode event")}
                units.withUnsafeBufferPointer {e.keyboardSetUnicodeString(stringLength:units.count,unicodeString:$0.baseAddress!)}
                e.post(tap:.cghidEventTap)
            }
        }
    default:try fail("INVALID_INPUT","unsupported action")
    }
    return ["posted":true,"note":"OS events posted; capture again to verify the application result"]
}
@available(macOS 14.0, *)
func capture(_ req:[String:Any]) async throws -> [String:Any] {
    try screenPermission();let apps=try allowedApps(req),id=try integer(req,"windowId"),row=try window(id,apps:apps)
    let content=try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
    guard let win=content.windows.first(where: {Int($0.windowID)==id && $0.owningApplication?.processID == row[kCGWindowOwnerPID as String] as? Int32}) else{try fail("CONFLICT","window is no longer capturable")}
    let r=bounds(row),edge=try integer(req,"maxEdge");guard (320...2000).contains(edge) else{try fail("INVALID_INPUT","invalid image size")}
    let scale=min(1,Double(edge)/max(r.width,r.height));let config=SCStreamConfiguration()
    config.width=max(1,Int(r.width*scale));config.height=max(1,Int(r.height*scale));config.showsCursor=false;config.ignoreShadowsSingleWindow=true
    let image=try await SCScreenshotManager.captureImage(contentFilter:SCContentFilter(desktopIndependentWindow:win),configuration:config)
    let now=try window(id,apps:apps)
    guard bounds(now)==r else{try fail("CONFLICT","window changed during capture")}
    let bitmap=NSBitmapImageRep(cgImage:image)
    guard let bytes=bitmap.representation(using:.jpeg,properties:[.compressionFactor:0.75]),bytes.count<=3*1024*1024 else{try fail("RESOURCE_LIMIT","captured image exceeds 3 MiB")}
    var result=describe(now);result["imageWidth"]=image.width;result["imageHeight"]=image.height;result["mimeType"]="image/jpeg";result["image"]=bytes.base64EncodedString()
    if req["ocr"] as? Bool == true {
        let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.usesLanguageCorrection=false
        try VNImageRequestHandler(cgImage:image,options:[:]).perform([request])
        let observations=request.results ?? []
        result["ocr"]=observations.prefix(150).compactMap { o -> [String:Any]? in
            guard let c=o.topCandidates(1).first else{return nil};let b=o.boundingBox
            return ["text":clipped(c.string,500),"confidence":c.confidence,"x":b.minX*Double(image.width),"y":(1-b.maxY)*Double(image.height),"width":b.width*Double(image.width),"height":b.height*Double(image.height)]
        }
        result["ocrTruncated"]=observations.count>150
    }
    return result
}
func accessibility(_ req:[String:Any]) throws -> [String:Any] {
    try screenPermission();try controlPermission();let w=try validTarget(req,foreground:false)
    guard let root=axWindow(w) else{try fail("NOT_SUPPORTED","application does not expose this window through Accessibility")}
    var queue:[(AXUIElement,Int)]=[(root,0)],rows:[[String:Any]]=[];let started=Date()
    while !queue.isEmpty && rows.count<100 && Date().timeIntervalSince(started)<1.5 {
        let (e,depth)=queue.removeFirst();AXUIElementSetMessagingTimeout(e,0.15)
        let role=ax(e,kAXRoleAttribute) as? String ?? "unknown",subrole=ax(e,kAXSubroleAttribute) as? String ?? ""
        // Never read value/title/children of secure text fields.
        if subrole == kAXSecureTextFieldSubrole as String {rows.append(["role":role,"redacted":true,"depth":depth]);continue}
        var row:[String:Any]=["role":role,"depth":depth]
        for (key,attr) in [("title",kAXTitleAttribute),("description",kAXDescriptionAttribute),("value",kAXValueAttribute)] {if let s=ax(e,attr) as? String {row[key]=clipped(s,300)}}
        rows.append(row)
        if depth<6 {for child in (ax(e,kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(max(0,100-queue.count-rows.count)) {queue.append((child,depth+1))}}
    }
    return ["elements":rows,"truncated":!queue.isEmpty]
}
@main struct DesktopHelper {
    static func main() async {
        do {
            let bytes=FileHandle.standardInput.readDataToEndOfFile()
            guard bytes.count <= 64*1024,let req=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],let op=req["op"] as? String else{try fail("INVALID_INPUT","invalid desktop request")}
            var data:[String:Any]
            switch op {
            case "status","requestPermissions":
                if op == "requestPermissions" {_=CGRequestScreenCaptureAccess();let options=[kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary;_=AXIsProcessTrustedWithOptions(options)}
                data=["screenRecording":CGPreflightScreenCaptureAccess(),"accessibility":AXIsProcessTrusted(),"platform":"darwin","backend":"ScreenCaptureKit/CGEvent/AX/Vision"]
            case "windows":try screenPermission();let apps=try allowedApps(req);let rows=windowRows().filter { w in guard let pid=w[kCGWindowOwnerPID as String] as? Int32,let app=appID(pid) else{return false};return apps.contains(app) && (w[kCGWindowLayer as String] as? Int)==0 && bounds(w).width>=10 && bounds(w).height>=10 };data=["windows":rows.prefix(100).map(describe),"truncated":rows.count>100]
            case "capture":if #available(macOS 14.0, *){data=try await capture(req)}else{try fail("NOT_SUPPORTED","macOS 14 or newer required")}
            case "action":data=try perform(req)
            case "accessibility":data=try accessibility(req)
            default:try fail("INVALID_INPUT","unknown operation")
            }
            let out=try JSONSerialization.data(withJSONObject:["ok":true,"data":data],options:[.sortedKeys]);FileHandle.standardOutput.write(out)
        } catch {
            let f=error as? Failure ?? Failure(code:"INTERNAL_ERROR",message:"macOS desktop operation failed; check permissions and capture again")
            let out=(try? JSONSerialization.data(withJSONObject:["ok":false,"error":["code":f.code,"message":f.message]])) ?? Data();FileHandle.standardOutput.write(out)
            exit(1)
        }
    }
}
