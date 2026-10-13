// Dictation for the desktop composer, on macOS's own speech recognition.
//
// One process per dictation. The sidecar (sidecar/host/dictation.ts) starts it,
// reads JSON lines on stdout, and ends it by writing a line on stdin:
//
//   wgpt-dictate [--locale en-US] [--file speech.aiff]
//
//   stdout  {"type":"state","state":"starting"|"listening"|"finishing"|"idle"}
//           {"type":"partial","text":"…"}   what has been heard so far (replaces the last partial)
//           {"type":"final","text":"…"}     the settled transcript; the process exits next
//           {"type":"error","code":"…","message":"…"}
//   stdin   "stop"    stop listening, deliver what was heard
//           "cancel"  stop and deliver nothing — also what closing stdin means, so
//                     the helper never outlives the sidecar
//
// Audio never leaves the machine: recognition is forced on-device, and when the
// language has no on-device model that is an error, not a silent trip to
// Apple's servers (the app's privacy rule, docs/architecture.md). `--file`
// transcribes an audio file the same way, for checking the build without a mic.
//
// Permissions are the app's: Speech Recognition and Microphone are asked for
// under whichever app started this process, and their wording comes from that
// app's Info.plist (src-tauri/Info.plist).
import AVFoundation
import Foundation
import Speech

/// Stop listening after this long even if nobody asked: a forgotten mic is worse than a cut-off sentence.
let maxListenSeconds = 300.0
/// How long after "stop" to wait for the recognizer's last word before using the last partial.
let settleSeconds = 4.0

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object),
    var line = String(data: data, encoding: .utf8)
  else { return }
  line += "\n"
  FileHandle.standardOutput.write(Data(line.utf8))
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["type": "error", "code": code, "message": message])
  emit(["type": "state", "state": "idle"])
  exit(1)
}

/// WGPT_DICTATE_DEBUG=1: every recognizer result to stderr, for working out what it did.
let debug = ProcessInfo.processInfo.environment["WGPT_DICTATE_DEBUG"] != nil

var localeId = Locale.current.identifier
var filePath: String?
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
  let a = args.removeFirst()
  if a == "--locale", !args.isEmpty { localeId = args.removeFirst() }
  else if a == "--file", !args.isEmpty { filePath = args.removeFirst() }
}

// --- Transcript: what has been heard, which only grows ---
/// The recognizer's transcript is not monotonic. After a pause it can start over (the next
/// partial holds only the new words), and its last result can be shorter or empty. Showing each
/// one as "the text" would erase what the user has already seen, so what was heard is kept:
/// a result that starts over is appended to it, and an empty one changes nothing.
struct Transcript {
  private var committed = ""
  private var current = ""

  var text: String { [committed, current].filter { !$0.isEmpty }.joined(separator: " ") }

  mutating func update(_ new: String) {
    if new.isEmpty { return }
    if startedOver(new) { committed = text }
    current = new
  }

  /// Fewer words than before and a different first word. Revisions keep the beginning and grow
  /// or change the tail, so they are not mistaken for this; a very short transcript is too little
  /// to tell, and is treated as a revision.
  private func startedOver(_ new: String) -> Bool {
    let old = current.split(separator: " "), now = new.split(separator: " ")
    guard old.count >= 3, now.count < old.count else { return false }
    return Transcript.key(old[0]) != Transcript.key(now[0])
  }

  private static func key(_ word: Substring) -> String {
    String(word.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
  }
}
// --- end Transcript ---

final class Dictation {
  private let recognizer: SFSpeechRecognizer
  private let engine = AVAudioEngine()
  private var live: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var transcript = Transcript()
  private var stopping = false
  private var done = false

  init(recognizer: SFSpeechRecognizer) { self.recognizer = recognizer }

  private func request<R: SFSpeechRecognitionRequest>(_ r: R) -> R {
    r.shouldReportPartialResults = true
    r.requiresOnDeviceRecognition = true
    r.taskHint = .dictation
    if #available(macOS 13.0, *) { r.addsPunctuation = true }
    return r
  }

  private func listen(_ r: SFSpeechRecognitionRequest) {
    task = recognizer.recognitionTask(with: r) { [weak self] result, error in
      DispatchQueue.main.async { self?.heard(result, error) }
    }
  }

  func startMicrophone() {
    let r = request(SFSpeechAudioBufferRecognitionRequest())
    live = r
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0 else { fail("no-microphone", "No microphone is available.") }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in r.append(buffer) }
    engine.prepare()
    do { try engine.start() } catch { fail("microphone-failed", "Could not start the microphone: \(error.localizedDescription)") }
    listen(r)
    emit(["type": "state", "state": "listening"])
    DispatchQueue.main.asyncAfter(deadline: .now() + maxListenSeconds) { [weak self] in self?.stop() }
  }

  func transcribe(file: URL) {
    listen(request(SFSpeechURLRecognitionRequest(url: file)))
    emit(["type": "state", "state": "listening"])
  }

