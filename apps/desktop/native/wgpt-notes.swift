// wgpt-notes: records a call the user said yes to and transcribes it on this Mac with
// whisper.cpp, for call notes (sidecar/host/callRecorder.ts, docs/design/call-notes.md).
//
//   wgpt-notes --model ggml-small-q5_1.bin [--pid 5516 ...] [--language en] [--no-mic]
//              [--others-file talk.wav] [--you-file me.wav]
//
// Two tracks, so the speaker labels come for free:
//   "you"     the microphone (AVAudioEngine input)
//   "others"  the call app's own audio output: a Core Audio process tap on the --pid processes
//             (the ones call detection saw holding mic + output), macOS 14.2+. Without a pid, or
//             when none of them can be tapped, every app's output except our own.
//
//   stdout  {"type":"state","state":"starting"|"recording"|"finishing"}
//           {"type":"segment","speaker":"you"|"others","at":12.4,"end":15.1,"text":"…"}  seconds since start
//           {"type":"warning","code":"…","message":"…"}   one track could not start; the other goes on
//           {"type":"error","code":"…","message":"…"}     nothing can be recorded; the process exits next
//           {"type":"done"}                               every segment has been printed; exits next
//   stdin   "stop"  stop recording, transcribe what is left, print done. Closing stdin means the same,
//                   so the helper never outlives the sidecar.
//
// Nothing is written to disk and nothing leaves the machine: audio is held in memory until its
// chunk is transcribed, then dropped; only text is printed. The sidecar writes the note.
// `--others-file` / `--you-file` feed audio files as a track, for checking the build without a call.
//
// Chunks: a track's audio is cut at a pause once it is 8 s long, or at 28 s regardless (Whisper
// hears 30 s at a time). A chunk with almost no speech in it is not transcribed at all: Whisper
// invents words ("Thank you.") in silence.
import AVFoundation
import CoreAudio
import Foundation
import whisper

let minChunkSeconds = 8.0
let maxChunkSeconds = 28.0
/// Quiet for this long ends a chunk that is long enough.
let pauseSeconds = 0.6
/// Below this RMS a buffer counts as quiet (about -46 dBFS).
let quietLevel: Float = 0.005
/// A chunk with less speech than this is dropped untranscribed.
let minVoicedSeconds = 0.5
/// Segments Whisper itself thinks are probably not speech.
let noSpeechThreshold: Float = 0.6
let sampleRate = 16_000.0
/// After "stop", how long the last chunks may take to transcribe before the helper gives up on them.
let drainSeconds = 120.0
/// Primes the decoder for this kind of talk: Indian English with Hindi words kept in Roman script,
/// and the tools people name in calls.
let basePrompt =
  "Team call in Indian English, some Hinglish, written in Roman script: haan, theek hai, acha, matlab, yaar, chalo. Jira, Confluence, Azure DevOps, PR, release, sprint, standup."

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  FileHandle.standardOutput.write(Data(line.utf8))
}

/// _exit, not exit: exit's teardown frees whisper.cpp's Metal state from under a decode and aborts.
/// Every line was already written straight to the pipe (FileHandle), so nothing is lost.
func fail(_ code: String, _ message: String) -> Never {
  emit(["type": "error", "code": code, "message": message])
  _exit(1)
}

func warn(_ code: String, _ message: String) { emit(["type": "warning", "code": code, "message": message]) }

/// WGPT_NOTES_DEBUG=1: chunk boundaries, timings and whisper.cpp's own log to stderr.
let debug = ProcessInfo.processInfo.environment["WGPT_NOTES_DEBUG"] != nil
func trace(_ text: @autoclosure () -> String) {
  if debug { FileHandle.standardError.write(Data("[notes] \(text())\n".utf8)) }
}

var pids: [pid_t] = []
var modelPath: String?
var language = "en"
var othersFile: String?
var youFile: String?
var useMic = true
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
  let a = args.removeFirst()
  if a == "--pid", !args.isEmpty, let p = pid_t(args.removeFirst()) { pids.append(p) }
  else if a == "--model", !args.isEmpty { modelPath = args.removeFirst() }
  else if a == "--language", !args.isEmpty { language = args.removeFirst() }
  else if a == "--others-file", !args.isEmpty { othersFile = args.removeFirst() }
  else if a == "--you-file", !args.isEmpty { youFile = args.removeFirst() }
  else if a == "--no-mic" { useMic = false }
}

/// When recording began (reset then, so permission prompts don't shift every timestamp).
var started = Date()
func now() -> Double { Date().timeIntervalSince(started) }

// MARK: - Whisper

/// One model, one decode at a time (a whisper context is not safe to share across threads),
/// so both tracks' chunks queue here in the order they were cut.
final class Transcriber {
  private let ctx: OpaquePointer
  private let queue = DispatchQueue(label: "wgpt-notes.whisper")
  private let languageC: UnsafeMutablePointer<CChar>
  private let threads = Int32(max(1, min(4, ProcessInfo.processInfo.activeProcessorCount - 2)))
  /// Chunks queued or decoding. Read and written on the main queue.
  private(set) var pending = 0
  var onIdle: (() -> Void)?

