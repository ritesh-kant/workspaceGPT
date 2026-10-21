// wgpt-notes: records a call the user said yes to and transcribes it on this Mac, for call
// notes (sidecar/host/callNotes.ts, docs/design/call-notes.md "Capture" and "Transcription").
//
//   wgpt-notes [--pid 5516 ...] [--locale en-IN] [--others-file talk.aiff] [--no-mic]
//
// Two tracks, each its own recognizer, so the speaker labels come for free:
//   "you"     the microphone (AVAudioEngine input)
//   "others"  the call app's own audio output: a Core Audio process tap on the --pid processes
//             (the ones call detection saw holding mic + output), macOS 14.2+. Without a pid, or
//             when none of them can be tapped, every app's output except our own.
//
//   stdout  {"type":"state","state":"starting"|"recording"|"finishing"}
//           {"type":"segment","speaker":"you"|"others","at":12.4,"text":"…"}   at = seconds since start
//           {"type":"warning","code":"…","message":"…"}   one track could not start; the other goes on
//           {"type":"error","code":"…","message":"…"}     nothing can be recorded; the process exits next
//           {"type":"done"}                               every segment has been printed; exits next
//   stdin   "stop"  stop recording, transcribe what is left, print done. Closing stdin means the same,
//                   so the helper never outlives the sidecar.
//
// Nothing is written to disk and nothing leaves the machine: audio goes straight from Core Audio to
// the on-device recognizer (forced on-device, as dictation is), and only text is printed. The
// sidecar writes the note. `--others-file` feeds an audio file as the "others" track, for checking
// the build without a call.
//
// Long audio: one recognition request per segment. A segment ends at a pause once it is 15 s long,
// or at 50 s regardless, and the next one starts on the very next buffer, so nothing is dropped.
import AVFoundation
import CoreAudio
import Foundation
import Speech

let minSegmentSeconds = 15.0
let maxSegmentSeconds = 50.0
/// Quiet for this long ends a segment that is long enough.
let pauseSeconds = 0.7
/// Below this RMS a buffer counts as quiet (about -46 dBFS).
let quietLevel: Float = 0.005
/// After endAudio, how long to wait for the recognizer's final result before using its last partial.
let settleSeconds = 8.0
let sampleRate = 16_000.0

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  FileHandle.standardOutput.write(Data(line.utf8))
}

func fail(_ code: String, _ message: String) -> Never {
  emit(["type": "error", "code": code, "message": message])
  exit(1)
}

func warn(_ code: String, _ message: String) { emit(["type": "warning", "code": code, "message": message]) }

/// WGPT_NOTES_DEBUG=1: every recognizer result and segment boundary to stderr.
let debug = ProcessInfo.processInfo.environment["WGPT_NOTES_DEBUG"] != nil
func trace(_ text: @autoclosure () -> String) {
  if debug { FileHandle.standardError.write(Data("[notes] \(text())\n".utf8)) }
}

var pids: [pid_t] = []
var localeId: String?
var othersFile: String?
var useMic = true
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
  let a = args.removeFirst()
  if a == "--pid", !args.isEmpty, let p = pid_t(args.removeFirst()) { pids.append(p) }
  else if a == "--locale", !args.isEmpty { localeId = args.removeFirst() }
  else if a == "--others-file", !args.isEmpty { othersFile = args.removeFirst() }
  else if a == "--no-mic" { useMic = false }
}

/// When recording began (reset then, so permission prompts don't shift every timestamp).
var started = Date()
func now() -> Double { Date().timeIntervalSince(started) }

// --- Transcript: what has been heard, which only grows (a copy of wgpt-dictate.swift's) ---
/// The recognizer's transcript is not monotonic. After a pause it can start over (the next
/// partial holds only the new words), and its last result can be shorter or empty. So what was
/// heard is kept: a result that starts over is appended to it, and an empty one changes nothing.
struct Transcript {
  private var committed = ""
  private var current = ""

  var text: String { [committed, current].filter { !$0.isEmpty }.joined(separator: " ") }

  mutating func update(_ new: String) {
    if new.isEmpty { return }
    if startedOver(new) { committed = text }
    current = new
  }

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

/// One recognition request: a stretch of one track, printed as one segment when it settles.
final class Segment {
  let speaker: String
  let request = SFSpeechAudioBufferRecognitionRequest()
  var task: SFSpeechRecognitionTask?
  var transcript = Transcript()
  let opened = now()
  /// When speech was first heard in it: the segment's timestamp.
  var at: Double?
  var quietSince: Double?
  private(set) var printed = false
  var onPrinted: (() -> Void)?

