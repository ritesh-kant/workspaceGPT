// WebKit check for the desktop page, without opening Safari by hand.
//
// Loads a URL in a WKWebView — the engine Safari and the Tauri window on
// macOS use — collects JS errors / console.error, waits, optionally runs a JS
// expression, prints a JSON report and writes a PNG snapshot.
//
//   swift scripts/webkit-probe.swift <url> [--wait 6] [--png out.png] [--width 420] [--height 900] [--appearance light|dark] [--run <js> --run-at 3] [--eval '<js expression>']
//
// The page is the real chat (DESKTOP-TAURI-PLAN.md challenge #4: the webview
// had only ever run in Chromium).
import Cocoa
import WebKit

var url: URL?
var waitSeconds = 6.0
var pngPath: String?
var evalJs: String?
var width = 420.0
var height = 900.0
var appearance: String? = nil
var runJs: String? = nil
var runAt = 3.0
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
  let a = args.removeFirst()
  switch a {
  case "--wait": waitSeconds = Double(args.removeFirst()) ?? 6
  case "--png": pngPath = args.removeFirst()
  case "--eval": evalJs = args.removeFirst()
  case "--width": width = Double(args.removeFirst()) ?? 420
  case "--height": height = Double(args.removeFirst()) ?? 900
  case "--appearance": appearance = args.removeFirst()
  case "--run": runJs = args.removeFirst()
  case "--run-at": runAt = Double(args.removeFirst()) ?? 3
  default: url = URL(string: a)
  }
}
guard let target = url else {
  FileHandle.standardError.write("usage: webkit-probe.swift <url> [--wait s] [--png file] [--eval js]\n".data(using: .utf8)!)
  exit(2)
}

final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
  let web: WKWebView
  let window: NSWindow
  var messages: [String] = []
  var navError: String?

  init(url: URL, width: Double) {
    let cfg = WKWebViewConfiguration()
    let ucc = WKUserContentController()
    let hook = """
    (() => {
      const post = (s) => { try { window.webkit.messageHandlers.probe.postMessage(String(s)); } catch (_) {} };
      window.addEventListener('error', e => post('error: ' + e.message + ' @ ' + e.filename + ':' + e.lineno));
      window.addEventListener('unhandledrejection', e => post('unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason)));
      const ce = console.error.bind(console);
      console.error = (...a) => { post('console.error: ' + a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (_) { return String(x); } }).join(' ')); ce(...a); };
    })();
    """
    ucc.addUserScript(WKUserScript(source: hook, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    cfg.userContentController = ucc
    let frame = NSRect(x: 0, y: 0, width: width, height: height)
    web = WKWebView(frame: frame, configuration: cfg)
    window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = web
    if let a = appearance { window.appearance = NSAppearance(named: a == "dark" ? .darkAqua : .aqua) }
    // A window that is never shown counts as occluded, and WebKit pauses CSS
    // animations there — the chat's fadeIn would stay at opacity 0. Show it,
    // but far off-screen so it never flashes up.
    // Off-screen still reads as occluded, so also turn occlusion detection off
    // (WebKit SPI; fine for a dev probe, never used in the app).
    window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
    window.orderFrontRegardless()
    let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
    if web.responds(to: occlusion) { web.perform(occlusion, with: false) }
    super.init()
    ucc.add(self, name: "probe")
    web.navigationDelegate = self
    web.load(URLRequest(url: url))
  }

  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    messages.append("\(m.body)")
  }
  func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { navError = e.localizedDescription }
  func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { navError = e.localizedDescription }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let probe = Probe(url: target, width: width)

let report = """
JSON.stringify({
  userAgent: navigator.userAgent,
  title: document.title,
  bridge: !!window.__WGPT_BRIDGE__,
  acquireVsCodeApi: typeof window.acquireVsCodeApi,
  banner: (document.querySelector('.wgpt-banner') || {}).textContent || null,
  rootChildren: (document.getElementById('root') || {childElementCount: -1}).childElementCount,
  text: ((document.getElementById('root') || {}).innerText || '').slice(0, 600),
  eval: (() => { try { return \(evalJs ?? "null"); } catch (e) { return 'eval threw: ' + e.message; } })()
})
"""

// --run: drive the page (click something) partway through the wait.
if let js = runJs {
  DispatchQueue.main.asyncAfter(deadline: .now() + runAt) {
    probe.web.evaluateJavaScript(js) { _, error in
      if let e = error { probe.messages.append("run: \(e.localizedDescription)") }
    }
  }
}

DispatchQueue.main.asyncAfter(deadline: .now() + waitSeconds) {
  probe.web.evaluateJavaScript(report) { result, error in
    var out: [String: Any] = ["jsErrors": probe.messages]
    if let n = probe.navError { out["navigationError"] = n }
    if let s = result as? String, let d = s.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: d) { out["page"] = obj }
    if let e = error { out["evaluateError"] = e.localizedDescription }
    let finish = {
      let data = try! JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
      print(String(data: data, encoding: .utf8)!)
      exit(probe.messages.isEmpty && probe.navError == nil ? 0 : 1)
    }
    guard let png = pngPath else { finish(); return }
    probe.web.takeSnapshot(with: nil) { image, _ in
      if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
         let bytes = rep.representation(using: .png, properties: [:]) {
        try? bytes.write(to: URL(fileURLWithPath: png))
        out["png"] = png
      }
      finish()
    }
  }
}
app.run()
