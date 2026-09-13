import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 600, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "DODO Desktop Test Fixture"
let heading = NSTextField(labelWithString: "DODO FIXTURE 42")
heading.frame = NSRect(x: 40, y: 310, width: 500, height: 45)
heading.font = .systemFont(ofSize: 30)
window.contentView?.addSubview(heading)
let field = NSTextField(frame: NSRect(x: 40, y: 220, width: 500, height: 40))
field.stringValue = "fixture input"
field.setAccessibilityIdentifier("fixture-input")
window.contentView?.addSubview(field)
let result = NSTextField(labelWithString: "Clicks: 0")
result.frame = NSRect(x: 40, y: 75, width: 500, height: 40)
window.contentView?.addSubview(result)
final class Target: NSObject {
    var count = 0
    let result: NSTextField
    init(_ result: NSTextField) { self.result = result }
    @objc func click() { count += 1; result.stringValue = "Clicks: \(count)" }
}
let target = Target(result)
let button = NSButton(title: "Fixture button", target: target, action: #selector(Target.click))
button.frame = NSRect(x: 40, y: 145, width: 220, height: 45)
button.bezelStyle = .rounded
window.contentView?.addSubview(button)
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