  init(speaker: String, recognizer: SFSpeechRecognizer) {
    self.speaker = speaker
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    request.taskHint = .dictation
    if #available(macOS 13.0, *) { request.addsPunctuation = true }
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      DispatchQueue.main.async { self?.heard(result, error) }
    }
  }

  private func heard(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
    if printed { return }
    if let result = result {
      transcript.update(result.bestTranscription.formattedString)
      trace("\(speaker) \(result.isFinal ? "final" : "partial") \(transcript.text.debugDescription)")
      if result.isFinal { return print() }
    }
    if let error = error {
      // Usually "no speech detected" for a quiet stretch; either way, keep what was heard.
      trace("\(speaker) error \(error)")
      print()
    }
  }

  func end() {
    request.endAudio()
    DispatchQueue.main.asyncAfter(deadline: .now() + settleSeconds) { [weak self] in self?.print() }
  }

  func print() {
    if printed { return }
    printed = true
    task?.cancel()
    let text = transcript.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty {
      emit(["type": "segment", "speaker": speaker, "at": ((at ?? opened) * 10).rounded() / 10, "text": text])
    }
    onPrinted?()
  }
}

/// One speaker's audio: converts to 16 kHz mono and cuts it into segments at pauses.
final class Track {
  let speaker: String
  let recognizer: SFSpeechRecognizer
  private var segment: Segment?
  /// Segments that have ended but not yet printed: held here, or they would be freed before their last result.
  private var ending: [Segment] = []
  private var converter: AVAudioConverter?
  private let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
  private(set) var open = 0
  private var stopped = false
  var onIdle: (() -> Void)?

  init(speaker: String, recognizer: SFSpeechRecognizer) {
    self.speaker = speaker
    self.recognizer = recognizer
  }

  /// Called on the main queue with audio in the source's own format.
  func append(_ buffer: AVAudioPCMBuffer) {
    if stopped { return }
    guard let converted = convert(buffer) else { return }
    let seg = current()
    seg.request.append(converted)
    let t = now()
    if level(converted) < quietLevel {
      seg.quietSince = seg.quietSince ?? t
    } else {
      seg.quietSince = nil
      if seg.at == nil { seg.at = t }
    }
    let length = t - seg.opened
    let paused = seg.quietSince.map { t - $0 >= pauseSeconds } ?? false
    if (length >= minSegmentSeconds && paused) || length >= maxSegmentSeconds { rotate() }
  }

  private func current() -> Segment {
    if let s = segment { return s }
    let s = Segment(speaker: speaker, recognizer: recognizer)
    open += 1
    s.onPrinted = { [weak self, unowned s] in
      guard let self = self else { return }
      self.ending.removeAll { $0 === s }
      self.open -= 1
      if self.stopped && self.open == 0 { self.onIdle?() }
    }
    segment = s
    trace("\(speaker) segment opened")
    return s
  }

  /// Ends the current segment; the next buffer opens a new one.
  private func rotate() {
    guard let s = segment else { return }
    segment = nil
    ending.append(s)
    trace("\(speaker) segment ended after \(Int(now() - s.opened)) s")
    s.end()
  }

  func stop() {
    if stopped { return }
    stopped = true
    rotate()
    if open == 0 { onIdle?() }
  }

  private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    if converter == nil || converter!.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: mono)
    }
    guard let converter = converter else { return nil }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * sampleRate / buffer.format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: capacity) else { return nil }
    var fed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    return error == nil && out.frameLength > 0 ? out : nil
  }

  private func level(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) { sum += data[i] * data[i] }
    return (sum / Float(buffer.frameLength)).squareRoot()
  }
}

// MARK: - The "others" track: a Core Audio process tap

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func processObject(_ pid: pid_t) -> AudioObjectID? {
  var addr = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
  var qualifier = pid
  var object = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &addr, UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &object)
  return status == noErr && object != kAudioObjectUnknown ? object : nil
}

