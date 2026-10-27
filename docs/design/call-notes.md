# Call notes (desktop app only)

Status: 2026-10-21. **Built (beta, desktop):**
- call detection, the "Call detected" prompt, and Settings → Call notes (off by default);
- **macOS:** "Take notes" records and transcribes on the device with Whisper
  (whisper.cpp, the `small` model), writes a call note as it goes, and stops on
  Stop or when the call ends;
- "You" lines that are the call's own audio heard through the speakers are dropped;
- **Call notes** in the sidebar's Sessions list, grouped by day, plus a note view
  (rename, delete, "Ask about this call");
- agent tools `search_call_notes` and `read_call_note`;
- call summaries with source-linked decisions and actions, ownership review and editable deadlines;
- Overview / Transcript tabs, local transcript search, speaker filters and source navigation;
- unfinished actions on Home across all saved calls; only highlights use a 14-day window.

Summaries use the configured chat model, whose endpoint receives transcript text.
The note shows its processing provider separately from local transcription and
storage. Long transcripts are summarized in overlapping sections without dropping
the middle. Regeneration reconciles actions with saved completion, dismissal,
ownership and deadline overrides, including edits made during generation.
Short captures remain accessible in a collapsed sidebar group; nothing is deleted
by grouping.

**Not built:**
- Windows recording and transcription (whisper.cpp); Windows only detects;
- embedding notes into the on-device index (search is by words, not meaning);
- matching a call to its calendar meeting.

See "Results: recording" for what was tested.

Code:
- `apps/desktop/native/wgpt-calls.swift`: the macOS helper. Every second it
  prints the processes holding mic + output.
- `apps/desktop/sidecar/host/callDetection.ts`: the rule (`CallTracker`), the
  Windows registry reader, and the page and notification events. It starts and
  stops the recorder.
- `apps/desktop/native/wgpt-notes.swift`: the macOS recorder. It taps the call's
  processes and the mic, transcribes both with whisper.cpp, and prints segments.
  It links `libwhisper.dylib`: whisper.cpp v1.9.2's prebuilt Apple framework,
  pinned with its SHA-256 in `scripts/build-native.mjs` and flattened to one dylib.
- `apps/desktop/sidecar/host/whisperModel.ts`: downloads the model the first time
  call notes are turned on, from a pinned revision, and checks its SHA-256.
- `apps/desktop/sidecar/host/callRecorder.ts`: runs the recorder and writes its
  segments into the call note.
- `apps/vscode-extensions/src/services/callNotes.ts`: the note format, shared
  by the recorder, the Sessions list and the agent tools.
- The Sessions list: `src/sessionsViewProvider.ts` and
  `src/templates/SessionsHtmlTemplate.ts`.
- The webview: `hooks/useCallDetection.ts`, `components/CallIndicator.tsx`,
  `components/CallNoteView.tsx` and `components/settings/CallNotesSettings.tsx`.

## What it does

When call notes are turned on, the desktop app notices that the user is in a
call, in any app (Teams, Zoom, Meet, a desktop app, a web app or a browser tab),
and **asks** whether to take notes. If the user says yes, it
records the call, transcribes it on the device, and adds the transcript to a new
**Meetings** Knowledge source. The agent can then answer questions such as
"what did we decide about the retry cap in Tuesday's call?" and cite the call.

It fits the north star on both counts. Meetings are org knowledge, and the
audio, transcription and index never leave the machine.

**Desktop only.** Capture and transcription need native helpers, and the VS
Code extension never offers this. The settings are gated on `isDesktopHost()`,
and the native pieces live in `apps/desktop` (`native/` and `src-tauri/`), not in
extension code. This follows the rule that desktop must not fork extension code.

## Non-negotiables

- **Nothing records without the user's choice.** By default, detecting a call
  only triggers a prompt; if it is dismissed or ignored, nothing is recorded.
  Settings → Call notes → **Take notes automatically** (off by default, shown
  only where recording works) is the user choosing in advance: a detected call
  then records without the prompt, once per call, and a notification says so
  ("Taking notes of this call") when the window isn't in front. Stop still
  ends it, and it does not restart that call.
- **Say "taking notes", not "recording".** Only text is kept; the audio is
  transcribed in memory and never saved. The UI, notifications, errors and the
  agent's tool descriptions say "taking notes" or "transcript". (macOS's own
  permission is named "System Audio Recording"; that name is Apple's.)
- **It is always visible while recording.** An indicator with Stop shows the
  whole time, and recording stops by itself when the call ends.
- **Other participants are reminded.** The prompt reminds the user to tell
  participants, and offers a one-click copy of a short line for the meeting
  chat. The user's click is their own consent, not the other participants'.
  Laws differ: several US states require all-party consent, and under GDPR a
  voice is personal data. Employer and client policies also apply.