  private func heard(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
    if done { return }
    if let result = result {
      let text = result.bestTranscription.formattedString
      if debug { FileHandle.standardError.write(Data("[dictate] \(result.isFinal ? "final" : "partial") \(text.debugDescription)\n".utf8)) }
      transcript.update(text)
      if result.isFinal { return finish(transcript.text) }
      emit(["type": "partial", "text": transcript.text])
    }
    if let error = error {
      if debug { FileHandle.standardError.write(Data("[dictate] error \(error)\n".utf8)) }
      // After "stop" an error is the recognizer giving up on silence ("No speech
      // detected") or being cancelled: deliver what was heard, which may be nothing.
      if stopping { return finish(transcript.text) }
      fail("recognition-failed", Dictation.explain(error, locale: recognizer.locale))
    }
  }

  func stop() {
    if stopping || done { return }
    stopping = true
    emit(["type": "state", "state": "finishing"])
    if engine.isRunning {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }
    live?.endAudio()
    DispatchQueue.main.asyncAfter(deadline: .now() + settleSeconds) { [weak self] in
      guard let self = self else { return }
      self.finish(self.transcript.text)
    }
  }

  func cancel() {
    done = true
    task?.cancel()
    exit(0)
  }

  private func finish(_ text: String) {
    if done { return }
    done = true
    emit(["type": "final", "text": text])
    emit(["type": "state", "state": "idle"])
    exit(0)
  }

  static func explain(_ error: Error, locale: Locale) -> String {
    let base = error.localizedDescription
    // With on-device forced, a missing model surfaces as a generic failure.
    return "\(base) If this is the first use, open System Settings → Keyboard → Dictation and make sure \(locale.identifier) is available on this Mac."
  }
}

func microphoneAllowed(_ then: @escaping (Bool) -> Void) {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: then(true)
  case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { then(ok) } }
  default: then(false)
  }
}

func speechAllowed(_ then: @escaping (Bool) -> Void) {
  switch SFSpeechRecognizer.authorizationStatus() {
  case .authorized: then(true)
  case .notDetermined: SFSpeechRecognizer.requestAuthorization { s in DispatchQueue.main.async { then(s == .authorized) } }
  default: then(false)
  }
}

emit(["type": "state", "state": "starting"])

/// The page sends the browser's language, which can be a region speech recognition lacks ("en-DE",
/// "en"): use the same language where it is offered rather than refuse — preferring one that runs on
/// this Mac (not every region has an on-device model), then the Mac's own region and language order.
func supportedLocale(_ id: String) -> Locale? {
  let wanted = Locale(identifier: id)
  let supported = SFSpeechRecognizer.supportedLocales()
  if supported.contains(wanted) { return wanted }
  let onDevice = { (l: Locale) in SFSpeechRecognizer(locale: l)?.supportsOnDeviceRecognition ?? false }
  let same = supported.filter { $0.languageCode == wanted.languageCode }.sorted { $0.identifier < $1.identifier }
  let usable = same.filter(onDevice)
  let mine = [Locale.current.identifier] + Locale.preferredLanguages
  for pick in mine {
    if let l = (usable.isEmpty ? same : usable).first(where: { $0.identifier == pick }) { return l }
  }
  return usable.first ?? same.first
}

guard let locale = supportedLocale(localeId), let recognizer = SFSpeechRecognizer(locale: locale) else {
  fail("locale-unsupported", "Speech recognition does not support \(localeId).")
}
guard recognizer.supportsOnDeviceRecognition else {
  fail(
    "on-device-unavailable",
    "\(locale.identifier) has no on-device speech model on this Mac, and WorkspaceGPT keeps your voice on the machine. Add it in System Settings → Keyboard → Dictation.")
}
let dictation = Dictation(recognizer: recognizer)

speechAllowed { ok in
  guard ok else {
    fail("speech-denied", "Speech Recognition is turned off for WorkspaceGPT. Allow it in System Settings → Privacy & Security → Speech Recognition.")
  }
  if let path = filePath { return dictation.transcribe(file: URL(fileURLWithPath: path)) }
  microphoneAllowed { ok in
    guard ok else {
      fail("microphone-denied", "The microphone is turned off for WorkspaceGPT. Allow it in System Settings → Privacy & Security → Microphone.")
    }
    dictation.startMicrophone()
  }
}

// Commands from the sidecar. EOF means the sidecar is gone.
Thread.detachNewThread {
  while let line = readLine() {
    switch line.trimmingCharacters(in: .whitespacesAndNewlines) {
    case "stop": DispatchQueue.main.async { dictation.stop() }
    case "cancel": DispatchQueue.main.async { dictation.cancel() }
    default: break
    }
  }
  // A file check has no sidecar behind it, and may be run with stdin closed.
  if filePath == nil { DispatchQueue.main.async { dictation.cancel() } }
}

dispatchMain()