  init?(model: String) {
    if !debug { whisper_log_set({ _, _, _ in }, nil) }
    var params = whisper_context_default_params()
    params.use_gpu = true
    guard let ctx = whisper_init_from_file_with_params(model, params) else { return nil }
    self.ctx = ctx
    languageC = strdup(language)
  }

  /// Called on the main queue; `done` comes back on the main queue with the chunk's segments.
  func transcribe(_ samples: [Float], speaker: String, at: Double, context: String, done: @escaping ([(at: Double, end: Double, text: String)]) -> Void) {
    pending += 1
    let prompt = strdup(context.isEmpty ? basePrompt : "\(basePrompt) \(context)")
    queue.async { [self] in
      let t0 = Date()
      var p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
      p.n_threads = threads
      p.language = UnsafePointer(languageC)
      p.initial_prompt = UnsafePointer(prompt)
      p.no_context = true
      p.suppress_blank = true
      p.suppress_nst = true
      p.no_speech_thold = noSpeechThreshold
      p.print_progress = false
      p.print_realtime = false
      p.print_timestamps = false
      p.print_special = false
      var segments: [(at: Double, end: Double, text: String)] = []
      let rc = samples.withUnsafeBufferPointer { whisper_full(ctx, p, $0.baseAddress, Int32($0.count)) }
      free(prompt)
      if rc == 0 {
        for i in 0..<whisper_full_n_segments(ctx) {
          guard let raw = whisper_full_get_segment_text(ctx, i) else { continue }
          let text = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
          let noSpeech = whisper_full_get_segment_no_speech_prob(ctx, i)
          trace("  \(speaker) no_speech \(String(format: "%.2f", noSpeech)): \(text)")
          if noSpeech > noSpeechThreshold { continue }
          if Transcriber.isNoise(text) { continue }
          // t0/t1 are in hundredths of a second from the chunk's start.
          let s = at + Double(whisper_full_get_segment_t0(ctx, i)) / 100
          let e = at + Double(whisper_full_get_segment_t1(ctx, i)) / 100
          segments.append((at: s, end: e, text: text))
        }
      }
      trace("\(speaker) chunk at \(Int(at)) s, \(samples.count / Int(sampleRate)) s of audio, decoded in \(String(format: "%.1f", Date().timeIntervalSince(t0))) s: \(segments.count) segments\(rc == 0 ? "" : " (whisper_full failed: \(rc))")")
      DispatchQueue.main.async {
        done(segments)
        self.pending -= 1
        if self.pending == 0 { self.onIdle?() }
      }
    }
  }

  /// Not words: "[BLANK_AUDIO]", "(music)", "*laughs*", a lone "-" or "…".
  static func isNoise(_ text: String) -> Bool {
    let t = text.trimmingCharacters(in: CharacterSet(charactersIn: " .,-…♪"))
    if t.isEmpty { return true }
    if let first = t.first, let last = t.last, "[(*".contains(first), "])*".contains(last) { return true }
    return false
  }
}

// MARK: - A track: one speaker's audio, cut into chunks at pauses

final class Track {
  let speaker: String
  private let transcriber: Transcriber
  private var converter: AVAudioConverter?
  private let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
  private var samples: [Float] = []
  /// Where this track's clock starts, in seconds since recording began (its first buffer).
  private var origin: Double?
  /// Samples already cut into chunks: the track's own clock, so timestamps don't drift with the queue.
  private var consumed = 0
  private var voiced = 0.0
  private var quietSince: Double?
  /// The track's last words, carried into the next chunk's prompt so names and topics stay spelled the same.
  private var lastText = ""
  private var stopped = false

  init(speaker: String, transcriber: Transcriber) {
    self.speaker = speaker
    self.transcriber = transcriber
  }

  /// Called on the main queue with audio in the source's own format.
  func append(_ buffer: AVAudioPCMBuffer) {
    if stopped { return }
    guard let converted = convert(buffer), let data = converted.floatChannelData?[0] else { return }
    if origin == nil { origin = now() }
    let n = Int(converted.frameLength)
    samples.append(contentsOf: UnsafeBufferPointer(start: data, count: n))
    let length = Double(samples.count) / sampleRate
    let t = length
    if level(data, n) < quietLevel {
      quietSince = quietSince ?? t
    } else {
      quietSince = nil
      voiced += Double(n) / sampleRate
    }
    let paused = quietSince.map { t - $0 >= pauseSeconds } ?? false
    if (length >= minChunkSeconds && paused) || length >= maxChunkSeconds { cut() }
  }

