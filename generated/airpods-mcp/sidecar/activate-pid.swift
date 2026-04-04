import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count == 2, let pid = pid_t(args[1]) else {
    FileHandle.standardError.write("Usage: activate-pid <pid>\n".data(using: .utf8)!)
    exit(1)
}
guard let app = NSRunningApplication(processIdentifier: pid) else {
    FileHandle.standardError.write("no app for pid \(pid)\n".data(using: .utf8)!)
    exit(2)
}
app.activate(options: [.activateIgnoringOtherApps])
print("activated pid=\(pid) (\(app.localizedName ?? "?"))")