func defaultOutputUID() -> String? {
  var addr = address(kAudioHardwarePropertyDefaultSystemOutputDevice)
  var device = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device) == noErr else { return nil }
  var uidAddr = address(kAudioDevicePropertyDeviceUID)
  var uid: Unmanaged<CFString>?
  size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(device, &uidAddr, 0, nil, &size, &uid) == noErr else { return nil }
  return uid?.takeRetainedValue() as String?
}

@available(macOS 14.2, *)
final class ProcessTap {
  private var tap = AudioObjectID(kAudioObjectUnknown)
  private var aggregate = AudioObjectID(kAudioObjectUnknown)
  private var ioProc: AudioDeviceIOProcID?
  private let queue = DispatchQueue(label: "wgpt-notes.tap")

  /// nil when it started; otherwise why not.
  func start(pids: [pid_t], deliver: @escaping (AVAudioPCMBuffer) -> Void) -> String? {
    let objects = pids.compactMap(processObject)
    let description: CATapDescription
    if objects.isEmpty {
      description = CATapDescription(stereoGlobalTapButExcludeProcesses: processObject(getpid()).map { [$0] } ?? [])
      trace("tap: every app's output (no call process to tap)")
    } else {
      description = CATapDescription(stereoMixdownOfProcesses: objects)
      trace("tap: processes \(pids)")
    }
    description.uuid = UUID()
    description.muteBehavior = .unmuted
    description.isPrivate = true
    var status = AudioHardwareCreateProcessTap(description, &tap)
    guard status == noErr else { return "Could not tap the call's audio (\(status))." }

    guard let outputUID = defaultOutputUID() else { return "No audio output device." }
    let aggregateDescription: [String: Any] = [
      kAudioAggregateDeviceNameKey: "WorkspaceGPT call notes",
      kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey: outputUID,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
    ]
    status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregate)
    guard status == noErr else { return "Could not set up the call's audio (\(status))." }

    var formatAddr = address(kAudioTapPropertyFormat)
    var asbd = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    status = AudioObjectGetPropertyData(tap, &formatAddr, 0, nil, &size, &asbd)
    guard status == noErr, let format = AVAudioFormat(streamDescription: &asbd) else { return "Could not read the call's audio format (\(status))." }
    trace("tap format \(format)")

    var calls = 0
    status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, queue) { _, input, _, _, _ in
      calls += 1
      if calls == 1 || calls % 500 == 0 { trace("tap: \(calls) buffers, \(input.pointee.mNumberBuffers) in the list, \(input.pointee.mBuffers.mDataByteSize) bytes") }
      guard let raw = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return trace("tap: buffer does not match the format") }
      // The block's memory is only valid during the call: copy before handing it on.
      guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: raw.frameLength) else { return }
      copy.frameLength = raw.frameLength
      let src = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: raw.audioBufferList))
      let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
      for i in 0..<min(src.count, dst.count) {
        if let s = src[i].mData, let d = dst[i].mData { memcpy(d, s, Int(min(src[i].mDataByteSize, dst[i].mDataByteSize))) }
      }
      DispatchQueue.main.async { deliver(copy) }
    }
    guard status == noErr else { return "Could not read the call's audio (\(status))." }
    status = AudioDeviceStart(aggregate, ioProc)
    guard status == noErr else { return "Could not start reading the call's audio (\(status))." }
    return nil
  }

  func stop() {
    if let proc = ioProc {
      AudioDeviceStop(aggregate, proc)
      AudioDeviceDestroyIOProcID(aggregate, proc)
      ioProc = nil
    }
    if aggregate != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregate); aggregate = AudioObjectID(kAudioObjectUnknown) }
    if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap); tap = AudioObjectID(kAudioObjectUnknown) }
  }
}

// MARK: - Recording

final class Recorder {
  private let you: Track
  private let others: Track
  private let engine = AVAudioEngine()
  private var tapStop: (() -> Void)?
  private var stopping = false
  private var idle = 0

  init(recognizer: SFSpeechRecognizer) {
    you = Track(speaker: "you", recognizer: recognizer)
    others = Track(speaker: "others", recognizer: recognizer)
    you.onIdle = { [weak self] in self?.trackIdle() }
    others.onIdle = { [weak self] in self?.trackIdle() }
  }