  private func cut() {
    let chunk = samples
    let at = (origin ?? 0) + Double(consumed) / sampleRate
    consumed += chunk.count
    samples.removeAll(keepingCapacity: true)
    let speech = voiced
    voiced = 0
    quietSince = nil
    guard speech >= minVoicedSeconds else {
      if !chunk.isEmpty { trace("\(speaker) chunk at \(Int(at)) s: \(String(format: "%.1f", speech)) s of speech, skipped") }
      return
    }
    transcriber.transcribe(chunk, speaker: speaker, at: at, context: lastText) { [weak self] segments in
      guard let self = self else { return }
      for s in segments {
        emit(["type": "segment", "speaker": self.speaker, "at": (s.at * 10).rounded() / 10, "end": (s.end * 10).rounded() / 10, "text": s.text])
      }
      if let last = segments.last?.text { self.lastText = String(last.suffix(200)) }
    }
  }

  /// Stops taking audio and sends what is left.
  func stop() {
    if stopped { return }
    cut()
    stopped = true
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

  private func level(_ data: UnsafePointer<Float>, _ n: Int) -> Float {
    guard n > 0 else { return 0 }
    var sum: Float = 0
    for i in 0..<n { sum += data[i] * data[i] }
    return (sum / Float(n)).squareRoot()
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
  private let transcriber: Transcriber
  private let you: Track
  private let others: Track
  private let engine = AVAudioEngine()
  private var sourceStops: [() -> Void] = []
  private var stopping = false

  init(transcriber: Transcriber) {
    self.transcriber = transcriber
    you = Track(speaker: "you", transcriber: transcriber)
    others = Track(speaker: "others", transcriber: transcriber)
  }

  /// Held while recording: a call is the user's own work, so macOS must not nap this process
  /// (late audio, late chunks) or sleep the Mac mid-call.
  private var activity: NSObjectProtocol?

  /// Starts whatever can start; fails only when neither track can.
  func start(mic: Bool) {
    started = Date()
    activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "Taking call notes")
    var running = 0
    if let path = youFile {
      startFile(URL(fileURLWithPath: path), into: you)
      running += 1
    } else if mic {
      if let why = startMicrophone() { warn("microphone-unavailable", why) } else { running += 1 }
    }
    if let path = othersFile {
      startFile(URL(fileURLWithPath: path), into: others)
      running += 1
    } else if #available(macOS 14.2, *) {
      let tap = ProcessTap()
      if let why = tap.start(pids: pids, deliver: { [weak self] in self?.others.append($0) }) {
        tap.stop()
        warn("call-audio-unavailable", "\(why) Only your side of the call will be transcribed.")
      } else {
        sourceStops.append { tap.stop() }
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
    sourceStops.append { [engine] in
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }
    return nil
  }

  /// --others-file / --you-file: the file's audio, fed at its own pace as if it were playing.
  private func startFile(_ url: URL, into track: Track) {
    guard let file = try? AVAudioFile(forReading: url) else { fail("file-unreadable", "Could not read \(url.path).") }
    let rate = file.processingFormat.sampleRate
    let begun = Date()
    var fed = 0.0
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now(), repeating: 0.1)
    timer.setEventHandler {
      // By the clock, not per tick: a late tick feeds more, so the file plays in real time.
      let chunk = AVAudioFrameCount(max(0, Date().timeIntervalSince(begun) * rate - fed))
      guard chunk > 0, let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk) else { return }
      fed += Double(chunk)
      if (try? file.read(into: buffer, frameCount: chunk)) == nil || buffer.frameLength == 0 {
        // Past the end: silence, so the track keeps time like a quiet call.
        buffer.frameLength = chunk
        if let data = buffer.floatChannelData { for c in 0..<Int(buffer.format.channelCount) { memset(data[c], 0, Int(chunk) * 4) } }
      }
      track.append(buffer)
    }
    timer.resume()
    sourceStops.append { timer.cancel() }
  }

  func stop() {
    if stopping { return }
    stopping = true
    emit(["type": "state", "state": "finishing"])
    sourceStops.forEach { $0() }
    sourceStops = []
    you.stop()
    others.stop()
    if transcriber.pending == 0 { return Recorder.finish() }
    transcriber.onIdle = { Recorder.finish() }
    // Last resort: a decode that never returns must not keep the note open.
    DispatchQueue.main.asyncAfter(deadline: .now() + drainSeconds) { Recorder.finish() }
  }

  static func finish() {
    emit(["type": "done"])
    _exit(0)
  }
}

func microphoneAllowed(_ then: @escaping (Bool) -> Void) {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: then(true)
  case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { then(ok) } }
  default: then(false)
  }
}

emit(["type": "state", "state": "starting"])

guard let model = modelPath, FileManager.default.fileExists(atPath: model) else {
  fail("model-missing", "The speech model is not on this Mac yet. Turn Call notes off and on in Settings to download it.")
}
let loadStart = Date()
guard let transcriber = Transcriber(model: model) else {
  fail("model-unreadable", "The speech model could not be loaded. Turn Call notes off and on in Settings to download it again.")
}
trace("model loaded in \(String(format: "%.1f", Date().timeIntervalSince(loadStart))) s")
let recorder = Recorder(transcriber: transcriber)

if !useMic || youFile != nil {
  recorder.start(mic: false)
} else {
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
