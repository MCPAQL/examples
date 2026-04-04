import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("Usage: focus-on-display <main|left>\n".data(using: .utf8)!)
    exit(1)
}
let target = args[1]

let main = NSScreen.main!
let targetScreen: NSScreen
switch target {
case "main": targetScreen = main
case "left": targetScreen = NSScreen.screens.first { $0 != main } ?? main
default:
    FileHandle.standardError.write("unknown target: \(target)\n".data(using: .utf8)!)
    exit(1)
}

let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? main
let primaryH = primary.frame.height
let f = targetScreen.frame
let cgFrame = CGRect(x: f.origin.x,
                     y: primaryH - f.origin.y - f.height,
                     width: f.width, height: f.height)

let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windows = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write("CGWindowListCopyWindowInfo returned nil\n".data(using: .utf8)!)
    exit(2)
}

for w in windows {
    guard
        let bounds = w[kCGWindowBounds as String] as? [String: CGFloat],
        let pid = w[kCGWindowOwnerPID as String] as? pid_t,
        let layer = w[kCGWindowLayer as String] as? Int,
        layer == 0
    else { continue }
    let rect = CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0,
                      width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0)
    let center = CGPoint(x: rect.midX, y: rect.midY)
    guard cgFrame.contains(center) else { continue }
    if rect.width < 80 || rect.height < 60 { continue }
    guard let app = NSRunningApplication(processIdentifier: pid) else { continue }
    if app.activationPolicy != .regular { continue }
    let name = app.localizedName ?? "?"
    let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
    app.activate(options: [.activateIgnoringOtherApps])
    print("focused: \(name) (\(owner)) pid=\(pid) on=\(target)")
    exit(0)
}

print("no window found on \(target)")
exit(0)
