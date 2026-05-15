import AppKit
import CoreGraphics
import Foundation

// Borderless transparent click-through window that follows piped "monitor u v" updates.
// stdin: "<main|left> <u> <v>" lines, where u,v ∈ [0,1] within the target display.

class CircleView: NSView {
    override func draw(_ dirty: NSRect) {
        let r = bounds.insetBy(dx: 4, dy: 4)
        let path = NSBezierPath(ovalIn: r)
        NSColor(calibratedRed: 0.20, green: 0.85, blue: 1.00, alpha: 0.40).setFill()
        path.fill()
        NSColor(calibratedRed: 0.20, green: 0.85, blue: 1.00, alpha: 0.95).setStroke()
        path.lineWidth = 2.5
        path.stroke()
    }
}

let SIZE: CGFloat = 64

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

var displays = [CGDirectDisplayID](repeating: 0, count: 8)
var n: UInt32 = 0
if CGGetActiveDisplayList(8, &displays, &n) != .success { n = 0 }
let mainID = CGMainDisplayID()
let otherID: CGDirectDisplayID = (0..<Int(n)).map { displays[$0] }.first { $0 != mainID } ?? mainID

let window = NSWindow(
    contentRect: NSRect(x: 100, y: 100, width: SIZE, height: SIZE),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)
window.level = NSWindow.Level.statusBar
window.isOpaque = false
window.backgroundColor = .clear
window.hasShadow = false
window.ignoresMouseEvents = true
window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
window.contentView = CircleView(frame: NSRect(x: 0, y: 0, width: SIZE, height: SIZE))
window.orderFrontRegardless()

FileHandle.standardError.write("dwell-blob ready (main=\(mainID), left=\(otherID))\n".data(using: .utf8)!)

DispatchQueue.global().async {
    while let line = readLine() {
        let parts = line.split(separator: " ")
        // alpha <0..1>             → instant set
        // fade <0..1> <duration_s> → animated transition over duration_s
        if parts.count == 2, parts[0] == "alpha", let a = Double(parts[1]) {
            let alpha = max(0.0, min(1.0, a))
            DispatchQueue.main.async { window.alphaValue = CGFloat(alpha) }
            continue
        }
        if parts.count == 3, parts[0] == "fade", let a = Double(parts[1]), let d = Double(parts[2]) {
            let alpha = max(0.0, min(1.0, a))
            let dur = max(0.05, d)
            DispatchQueue.main.async {
                NSAnimationContext.runAnimationGroup { ctx in
                    ctx.duration = dur
                    window.animator().alphaValue = CGFloat(alpha)
                }
            }
            continue
        }
        guard parts.count == 3,
              let u = Double(parts[1]),
              let v = Double(parts[2]) else { continue }
        let target = String(parts[0])
        let id: CGDirectDisplayID = (target == "main") ? mainID : (target == "left") ? otherID : mainID
        let b = CGDisplayBounds(id)
        let cu = max(0.0, min(1.0, u))
        let cv = max(0.0, min(1.0, v))
        let cgX = b.origin.x + cu * b.width
        let cgY = b.origin.y + cv * b.height
        DispatchQueue.main.async {
            // NSScreen.main is nil when no window is key (locked screen,
            // headless). This runs on every pose update, so a force-unwrap
            // would crash the blob daemon mid-session. Fall back, and if there
            // is genuinely no screen, skip this position update (no crash).
            guard let primary = NSScreen.screens.first(where: { $0.frame.origin == .zero })
                                ?? NSScreen.screens.first else { return }
            let primaryH = primary.frame.height
            let cocoaY = primaryH - cgY
            window.setFrameOrigin(NSPoint(x: cgX - SIZE/2, y: cocoaY - SIZE/2))
        }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}

app.run()