  /// Starts whatever can start; fails only when neither track can.
  func start(mic: Bool) {
    started = Date()
    var running = 0
    if mic {
      if let why = startMicrophone() { warn("microphone-unavailable", why) } else { running += 1 }
    }
    if let path = othersFile {
      startFile(URL(fileURLWithPath: path))
      running += 1
    } else if #available(macOS 14.2, *) {
      let tap = ProcessTap()
      if let why = tap.start(pids: pids, deliver: { [weak self] in self?.others.append($0) }) {
        tap.stop()
        warn("call-audio-unavailable", "\(why) Only your side of the call will be transcribed.")
      } else {
        tapStop = { tap.stop() }
        running += 1
      }
    } else {
      warn("call-audio-unavailable", "Hearing the other side of the call needs macOS 14.2 or later. Only your side will be transcribed.")
    }
    if running == 0 { fail("nothing-to-record", "Neither the microphone nor the call's audio could be recorded.") }
    emit(["type": "state", "state": "recording"])
  }

  private func startMicrophone() -> String? {
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0 else { return "No microphone is available." }
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
      DispatchQueue.main.async { self?.you.append(buffer) }
    }
    engine.prepare()
    do { try engine.start() } catch { return "Could not start the microphone: \(error.localizedDescription)" }
    return nil
  }

  /// --others-file: the file's audio, fed at its own pace as if it were playing.
  private func startFile(_ url: URL) {
    guard let file = try? AVAudioFile(forReading: url) else { fail("file-unreadable", "Could not read \(url.path).") }
    let chunk = AVAudioFrameCount(file.processingFormat.sampleRate / 10)
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now(), repeating: 0.1)
    timer.setEventHandler { [weak self] in
      guard let self = self, let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk) else { return }
      if (try? file.read(into: buffer, frameCount: chunk)) == nil || buffer.frameLength == 0 {
        // Past the end: silence, so the track keeps time like a quiet call.
        buffer.frameLength = chunk
        if let data = buffer.floatChannelData { for c in 0..<Int(buffer.format.channelCount) { memset(data[c], 0, Int(chunk) * 4) } }
      }
      self.others.append(buffer)
    }
    timer.resume()
    tapStop = { timer.cancel() }
  }

  func stop() {
    if stopping { return }
    stopping = true
    emit(["type": "state", "state": "finishing"])
    if engine.isRunning {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }
    tapStop?()
    tapStop = nil
    you.stop()
    others.stop()
    // Last resort: a recognizer that never settles must not keep the note open.
    DispatchQueue.main.asyncAfter(deadline: .now() + settleSeconds + 4) { Recorder.finish() }
  }

  private func trackIdle() {
    idle += 1
    if idle == 2 { Recorder.finish() }
  }

  static func finish() {
    emit(["type": "done"])
    exit(0)
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

/// en-IN when this Mac can run it on-device (Indian English names and Hinglish words come out
/// closer), else en-US, else the Mac's own language: whichever runs on-device first.
func pickRecognizer() -> SFSpeechRecognizer? {
  let wanted = [localeId, "en-IN", "en-US", Locale.current.identifier].compactMap { $0 }
  for id in wanted {
    if let r = SFSpeechRecognizer(locale: Locale(identifier: id)), r.supportsOnDeviceRecognition { return r }
  }
  return nil
}

emit(["type": "state", "state": "starting"])

guard let recognizer = pickRecognizer() else {
  fail(
    "on-device-unavailable",
    "This Mac has no on-device speech model for English, and WorkspaceGPT keeps calls on the machine. Add one in System Settings → Keyboard → Dictation.")
}
trace("recognizer \(recognizer.locale.identifier)")
let recorder = Recorder(recognizer: recognizer)

speechAllowed { ok in
  guard ok else {
    fail("speech-denied", "Speech Recognition is turned off for WorkspaceGPT. Allow it in System Settings → Privacy & Security → Speech Recognition.")
  }
  guard useMic else { return recorder.start(mic: false) }
  microphoneAllowed { ok in
    if !ok { warn("microphone-denied", "The microphone is turned off for WorkspaceGPT, so your side of the call is not transcribed. Allow it in System Settings → Privacy & Security → Microphone.") }
    recorder.start(mic: ok)
  }
}

// Commands from the sidecar. EOF means the sidecar is gone: stop the same way, so what was heard is printed.
Thread.detachNewThread {
  while let line = readLine() {
    if line.trimmingCharacters(in: .whitespacesAndNewlines) == "stop" { DispatchQueue.main.async { recorder.stop() } }
  }
  DispatchQueue.main.async { recorder.stop() }
}

dispatchMain()