- **It stays on the device.** Audio is deleted after transcription unless the
  user chooses to keep it. Transcripts can be deleted call by call. Summarization sends transcript text
  to the configured model endpoint; a local model keeps this processing on-device. Analytics carry no content: only events like
  `call_notes_started` and `call_notes_stopped` with a duration.

## First-use introduction

After desktop setup (and sign-in in Remote mode), supported builds show a
one-time “Enable Call notes?” message. Enable turns on detection with per-call
confirmation, starts the speech-model download, and leaves automatic note-taking
off. “Not now” dismisses the introduction; the choice is persisted on this
installation, with the feature still available in Settings → Call notes.
Already-enabled and unsupported installations do not show the introduction.

## Flow

1. **Detect.** A cheap poll every few seconds checks whether any app holds both
   the microphone and audio output (see "Detection"). The signal must hold for
   about 10 s before anything happens, so a mic test doesn't trigger it. Only
   one prompt is shown per call. A new call's prompt goes in front of the
   last call's "Call notes saved" card, so back-to-back meetings are still
   asked about.
2. **Prompt.** A native notification says "Call detected. Click to take
   notes." It never names the app, so the wording is the same whether the
   call is in Teams, Zoom or a browser tab. It reuses the `notify.rs` path, which has no action buttons today.
   Clicking it opens an in-app card with three choices:
   - **Record & transcribe**
   - **Not this call**
   - **Never for this meeting**: this needs the Outlook Calendar source to
     identify a recurring meeting; without it, the choice becomes "don't ask
     again today".
3. **Record.** Capture starts on two separate tracks: the microphone ("You")
   and the call app's own audio output ("Others"). The indicator and Stop are shown.
4. **End.** Recording stops when the detection signal drops for about 8 s (macOS checks every second),
   or when the user clicks Stop.
5. **Transcribe.** Transcription runs on the device, chunk by chunk during the
   call or all at once after it. Speaker labels come from the two tracks
   ("You" / "Others"). Telling individual people apart is out of scope for v1.
6. **Store.** The transcript, a short summary, and metadata (start, duration,
   and title and attendees when the calendar can match the meeting) are saved
   and embedded into the on-device index as the Meetings source.

## Detection

The goal is one consistent "in a call: yes/no" for any call app. It must work
muted and with the camera off, need no permission prompt, and need no
approval from Microsoft, Zoom or anyone else. The app is deliberately **not**
identified: a call in a browser tab only shows as the browser, so naming the
app could never be consistent.

**The rule:** a call is **one process holding both audio input (the mic) and
audio output for 10 s or more**, excluding a short ignore list.
- **Muted calls are covered.** Call apps keep the mic open while muted, which
  is how they can warn "You're muted". This was confirmed on macOS for the
  Teams web app.
- **Requiring input and output in the same process** keeps out a voice memo
  (input only) and music (output only), even when both run at the same time.
- **The ignore list** covers system listeners and our own helper: macOS's
  "Hey Siri" listener (`corespeechd`, which holds input at times) and
  WorkspaceGPT's dictation helper (`wgpt-dictate`).
- **A wrong guess is cheap.** A false positive, such as a voice chat in a
  game, costs one dismissed prompt, because nothing records without a click.

**macOS.** Core Audio's per-process state (macOS 14 and later) reports, for
each process, whether it is running input and whether it is running output.
No permission is needed. The check goes in a small Swift helper next to
`wgpt-dictate`.

