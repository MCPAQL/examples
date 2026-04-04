import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// stdin commands:
//   "<main|left> <u> <v>"           → query; output "pid|name|wnum" or "none"
//   "focus <main|left> <u> <v>"     → AX-raise the window at that point + activate the app

let out = FileHandle.standardOutput
let err = FileHandle.standardError
func emit(_ s: String) { out.write((s + "\n").data(using: .utf8)!) }

var displays = [CGDirectDisplayID](repeating: 0, count: 8)
var nDisp: UInt32 = 0
CGGetActiveDisplayList(8, &displays, &nDisp)
let mainID = CGMainDisplayID()
let otherID: CGDirectDisplayID = (0..<Int(nDisp)).map { displays[$0] }.first { $0 != mainID } ?? mainID
err.write("window-at-point ready (main=\(mainID), left=\(otherID))\n".data(using: .utf8)!)

// Request Accessibility (needed for AX-raise on focus action). Prompt once.
let trusted = AXIsProcessTrustedWithOptions(
    [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
err.write("AX trusted at startup: \(trusted)\n".data(using: .utf8)!)

func resolveCG(_ target: String, _ u: Double, _ v: Double) -> CGPoint {
    let id: CGDirectDisplayID = (target == "main") ? mainID : (target == "left") ? otherID : mainID
    let b = CGDisplayBounds(id)
    let cu = max(0.0, min(1.0, u)), cv = max(0.0, min(1.0, v))
    return CGPoint(x: b.origin.x + cu * b.width, y: b.origin.y + cv * b.height)
}

func windowAt(_ p: CGPoint) -> [String: Any]? {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windows = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in windows {
        guard
            let bounds = w[kCGWindowBounds as String] as? [String: CGFloat],
            let layer = w[kCGWindowLayer as String] as? Int,
            layer == 0
        else { continue }
        let r = CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0,
                       width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0)
        if r.width < 80 || r.height < 60 { continue }
        if r.contains(p) {
            guard
                let pid = w[kCGWindowOwnerPID as String] as? pid_t,
                let app = NSRunningApplication(processIdentifier: pid),
                app.activationPolicy == .regular
            else { continue }
            return w
        }
    }
    return nil
}

func raiseAXWindow(pid: pid_t, cgFrame: CGRect) -> Bool {
    let appElem = AXUIElementCreateApplication(pid)
    var winsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute as CFString, &winsRef) == .success,
          let axWindows = winsRef as? [AXUIElement] else { return false }
    var bestMatch: AXUIElement? = nil
    var bestD = CGFloat.greatestFiniteMagnitude
    for ax in axWindows {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        AXUIElementCopyAttributeValue(ax, kAXPositionAttribute as CFString, &posRef)
        AXUIElementCopyAttributeValue(ax, kAXSizeAttribute as CFString, &sizeRef)
        guard let pr = posRef, let sr = sizeRef else { continue }
        var pos = CGPoint.zero, size = CGSize.zero
        AXValueGetValue(pr as! AXValue, .cgPoint, &pos)
        AXValueGetValue(sr as! AXValue, .cgSize, &size)
        let axRect = CGRect(origin: pos, size: size)
        let dx = axRect.midX - cgFrame.midX, dy = axRect.midY - cgFrame.midY
        let d = dx*dx + dy*dy
        if d < bestD { bestD = d; bestMatch = ax }
    }
    guard let win = bestMatch else { return false }
    AXUIElementPerformAction(win, kAXRaiseAction as CFString)
    return true
}

while let line = readLine() {
    if line.hasPrefix("focus ") {
        let rest = String(line.dropFirst(6))
        let parts = rest.split(separator: " ")
        guard parts.count == 3, let u = Double(parts[1]), let v = Double(parts[2]) else { emit("err: bad focus"); continue }
        let target = String(parts[0])
        let p = resolveCG(target, u, v)
        guard
            let w = windowAt(p),
            let pid = w[kCGWindowOwnerPID as String] as? pid_t,
            let bounds = w[kCGWindowBounds as String] as? [String: CGFloat],
            let app = NSRunningApplication(processIdentifier: pid)
        else { emit("err: no window at point"); continue }
        let frame = CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0,
                           width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0)
        let raised = raiseAXWindow(pid: pid, cgFrame: frame)
        app.activate(options: [])
        let name = (app.localizedName ?? "?").replacingOccurrences(of: "|", with: "_")
        emit("focused pid=\(pid) name=\(name) ax-raised=\(raised)")
    } else {
        let parts = line.split(separator: " ")
        guard parts.count == 3, let u = Double(parts[1]), let v = Double(parts[2]) else { emit("none"); continue }
        let target = String(parts[0])
        let p = resolveCG(target, u, v)
        if
            let w = windowAt(p),
            let pid = w[kCGWindowOwnerPID as String] as? pid_t,
            let wnum = w[kCGWindowNumber as String] as? Int,
            let app = NSRunningApplication(processIdentifier: pid)
        {
            let name = (app.localizedName ?? "?")
                .replacingOccurrences(of: "|", with: "_")
                .replacingOccurrences(of: "\n", with: " ")
            emit("\(pid)|\(name)|\(wnum)")
        } else {
            emit("none")
        }
    }
}
