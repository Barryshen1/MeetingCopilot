// mc-window-shot — captures the window the user is working in for
// MeetingCopilot's 📷 screenshot questions.
//
// "The window the user is working in" = the frontmost normal window of any app
// other than MeetingCopilot (front-to-back order from CGWindowList). Clicking
// MeetingCopilot's 📷 activates MeetingCopilot, but its own windows live on a
// higher window level, so the window the user was just using (Chrome, a PDF
// viewer, an IDE, …) is still the first normal-layer window.
//
// Only that window's pixels are captured (ScreenCaptureKit, a single
// desktop-independent window), so anything floating over it — MeetingCopilot
// included — never appears in the image and nothing has to be hidden first.
//
// usage:  mc-window-shot --out <file.png> [--exclude-pid <pid>]… [--exclude-bundle <id>]… [--max-edge <px>]
// stdout: one JSON line
//   {"ok":true,"windowId":N,"app":"…","title":"…","width":W,"height":H}
//   {"ok":false,"code":"permission"|"no-window"|"capture"|"usage","message":"…"}
//
// Needs Screen Recording permission, which macOS attributes to the app that
// spawned this helper (MeetingCopilot).
//
// Build: swiftc -O -o mc-window-shot main.swift   (see tools/build-mac-audio.mjs)

import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

func emit(_ dict: [String: Any]) -> Never {
  if let data = try? JSONSerialization.data(withJSONObject: dict, options: []) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
  }
  exit((dict["ok"] as? Bool) == true ? 0 : 1)
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["ok": false, "code": code, "message": message])
}

// ---- arguments ----
var outPath: String?
var excludePids = Set<pid_t>()
var excludeBundles = Set<String>()
var maxEdge = 2400
var argv = CommandLine.arguments.dropFirst().makeIterator()
while let arg = argv.next() {
  switch arg {
  case "--out": outPath = argv.next()
  case "--exclude-pid": if let v = argv.next(), let p = pid_t(v) { excludePids.insert(p) }
  case "--exclude-bundle": if let v = argv.next() { excludeBundles.insert(v) }
  case "--max-edge": if let v = argv.next(), let n = Int(v), n >= 256 { maxEdge = n }
  case "--version": print("mc-window-shot 1"); exit(0)
  default: fail("usage", "unknown argument \(arg)")
  }
}
guard let outPath else { fail("usage", "--out <file.png> is required") }

/// apps whose normal-layer windows are never "the window the user is working in"
let systemOwners: Set<String> = [
  "Window Server", "Dock", "Control Center", "Notification Center", "SystemUIServer",
  "WindowManager", "Spotlight", "loginwindow",
]

struct Target {
  let id: CGWindowID
  let app: String
  let title: String
}

func pickTarget() -> Target? {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
  for w in list {  // front to back
    guard (w[kCGWindowLayer as String] as? Int) == 0,
          let pid = w[kCGWindowOwnerPID as String] as? pid_t,
          let number = w[kCGWindowNumber as String] as? CGWindowID,
          let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
    else { continue }
    if excludePids.contains(pid) { continue }
    if let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier, excludeBundles.contains(bundle) {
      continue
    }
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    if systemOwners.contains(owner) { continue }
    if (w[kCGWindowAlpha as String] as? Double ?? 1) < 0.05 { continue }
    if bounds.width < 120 || bounds.height < 80 { continue }  // tooltips, popovers, palettes
    return Target(id: number, app: owner, title: w[kCGWindowName as String] as? String ?? "")
  }
  return nil
}

@available(macOS 14.0, *)
func run() async -> Never {
  // Without permission ScreenCaptureKit returns nothing useful (and older APIs
  // silently return only the wallpaper): report it so the app can say so.
  if !CGPreflightScreenCaptureAccess() {
    fail("permission", "Screen Recording permission is not granted to MeetingCopilot")
  }
  guard let target = pickTarget() else { fail("no-window", "no app window is open on screen") }

  let content: SCShareableContent
  do {
    content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
  } catch {
    let ns = error as NSError
    if ns.domain == SCStreamErrorDomain && ns.code == SCStreamError.Code.userDeclined.rawValue {
      fail("permission", "Screen Recording permission was declined")
    }
    fail("capture", "could not list windows: \(error.localizedDescription)")
  }
  guard let window = content.windows.first(where: { $0.windowID == target.id }) else {
    fail("capture", "the window closed before it could be captured")
  }

  let filter = SCContentFilter(desktopIndependentWindow: window)
  let scale = CGFloat(filter.pointPixelScale)
  var width = Double(filter.contentRect.width * scale)
  var height = Double(filter.contentRect.height * scale)
  let longEdge = max(width, height)
  if longEdge > Double(maxEdge) {
    let ratio = Double(maxEdge) / longEdge
    width *= ratio
    height *= ratio
  }
  let config = SCStreamConfiguration()
  config.width = max(1, Int(width.rounded()))
  config.height = max(1, Int(height.rounded()))
  config.showsCursor = false
  config.ignoreShadowsSingleWindow = true

  let image: CGImage
  do {
    image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
  } catch {
    fail("capture", "could not capture the window: \(error.localizedDescription)")
  }

  let url = URL(fileURLWithPath: outPath)
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fail("capture", "could not create \(outPath)")
  }
  CGImageDestinationAddImage(dest, image, nil)
  guard CGImageDestinationFinalize(dest) else { fail("capture", "could not write \(outPath)") }

  emit([
    "ok": true,
    "windowId": Int(target.id),
    "app": target.app,
    "title": target.title,
    "width": image.width,
    "height": image.height,
  ])
}

if #available(macOS 14.0, *) {
  Task { await run() }
  dispatchMain()
} else {
  fail("capture", "window capture needs macOS 14 or newer")
}
