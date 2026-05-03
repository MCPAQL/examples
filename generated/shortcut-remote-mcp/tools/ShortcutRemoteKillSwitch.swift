import AppKit
import Darwin

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var timer: Timer?
    private var keepDead = UserDefaults.standard.bool(forKey: "keepAdapterDead")
    private var lastStatus = "Checking Shortcut Remote MCP..."
    private var lastAction = ""
    private var refreshInFlight = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        if let button = statusItem.button {
            if let image = NSImage(systemSymbolName: "keyboard", accessibilityDescription: "Shortcut Remote") {
                image.isTemplate = true
                button.image = image
            } else {
                button.title = "SR"
            }
            button.toolTip = "Shortcut Remote MCP Kill Switch"
        }

        rebuildMenu()
        configureTimer()
        refreshStatus()
    }

    private func scriptPath() -> String {
        if let path = Bundle.main.path(forResource: "kill-shortcut-remote-mcp", ofType: "sh") {
            return path
        }

        let root = rootPath()
        return "\(root)/tools/kill-shortcut-remote-mcp.sh"
    }

    private func rootPath() -> String {
        if let root = Bundle.main.object(forInfoDictionaryKey: "ShortcutRemoteMCPRoot") as? String {
            return root
        }
        return "/Users/mick/Developer/Organizations/MCPAQL/examples/generated/shortcut-remote-mcp"
    }

    private func runScript(_ arguments: [String]) -> (Int32, String) {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [scriptPath()] + arguments
        process.standardOutput = pipe
        process.standardError = pipe

        var environment = ProcessInfo.processInfo.environment
        environment["SHORTCUT_REMOTE_MCP_ROOT"] = rootPath()
        process.environment = environment

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return (1, "Failed to run kill script: \(error.localizedDescription)")
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        return (process.terminationStatus, output.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func rebuildMenu() {
        let menu = NSMenu()

        let status = NSMenuItem(title: lastStatus, action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)

        if !lastAction.isEmpty {
            let action = NSMenuItem(title: lastAction, action: nil, keyEquivalent: "")
            action.isEnabled = false
            menu.addItem(action)
        }

        menu.addItem(.separator())

        menu.addItem(withTitle: "Stop Adapter Now", action: #selector(stopAdapter), keyEquivalent: "")
        menu.addItem(withTitle: "Stop Adapter + Sidecar", action: #selector(stopAdapterAndSidecar), keyEquivalent: "")

        let keep = menu.addItem(withTitle: "Keep Adapter Dead", action: #selector(toggleKeepDead), keyEquivalent: "")
        keep.state = keepDead ? .on : .off

        menu.addItem(.separator())
        menu.addItem(withTitle: "Open HUD", action: #selector(openHUD), keyEquivalent: "")
        menu.addItem(withTitle: "Refresh Status", action: #selector(refreshFromMenu), keyEquivalent: "r")

        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Kill Switch", action: #selector(quit), keyEquivalent: "q")

        statusItem.menu = menu
    }

    private func configureTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: keepDead ? 2.0 : 5.0, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    private func runAction(_ arguments: [String], workingTitle: String) {
        lastAction = workingTitle
        rebuildMenu()

        DispatchQueue.global(qos: .utility).async {
            let result = self.runScript(arguments)
            let output = result.1.isEmpty ? "Done." : result.1

            DispatchQueue.main.async {
                self.lastAction = output.components(separatedBy: .newlines).last ?? output
                self.rebuildMenu()
                self.refreshStatus()
            }
        }
    }

    private func refreshStatus() {
        guard !refreshInFlight else { return }
        refreshInFlight = true
        let shouldKill = keepDead

        DispatchQueue.global(qos: .utility).async {
            if shouldKill {
                _ = self.runScript(["--quiet"])
            }

            let result = self.runScript(["--status"])
            let status = result.1.components(separatedBy: .newlines).first ?? "Status unavailable"

            DispatchQueue.main.async {
                self.lastStatus = status
                self.refreshInFlight = false
                self.updateButtonTooltip(status)
                self.rebuildMenu()
            }
        }
    }

    private func updateButtonTooltip(_ status: String) {
        statusItem.button?.toolTip = "\(status)\nShortcut Remote MCP Kill Switch"
    }

    @objc private func stopAdapter() {
        runAction([], workingTitle: "Stopping adapter...")
    }

    @objc private func stopAdapterAndSidecar() {
        runAction(["--include-sidecar"], workingTitle: "Stopping adapter and sidecar...")
    }

    @objc private func toggleKeepDead() {
        keepDead.toggle()
        UserDefaults.standard.set(keepDead, forKey: "keepAdapterDead")
        lastAction = keepDead ? "Keep Adapter Dead is on." : "Keep Adapter Dead is off."
        configureTimer()
        rebuildMenu()
        refreshStatus()
    }

    @objc private func openHUD() {
        if let url = URL(string: "http://127.0.0.1:47832/") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func refreshFromMenu() {
        refreshStatus()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
if let bundleID = Bundle.main.bundleIdentifier {
    let currentPID = ProcessInfo.processInfo.processIdentifier
    let alreadyRunning = NSRunningApplication
        .runningApplications(withBundleIdentifier: bundleID)
        .contains { $0.processIdentifier != currentPID }
    if alreadyRunning {
        exit(0)
    }
}
let delegate = AppDelegate()
app.delegate = delegate
app.run()