**Windows.** For the mic, Windows records which app is using the microphone;
this record drives the taskbar mic icon. It lives in the user's own registry,
readable without admin rights:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone
```

- Packaged apps, such as new Teams, are direct subkeys of that key.
- Desktop apps (`zoom.exe`, `chrome.exe` and so on) are under `NonPackaged`.
- An app is using the mic while its `LastUsedTimeStop` is 0.

For output, enumerating WASAPI audio sessions per process says whether the
same process is playing audio. That needs native code, which the Windows
capture helper has anyway. The PowerShell probe can only check the mic.

**Rejected:**
- Reading window titles: macOS requires Screen Recording permission.
- Parsing a call app's private log files: undocumented and fragile.
- Teams' local third-party API: Teams-only, and the user must enable it and
  pair it.
- Graph presence: Teams-only, and needs Microsoft app approval, which
  locked-down tenants won't give.
- Naming the app through our Chrome extension: it would only work where the
  extension is installed, which would make the rule inconsistent.

## Capture

| | Microphone ("You") | Call app output ("Others") |
|---|---|---|
| **macOS** | AVAudioEngine input. Uses the microphone permission, which dictation already prompts for. | Core Audio process tap on the detected process (macOS 14.2+). Needs a one-time "System Audio Recording" permission (`NSAudioCaptureUsageDescription`). |
| **Windows** | WASAPI capture. Subject to the Windows mic privacy toggle for desktop apps. | WASAPI process loopback for the detected process (Windows 10 2004+). No prompt. |

When the call is in a browser, the detected process is the browser's audio
helper, so a video playing in another tab during the call would be captured
too. That is acceptable for v1, and the transcript makes it obvious.

Both tracks are written as 16 kHz mono WAV chunks into the app's data folder,
and each chunk is deleted once it has been transcribed.

## Transcription

**Update, 2026-10-21: macOS uses Whisper too.** Apple's recognizer was tried
first, as planned below, and was poor on a real call: many words were wrong, on
Indian English and Hinglish especially. Both platforms now use whisper.cpp.
- **Model:** multilingual `small`, 5-bit quantized
  (`ggml-small-q5_1.bin`, 190 MB). It is downloaded once into `<app data>/models`.
- **Language:** `en`, with a prompt written in Romanized Hinglish.
- **How it runs:** audio stays in memory, never on disk. Each track is cut into
  chunks of 8–28 s at pauses, and a chunk with less than 0.5 s of speech is never
  transcribed, because Whisper invents words in silence.
- **Speed:** on an M4 Pro, a 10 s chunk decodes in about 0.3 s on the GPU.
- **Permissions:** Speech Recognition is no longer needed.

The original plan follows.

**macOS: Apple's on-device recognizer.** This is the same family as dictation.
On macOS 26 and later, use `SpeechAnalyzer` / `SpeechTranscriber`, which are
built for long-form audio. On older macOS, use `SFSpeechRecognizer` with
`requiresOnDeviceRecognition = true`, fed in chunks. The locale is `en-IN`
when the device supports it on-device; otherwise `en-US`. Hinglish words come
out as their nearest English rendering. That is acceptable, since meetings
are mostly English.

**Windows: Whisper through whisper.cpp.** whisper.cpp is MIT-licensed and has
prebuilt Windows binaries that run on the CPU, with optional GPU. It runs as a
helper process.
- **Default model:** multilingual `small`, quantized (about 180 MB). Not the
  `.en` variant, because of Hinglish.
- **Light tier:** `base` (about 60 MB).
- **Best tier:** `large-v3-turbo` (about 550 MB), practical when transcribing
  after the call.
- **Download:** the model is downloaded the first time the feature is turned
  on, and verified against its checksum. It is never bundled; the installer's
  size matters (see the 154 MB pruning).
- **Settings:** language `en`, plus an initial prompt in Romanized Hinglish.
  Together they keep the output in Roman script rather than switching a
  chunk to Devanagari. This needs testing on real meetings.

Alternatives that were weighed and set aside:
- NVIDIA Parakeet: the English model is English-only, and the multilingual
  one covers European languages, not Hindi.
- Moonshine: built for short live phrases.
- Windows' built-in speech recognition: well below Whisper's accuracy.
- Vosk: older and less accurate.

## Meetings as Knowledge

- **Storage:** one Markdown file per call, kept in the app's data folder:
  - front matter: date, duration and, when the calendar matches, the
    meeting's title and attendees;
  - a summary;
  - the transcript with "You:" / "Others:" turns and timestamps.

  This mirrors how Confluence and ADO items are synced to Markdown and then
  embedded.
- **Index:** embedded with the existing on-device embedding worker, under a new
  `MEETINGS` namespace.
- **Settings → Knowledge → Meetings:**
  - turn call notes on or off;
  - pick the Windows model tier;
  - list, open and delete calls;
  - keep audio (off by default).
- **Agent tools:**
  - `search_meetings(query, since)`: semantic search over the index;
  - `get_meeting(id)`: one call's full transcript.

## Validate first

Before building, run the probe on each OS in real calls that are **muted
with the camera off**, at least one each in the Teams app, Zoom, and a browser:
- **macOS (Swift):** prints every process using audio input or output, and the
  verdict from the rule.
- **Windows (PowerShell):** prints every app holding the mic, and the verdict
  (mic only; see "Detection").

If the verdict says "CALL" for the whole muted call in every app, build on
the rule.

The probes are in `apps/desktop/native/probes/`:

```bash
swift apps/desktop/native/probes/call-probe.swift
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\native\probes\call-probe.ps1
```

Each prints every app holding the mic, not only Teams, so the run also shows
*which* process holds it. New Teams may capture through a helper process (a
WebView helper on Mac, `msedgewebview2.exe` on Windows), and detection must
match that process.

The macOS probe was checked on macOS 27 with no call running. It reported
"no call", and the per-process listing worked: `afplay` appeared while a sound
played. It also showed the "Hey Siri" listener (`corespeechd`) holding input.
That is why detection must match the Teams process and never use "is anyone
using the mic". The Windows probe has not been run; no Windows machine was
available.

### Results: macOS, 2026-10-21

The test was a real call in **Teams installed as a Chrome web app** ("Microsoft
Teams (PWA)", bundle `com.google.Chrome.app.<id>`), with the camera off.

| State | What held audio | Verdict |
|---|---|---|
| No call (Teams desktop and the web app both open) | nothing (Siri's `corespeechd` only, at times) | no call ✅ |
| In call, unmuted | `Google Chrome Helper (Aperitif)` IN+OUT | call ✅ |
| **In call, muted** | `Google Chrome Helper (Aperitif)` IN+OUT, the whole time | **call ✅** |

What this shows:
- **Muted calls are detectable.** The browser keeps the mic open while the
  user is muted.
- **A web-app or browser call runs its audio in the browser's helper
  process,** not in a Teams process. Matching only Teams processes misses it.
- **Siri's listener (`corespeechd`) holds input at times,** so "is anyone
  using the mic" is never a valid test.

Following this, the rule was made app-agnostic: one process holding input
and output for 10 s or more (see "Detection"). The probe now implements it
and was renamed `call-probe`.

Still to test:
- the **Teams desktop app** and **Zoom** in a muted call, to confirm each
  keeps input and output open in one process;
- the **Windows** probe.

## Effort (rough)

| Piece | Estimate |
|---|---|
| Detection helpers and the prompt flow | 3 days |
| Capture on macOS (mic and process tap) | 3 days |
| Capture on Windows (mic and process loopback) | 3 days |
| Transcription on macOS (Speech) | 2 days |
| Transcription on Windows (whisper.cpp helper and model download) | 3 days |
| Meetings Knowledge source, tools and settings | 3 days |

That is about three weeks for v1, after the probes pass.

## Open questions

- Should the summary use the user's selected model? That sends transcript
  text to the model like any tool result. The alternative is to summarize
  only on demand when the agent reads a meeting.
- Should "Never for this meeting" exist without the Outlook Calendar source,
  or fall back to "don't ask again today"?
- What retention default should transcripts have (keep forever, or 90 days)?

## Results: recording, macOS, 2026-10-21

**How it was run.** The test used the real desktop sidecar (headless) and its
real UI in a browser.
- A stand-in for `wgpt-calls` reported an `afplay` process playing a spoken
  meeting as the call.
- The real `wgpt-notes` ran inside a small test app bundle. A process started
  from a terminal can't get Speech Recognition, so it was run that way.

**What worked:**
- "Take notes" started recording.
- The sidebar showed the call as "Recording" within seconds.
- The note view filled in live.
- Both ways of ending a recording worked:
  - when the call ended, it stopped by itself and the note was finalized
    ("19:04 – 19:05 · 1m");
  - Stop in the note view finished it at once.
- Rename, delete, day grouping (Today / Yesterday / a date) and "Ask about this
  call" all worked.

**The tap.** The process tap heard only the tapped process: the clip played by
the tapped `afplay`. When that process ended, its track went quiet, as intended.
The en-IN on-device model transcribed it well, with "jira" in lower case.

**Not tested yet:**
- the mic ("You") track, which uses the same code as dictation;
- a real Teams or Zoom call, end to end;
- the installable build;
- Windows recording, which isn't built.

**Permissions.** The first time, macOS asks for Speech Recognition, the
Microphone and System Audio Recording, all under WorkspaceGPT. Until System Audio
Recording is allowed, the tap delivers silence rather than failing.

**Known limits:**
- **Speakers, not headphones:** the mic also hears the other side, so their
  words can appear under "You" too.
- **The tap follows the processes seen at the start.** If a call app moves its
  audio to a new process mid-call, the "Others" track goes quiet.

## Results: Whisper, macOS, 2026-10-21

- **Real call, Apple recognizer:** the user's call in the Teams web app, before
  the switch. Many words were wrong, some lines were doubled (since fixed), and
  some of the other side's words appeared as "You". That last part was most
  likely the mic hearing the speakers.
- **Whisper on a spoken test meeting:** Indian English voice, with Hinglish lines.
  - Every line was right, with Hindi kept in Roman script: "haan, theek hai,
    matlab … kal tak build chaahiye, warna Thursday ka … miss ho jayega";
    "Arjun, kya status hai?"; "chalo".
  - Silent stretches were skipped and nothing was invented.
- **In the desktop sidecar:** turning call notes on downloaded the model through
  the app, with progress in Settings and the checksum passing. A pretend call was
  then transcribed live into the note.
- **Echoes:** dropping is covered by unit tests only.
- **Not tested yet:** a real Teams or Zoom call with Whisper, and the installable
  build. Packaging now carries `libwhisper.dylib`, which is ad-hoc signed like the
  other helpers.
